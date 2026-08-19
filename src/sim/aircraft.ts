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

/**
 * 軌跡の履歴の長さ。
 *
 * 4 フレームごとに記録して 384 本。1/120 秒刻みなので 12.8 秒ぶん。
 * 300 m/s で飛べば 3.8 km 後ろまで残る。
 *
 * 画面に映るのは実測で 1 秒ぶん（約 270 m）しかない。追従カメラが機体の
 * すぐ後ろにいるので、それより古い点は視錐台の外へ出る。長さに余裕を
 * 持たせるのは、軌跡が途中で終わる原因を「履歴の尽き」ではなく
 * 「画面の縁」に固定するため。
 */
export const TRAIL_LENGTH = 384

/** 何フレームごとに記録するか */
export const TRAIL_STRIDE = 4

/**
 * 軌跡の 1 点。
 *
 * 描画がコントレイルと翼端渦のリボンを作るのに使う。**履歴は sim が持つ。**
 * 描画側にリングバッファを置くと、キャプチャモードは sync が 1 回しか
 * 走らないので何も出ない。履歴は sim の状態なので、リプレイにも後の Phase の
 * AI にも使える。
 */
export interface TrailPoint {
  readonly position: Vec3
  /** 機体右方向の単位ベクトル。翼端の位置を出すのに使う */
  readonly right: Vec3
  /** 機体上方向の単位ベクトル。リボンの向きに使う */
  readonly up: Vec3
  /** 荷重倍数。描画側で使う予備。渦の濃さには使わない */
  readonly loadFactor: number
  /**
   * 揚力係数。翼端渦の濃さを決める。
   *
   * 渦の芯の圧力低下は循環の二乗に比例し、循環は揚力係数と弦長と速度の積で
   * 決まる。同じ荷重倍数でも、速い高度の低い引き起こしより、遅い旋回の
   * ほうが揚力係数が高く、渦がよく出る。実機の映像もそうなっている。
   */
  readonly liftCoefficient: number
  /** 実効スロットル。コントレイルの濃さを決める */
  readonly throttle: number
  /** 海抜 m。コントレイルが出る気温の判定に使う */
  readonly altitude: number
}

/** 履歴を読む側が要る最小限。描画は Aircraft の型に縛られない */
export interface TrailSource {
  /** 記録済みの点の数。TRAIL_LENGTH で頭打ち */
  readonly trailLength: number
  /** 新しい順に i 番目。0 が最新 */
  trailPoint(index: number): TrailPoint
}

interface MutableTrailPoint {
  position: Vec3
  right: Vec3
  up: Vec3
  loadFactor: number
  liftCoefficient: number
  throttle: number
  altitude: number
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
  /** 舵面の位置 −1..1。描画が舵を切るのに使う */
  elevator: number
  aileron: number
  rudder: number
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

  /**
   * 舵面の位置 −1..1。指令へ一次遅れで追従する。
   *
   * 描画が使う。描画側で入力を読むとキャプチャモードで再現しない（sync が
   * 1 回しか走らないため）。sim の状態として持つ。
   */
  elevator = 0
  aileron = 0
  rudder = 0

  // 描画補間用に前ステップの姿勢を持つ
  private readonly prevPosition = new Vec3()
  private readonly prevOrientation = new Quat()

  /** 軌跡の履歴。使い回すので new は最初の 1 回だけ */
  private readonly trail: MutableTrailPoint[] = Array.from(
    { length: TRAIL_LENGTH },
    () => ({
      position: new Vec3(),
      right: new Vec3(),
      up: new Vec3(),
      loadFactor: 1,
      liftCoefficient: 0,
      throttle: 0,
      altitude: 0,
    }),
  )
  /** 記録した通し番号。リングの位置と本数を出すのに使う */
  private trailWritten = 0
  /** ステップの通し番号。TRAIL_STRIDE ごとに記録する */
  private stepIndex = 0

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

    // 舵面の位置。指令をそのまま見せると入力の瞬間に跳ねるので遅らせる。
    // 制限器を通したあとのピッチ指令を使う。制限が効いているときに舵面が
    // 動いたままだと、見えているものと挙動が食い違う
    const surfaceLag = lagFactor(dt, AIRCRAFT.surfaceTau)
    this.elevator += (pitchCommand - this.elevator) * surfaceLag
    this.aileron += (clamp(input.roll, -1, 1) - this.aileron) * surfaceLag
    this.rudder += (clamp(input.yaw, -1, 1) - this.rudder) * surfaceLag

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

    // 軌跡の記録。派生値を更新したあとに置く。荷重倍数と海抜が要るため
    if (this.stepIndex % TRAIL_STRIDE === 0) this.recordTrail(tmpUp, tmpRight)
    this.stepIndex++
  }

  /**
   * 描画用に前ステップと現ステップを補間した状態を書き込む。
   *
   * @param alpha 0 が前ステップ、1 が現ステップ
   */
  /**
   * 軌跡を 1 点記録する。
   *
   * 呼ぶのは TRAIL_STRIDE ステップごと。1/120 秒ごとに残すと 384 本でも
   * 3.2 秒ぶんしか持てない。
   */
  private recordTrail(up: Vec3, right: Vec3): void {
    const slot = this.trail[this.trailWritten % TRAIL_LENGTH]!
    slot.position.copy(this.position)
    slot.right.copy(right)
    slot.up.copy(up)
    slot.loadFactor = this.loadFactor
    slot.liftCoefficient = liftCoefficient(this.angleOfAttack)
    slot.throttle = this.throttle
    slot.altitude = this.altitude
    this.trailWritten++
  }

  /** 記録済みの点の数。TRAIL_LENGTH で頭打ち */
  get trailLength(): number {
    return Math.min(this.trailWritten, TRAIL_LENGTH)
  }

  /**
   * 新しい順に index 番目の点。0 が最新。
   *
   * 返すのは内部の器そのもの。保持せずその場で使う。毎フレーム 256 本を
   * 写すのは無駄なので、読む側の作法として決めておく。
   */
  trailPoint(index: number): TrailPoint {
    const length = this.trailLength
    const clamped = index < 0 ? 0 : index >= length ? length - 1 : index
    const slot = (this.trailWritten - 1 - clamped + TRAIL_LENGTH * 2) % TRAIL_LENGTH
    return this.trail[slot]!
  }

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
    out.elevator = this.elevator
    out.aileron = this.aileron
    out.rudder = this.rudder
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
    elevator: 0,
    aileron: 0,
    rudder: 0,
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
