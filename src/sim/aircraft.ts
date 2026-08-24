import { Vec3 } from './vec3'
import { Quat } from './quat'
import { GRAVITY, airDensity, dynamicPressure, speedOfSound } from './isa'
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
import { TrailRing, type TrailSource } from './trail'

/**
 * 機体の状態と1ステップの積分。
 *
 * 積分は semi-implicit Euler（速度を先に更新してから位置に使う）。
 * 素の Euler よりエネルギーの発散が少なく、実装も1行しか変わらない。
 *
 * 姿勢の積分だけは軸角の指数写像で厳密に合成する。角速度が大きいフレームでも
 * クォータニオンが伸び縮みしない。
 */

/**
 * 機体の耐久。20mm 弾 1 発を 1 とする。
 *
 * 敵機と同じ値。**実弾で何発当てれば落ちるかの公表値はない。**戦闘機に対する
 * 20mm HEI の必要弾数は資料でも幅がある。ここは手触りの値。
 */
export const AIRCRAFT_INTEGRITY = 60

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
  /**
   * 舵の効きに掛ける係数 0..1。既定は 1。
   *
   * ダメージで操縦が鈍るのを表す。`controlAuthority` の結果へそのまま掛ける。
   * **飛行モデルの側に「ダメージ」という概念は持たせない。**効きが落ちる
   * 理由は呼び出し側が決める。
   */
  controlFactor?: number
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
 * 4 フレームごとに記録して 768 本。1/120 秒刻みなので 25.6 秒ぶん。
 * 340 m/s で飛べば 8.7 km 後ろまで残る。
 *
 * 引き起こしを続ける構図では画面に映るのは 1 秒ぶんしかない（視錐台が
 * 先に切る）。効くのは**機動が終わったあと**で、そのときに置いてきた
 * 濃い区間が後方へ遠ざかっていくのが見える。急上昇や急旋回のあとに
 * 軌跡が短く見えたのはここが足りていなかった。
 */
export const TRAIL_LENGTH = 768

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
  /** 翼端の水蒸気。翼端渦の濃さを決める。詳細は `Aircraft.wingtipVapor` */
  readonly wingtipVapor: number
  /** 実効スロットル。コントレイルの濃さを決める */
  readonly throttle: number
  /** 海抜 m。コントレイルが出る気温の判定に使う */
  readonly altitude: number
}

/**
 * 描画が読む機体の履歴。
 *
 * リングの仕組みそのものは `TrailRing` が持つ。ミサイルの煙も同じリングを
 * 使うので、機体固有の点の型だけをここで固定する。
 */
export type AircraftTrailSource = TrailSource<TrailPoint>

interface MutableTrailPoint {
  position: Vec3
  right: Vec3
  up: Vec3
  loadFactor: number
  wingtipVapor: number
  throttle: number
  altitude: number
}

/** 描画とデバッグ表示に渡す読み取り用の状態。 */
export interface AircraftSample {
  position: Vec3
  orientation: Quat
  /**
   * 速度ベクトル m/s。
   *
   * HUD のフライトパスマーカー（機体が実際に向かっている先）に使う。
   * 機首の向きとは迎角と横滑りのぶんだけずれるので、`orientation` から
   * 導けない。補間はしない。速度は姿勢より緩やかに変わるので、1 ステップの
   * ずれは絵に出ない。
   */
  velocity: Vec3
  speed: number
  altitude: number
  angleOfAttack: number
  sideslip: number
  bank: number
  loadFactor: number
  /** 翼端の水蒸気。軌跡の先頭を現在の翼端へ繋ぐのに使う */
  wingtipVapor: number
  throttle: number
  stalled: boolean
  crashed: boolean
  /** 残りの耐久 0..AIRCRAFT_INTEGRITY。HUD が出す */
  integrity: number
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

  /**
   * 残りの耐久。20mm 弾 1 発で 1 減る。
   *
   * **自機も撃たれる。**敵が機銃を撃つようになったので、`Combatant` として
   * 扱えないといけなくなった。値は敵機（`ENEMY_INTEGRITY`）と同じ 60 に
   * そろえてある。手ごたえの調整は決着時間を測ってから。
   */
  integrity = AIRCRAFT_INTEGRITY

  /**
   * 飛んでいるか。`Combatant` の口。
   *
   * 敵 AI が追う相手として自機を渡すのにも要る。墜落した相手は追わない。
   */
  get alive(): boolean {
    return this.integrity > 0 && !this.crashed
  }

  /**
   * ダメージを与える。落ちた瞬間だけ true を返す。
   *
   * 落ちたあとの弾で撃墜数を二重に数えないため、返り値で遷移を見分ける。
   * **耐久が尽きたら墜落と同じ扱いにする。**`crashed` を立てると `step` が
   * 何もしなくなり、機体はその場で止まる。爆発は `Combat` が出す。
   */
  damage(amount: number): boolean {
    if (!this.alive) return false
    this.integrity -= amount
    if (this.integrity <= 0) {
      this.crashed = true
      return true
    }
    return false
  }

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

