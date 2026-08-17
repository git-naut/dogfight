import { Vec3 } from './vec3'
import { Quat } from './quat'
import { GRAVITY, airDensity, dynamicPressure } from './isa'
import {
  AIRCRAFT,
  angleOfAttack,
  applyAoaLimiter,
  availableThrust,
  bankAngle,
  clamp,
  controlAuthority,
  dragCoefficient,
  dragMagnitude,
  gLimitedPitchRate,
  lagFactor,
  liftCoefficient,
  liftDirection,
  liftMagnitude,
  sideslipAngle,
} from './flightModel'
import type { InputState } from './input'

/**
 * 機体の状態と1ステップの積分。
 *
 * 積分は semi-implicit Euler（速度を先に更新してから位置に使う）。
 * 素の Euler よりエネルギーの発散が少なく、実装も1行しか変わらない。
 *
 * 姿勢の積分だけは軸角の指数写像で厳密に合成する。角速度が大きいフレームでも
 * クォータニオンが伸び縮みしない。
 */

export interface AircraftInit {
  position?: Vec3
  velocity?: Vec3
  orientation?: Quat
  /** 実効スロットル 0..1 */
  throttle?: number
}

export interface StepOptions {
  /**
   * 迎角制限器（フライバイワイヤ相当）。既定は有効。
   * 失速の挙動を検証するときだけ切る。
   */
  aoaLimiter?: boolean
  /**
   * 地形。渡さなければ高度 0 の水平面（外洋）として扱う。
   *
   * 描画と同じ高さ場を引く。GLSL と TypeScript に同じ式を二重に書くと、
   * いつか片方だけ直して「見えている山と当たる山がずれる」ので、
   * ここは sim 側の Terrain を正本にする。
   */
  terrain?: TerrainSampler
}

/**
 * 地形の高さを引くもの。
 *
 * Terrain そのものを要求せず必要な形だけ受け取る。テストから平坦や斜面を
 * 差し込めるし、sim が描画側の型に縛られない。
 */
export interface TerrainSampler {
  heightAt(x: number, z: number): number
}

/** 描画とデバッグ表示に渡す読み取り用の状態。 */
export interface AircraftSample {
  position: Vec3
  orientation: Quat
  speed: number
  altitude: number
  angleOfAttack: number
  sideslip: number
  bank: number
  loadFactor: number
  throttle: number
  stalled: boolean
  crashed: boolean
  /** 真下の地形の高さ m。海上なら 0 */
  groundHeight: number
  /**
   * 対地高度 m。
   *
   * altitude は海抜のまま残す。空気密度を海抜から引いているので、意味を
   * 変えると飛行モデルが狂う。低空飛行では読みたいのはこちらのほう。
   */
  agl: number
}

// 毎ステップの一時変数。使い回してゴミを出さない。
const tmpForward = new Vec3()
const tmpUp = new Vec3()
const tmpRight = new Vec3()
const tmpVelDir = new Vec3()
const tmpForce = new Vec3()
const tmpAero = new Vec3()
const tmpLiftDir = new Vec3()
const tmpBodyVel = new Vec3()
const tmpRates = new Vec3()
const tmpQuat = new Quat()

export class Aircraft {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()
  /** body 座標系の角速度 rad/s */
  readonly angularVelocity = new Vec3()

  /** 実効スロットル。入力の目標値とは別に、時定数をかけて追従する */
  throttle = 0.5

  crashed = false

  // 派生値。ステップの末尾で更新し、次のステップの制御と表示に使う
  speed = 0
  altitude = 0
  /** 真下の地形の高さ m。海上なら 0 */
  groundHeight = 0
  /** 対地高度 m */
  agl = 0
  angleOfAttack = 0
  sideslip = 0
  bank = 0
  loadFactor = 1
  stalled = false

  // 描画補間用に前ステップの姿勢を持つ
  private readonly prevPosition = new Vec3()
  private readonly prevOrientation = new Quat()