  /**
   * 翼端の水蒸気 0..。翼端渦の濃さの元になる。
   *
   * 駆動量は マッハ数 × 揚力係数。渦の芯の温度低下を無次元で書くと
   * ΔT/T ∝ γM²Cl²/2 になるので、この積が要る。片方では足りない。
   * 荷重倍数だけで見ると定常旋回（3.0〜3.3 G）を取りこぼし、揚力係数だけで
   * 見ると速い引き起こし（6.86 G・340 m/s で Cl 0.453）を取りこぼす。
   *
   * **立ち上がりは速く、消えるのは遅い。**引くのをやめた瞬間に翼端の
   * 水蒸気が消えると、軌跡は機体の真後ろだけの短い切れ端になる。追従カメラ
   * から見えるのは 0.7 秒ぶんもないので、機動が終わると同時に何も残らない。
   * いったん凝結した水蒸気は渦核が崩れるまで残るので、減衰に時定数を持たせる。
   */
  wingtipVapor = 0

  // 描画補間用に前ステップの姿勢を持つ
  private readonly prevPosition = new Vec3()
  private readonly prevOrientation = new Quat()

  /** 軌跡の履歴。器は最初に作りきって使い回す */
  private readonly trail = new TrailRing<MutableTrailPoint>(TRAIL_LENGTH, () => ({
    position: new Vec3(),
    right: new Vec3(),
    up: new Vec3(),
    loadFactor: 1,
    wingtipVapor: 0,
    throttle: 0,
    altitude: 0,
  }))
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

    // 1. 指令角速度。舵の効き、G 制限、迎角制限をここで掛ける。
    //    ダメージで鈍るぶんは呼び出し側が係数で渡す
    const authority = controlAuthority(q) * (options.controlFactor ?? 1)

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

    // 翼端の水蒸気。派生値のあとに置く。迎角と海抜が要るため
    const vaporDrive =
      (this.speed / speedOfSound(this.altitude)) *
      Math.abs(liftCoefficient(this.angleOfAttack))
    const vaporTau =
      vaporDrive > this.wingtipVapor ? AIRCRAFT.vaporRiseTau : AIRCRAFT.vaporFallTau
    this.wingtipVapor += (vaporDrive - this.wingtipVapor) * lagFactor(dt, vaporTau)

    // 軌跡の記録。派生値を更新したあとに置く。荷重倍数と海抜が要るため
    if (this.stepIndex % TRAIL_STRIDE === 0) this.recordTrail(tmpUp, tmpRight)
    this.stepIndex++
  }

  /**
   * 軌跡を 1 点記録する。
   *
   * 呼ぶのは TRAIL_STRIDE ステップごと。1/120 秒ごとに残すと 768 本でも
   * 6.4 秒ぶんしか持てない。
   */
  private recordTrail(up: Vec3, right: Vec3): void {
    const slot = this.trail.push()
    slot.position.copy(this.position)
    slot.right.copy(right)
    slot.up.copy(up)
    slot.loadFactor = this.loadFactor
    slot.wingtipVapor = this.wingtipVapor
    slot.throttle = this.throttle
    slot.altitude = this.altitude
  }

  /** 記録済みの点の数。TRAIL_LENGTH で頭打ち */
  get trailLength(): number {
    return this.trail.length
  }

  /**
   * 新しい順に index 番目の点。0 が最新。
   *
   * 返すのは内部の器そのもの。保持せずその場で使う。毎フレーム 768 本を
   * 写すのは無駄なので、読む側の作法として決めておく。
   */
  trailPoint(index: number): TrailPoint {
    return this.trail.at(index)
  }

  /**
   * 描画用に前ステップと現ステップを補間した状態を書き込む。
   *
   * @param alpha 0 が前ステップ、1 が現ステップ
   */
  sample(alpha: number, out: AircraftSample): AircraftSample {
    out.position.copy(this.prevPosition).lerp(this.position, alpha)
    out.orientation.copy(this.prevOrientation).slerp(this.orientation, alpha)
    out.velocity.copy(this.velocity)
    out.speed = this.speed
    out.altitude = this.altitude
    out.angleOfAttack = this.angleOfAttack
    out.sideslip = this.sideslip
    out.bank = this.bank
    out.loadFactor = this.loadFactor
    out.wingtipVapor = this.wingtipVapor
    out.throttle = this.throttle
    out.stalled = this.stalled
    out.crashed = this.crashed
    out.integrity = this.integrity
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
    velocity: new Vec3(),
    speed: 0,
    altitude: 0,
    angleOfAttack: 0,
    sideslip: 0,
    bank: 0,
    loadFactor: 1,
    wingtipVapor: 0,
    throttle: 0,
    stalled: false,
    crashed: false,
    integrity: AIRCRAFT_INTEGRITY,
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