  constructor(init: AircraftInit = {}) {
    if (init.position) this.position.copy(init.position)
    if (init.velocity) this.velocity.copy(init.velocity)
    if (init.orientation) this.orientation.copy(init.orientation).normalize()
    if (init.throttle !== undefined) this.throttle = clamp(init.throttle, 0, 1)

    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)
    this.updateDerived()
  }

  step(input: InputState, dt: number, options: StepOptions = {}): void {
    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)

    if (this.crashed) return

    const useLimiter = options.aoaLimiter !== false

    this.orientation.forward(tmpForward)
    this.orientation.up(tmpUp)
    this.orientation.right(tmpRight)

    const density = airDensity(this.altitude)
    const q = dynamicPressure(density, this.speed)

    // 1. 指令角速度。舵の効き、G 制限、迎角制限をここで掛ける
    const authority = controlAuthority(q)

    let pitchCommand = clamp(input.pitch, -1, 1)
    if (useLimiter) pitchCommand = applyAoaLimiter(pitchCommand, this.angleOfAttack)

    const pitchCap = Math.min(AIRCRAFT.maxPitchRate, gLimitedPitchRate(this.speed))
    const targetPitch = pitchCommand * pitchCap * authority
    const targetRoll = clamp(input.roll, -1, 1) * AIRCRAFT.maxRollRate * authority
    const pilotYaw = clamp(input.yaw, -1, 1) * AIRCRAFT.maxYawRate * authority

    // 2. 風見安定。横滑り角に比例したヨーで機首を経路へ戻す。
    //    垂直尾翼が実際にやっていること。協調旋回はこの機構から出てくる。
    const weathervaneYaw = this.speed > 1 ? AIRCRAFT.weathervaneGain * this.sideslip : 0
    const targetYaw = pilotYaw + weathervaneYaw

    // 3. 指令へ一次遅れで追従。軸ごとに時定数が違う
    setBodyRates(tmpRates, targetPitch, targetRoll, targetYaw)
    this.angularVelocity.x +=
      (tmpRates.x - this.angularVelocity.x) * lagFactor(dt, AIRCRAFT.pitchTau)
    this.angularVelocity.y +=
      (tmpRates.y - this.angularVelocity.y) * lagFactor(dt, AIRCRAFT.yawTau)
    this.angularVelocity.z +=
      (tmpRates.z - this.angularVelocity.z) * lagFactor(dt, AIRCRAFT.rollTau)

    // 4. 姿勢を積分して body 軸を取り直す
    this.orientation.integrateBodyRate(this.angularVelocity, dt, tmpQuat)
    this.orientation.forward(tmpForward)
    this.orientation.up(tmpUp)
    this.orientation.right(tmpRight)

    // 5. スロットルの追従
    const targetThrottle = clamp(input.throttle, 0, 1)
    this.throttle += (targetThrottle - this.throttle) * lagFactor(dt, AIRCRAFT.throttleTau)

    // 6. 力を合算する。tmpAero には重力以外を入れて荷重倍数の計算に使う
    tmpAero.set(0, 0, 0)
    tmpAero.addScaledVector(tmpForward, availableThrust(this.throttle, density))

    const speed = this.speed
    if (speed > 0.1) {
      tmpVelDir.copy(this.velocity).multiplyScalar(1 / speed)
      const alpha = angleOfAttack(tmpVelDir, tmpUp)
      const cl = liftCoefficient(alpha)

      liftDirection(tmpVelDir, tmpUp, tmpLiftDir)
      tmpAero.addScaledVector(tmpLiftDir, liftMagnitude(q, cl))
      tmpAero.addScaledVector(tmpVelDir, -dragMagnitude(q, dragCoefficient(cl)))
    }

    tmpForce.copy(tmpAero)
    tmpForce.y -= AIRCRAFT.mass * GRAVITY

    // 7. 速度を更新（semi-implicit Euler なので位置より先）
    this.velocity.addScaledVector(tmpForce, dt / AIRCRAFT.mass)

    // 8. 横滑りの減衰。機体座標系の横方向成分だけを抜く。
    //    上下成分は迎角そのものなので触らない。ここを丸ごと寄せると揚力が消える。
    this.orientation.rotateInverse(this.velocity, tmpBodyVel)
    tmpBodyVel.x -= tmpBodyVel.x * lagFactor(dt, AIRCRAFT.sideslipTau)
    this.orientation.rotate(tmpBodyVel, this.velocity)

    // 9. 位置と地形
    this.position.addScaledVector(this.velocity, dt)
    // 地形を渡されていなければ海面（高度 0）。外洋はそれで正しい
    const ground = options.terrain
      ? options.terrain.heightAt(this.position.x, this.position.z)
      : 0
    // 海面より低い地形（海底）に当たっても意味がないので、海面で止める
    const floor = ground > 0 ? ground : 0
    if (this.position.y <= floor) {
      this.position.y = floor
      this.velocity.set(0, 0, 0)
      this.angularVelocity.set(0, 0, 0)
      this.crashed = true
    }

    this.updateDerived(tmpAero, floor)
  }

  /**
   * 描画用に前ステップと現ステップを補間した状態を書き込む。
   *
   * @param alpha 0 が前ステップ、1 が現ステップ
   */
  sample(alpha: number, out: AircraftSample): AircraftSample {
    out.position.copy(this.prevPosition).lerp(this.position, alpha)
    out.orientation.copy(this.prevOrientation).slerp(this.orientation, alpha)
    out.speed = this.speed
    out.altitude = this.altitude
    out.angleOfAttack = this.angleOfAttack
    out.sideslip = this.sideslip
    out.bank = this.bank
    out.loadFactor = this.loadFactor
    out.throttle = this.throttle
    out.stalled = this.stalled
    out.crashed = this.crashed
    out.groundHeight = this.groundHeight
    out.agl = this.agl
    return out
  }

  /** 制御と表示に使う派生値を state から計算し直す。 */
  private updateDerived(aeroForce?: Vec3, groundHeight = this.groundHeight): void {
    this.speed = this.velocity.length()
    this.altitude = this.position.y
    this.groundHeight = groundHeight
    this.agl = this.position.y - groundHeight

    this.orientation.up(tmpUp)
    this.orientation.right(tmpRight)
    this.bank = bankAngle(tmpUp, tmpRight)

    if (this.speed > 0.1) {
      tmpVelDir.copy(this.velocity).multiplyScalar(1 / this.speed)
      this.angleOfAttack = angleOfAttack(tmpVelDir, tmpUp)
      this.sideslip = sideslipAngle(tmpVelDir, tmpRight)
    } else {
      this.angleOfAttack = 0
      this.sideslip = 0
    }

    this.stalled = Math.abs(this.angleOfAttack) > AIRCRAFT.stallAngle

    // 荷重倍数は重力を除いた力（加速度計が読む値）を g で割ったもの。
    // 水平定常飛行では揚力だけが残り 1G になる。
    this.loadFactor = aeroForce
      ? aeroForce.length() / (AIRCRAFT.mass * GRAVITY)
      : this.loadFactor
  }
}

export function createAircraftSample(): AircraftSample {
  return {
    position: new Vec3(),
    orientation: new Quat(),
    speed: 0,
    altitude: 0,
    angleOfAttack: 0,
    sideslip: 0,
    bank: 0,
    loadFactor: 1,
    throttle: 0,
    stalled: false,
    crashed: false,
    groundHeight: 0,
    agl: 0,
  }
}

/**
 * 直感的な指令（機首上げ・右ロール・右ヨーを正）を body 座標系の
 * 角速度ベクトルへ写す。
 *
 * 座標系は右手系で機首が -Z なので、素直に書くと符号が食い違う。
 * 機首上げは +X まわりの正回転、右ロールは -Z まわりの正回転、
 * 右ヨーは +Y まわりの負回転。ここ1か所に閉じ込める。
 */
export function setBodyRates(
  out: Vec3,
  pitchUp: number,
  rollRight: number,
  yawRight: number,
): Vec3 {
  return out.set(pitchUp, -yawRight, -rollRight)
}
