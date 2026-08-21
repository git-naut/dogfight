import { Vec3 } from '../vec3'
import { Quat } from '../quat'
import { GRAVITY, airDensity, speedOfSound } from '../isa'
import { TrailRing } from '../trail'
import type { Target } from '../target'
import { sweptHitsAircraft, createHitResult, type HitResult } from './hitbox'

/**
 * 赤外線誘導ミサイル。比例航法で誘導する。
 *
 * 諸元は AIM-9M Sidewinder の公表値を出発点にした。**推力・燃焼時間・
 * 推進剤の質量・抗力係数には公表値がない。**最大速度マッハ 2.5 に届く値を
 * 逆算して置き、実測で確かめる。
 *
 * | 項目 | 値 | 出どころ |
 * | 全長 | 2.85 m | 公表値 |
 * | 直径 | 0.127 m | 公表値 |
 * | 発射重量 | 85.5 kg | 公表値 |
 * | 最大速度 | マッハ 2.5 | 公表値 |
 * | 横加速度の上限 | 30 G | 公表値として引用される範囲（30〜35 G） |
 * | 推進剤の質量 | 25 kg | **選んだ値。**発射重量の 29% |
 * | 燃焼時間 | 5 秒 | **選んだ値** |
 * | 推力 | 9,000 N | **選んだ値。**マッハ 2.5 に届く大きさから |
 * | 抗力係数 | 0.5 | **選んだ値。**細長い超音速の弾体の範囲 |
 * | 殺傷半径 | 8 m | **選んだ値。**近接信管の作動範囲 |
 * | 安全解除 | 0.5 秒 | **選んだ値。**発射直後に自機の近くで爆発しない |
 * | 寿命 | 60 秒 | **選んだ値** |
 *
 * ## 比例航法
 *
 * 視線ベクトル r = p_t − p_m、相対速度 v = v_t − v_m とすると、視線の回転
 * 角速度ベクトルは
 *
 *   ω = (r × v) / (r · r)
 *
 * になる。接近速度（正で接近）は
 *
 *   V_c = −(r · v) / |r|
 *
 * 加速度指令は純比例航法の形にする。
 *
 *   a_cmd = N · (ω × v_m)
 *
 * この形なら加速度がミサイル速度に直交する（外積の性質）。速度の大きさを
 * 変えずに向きだけを回すので、推力と抗力の計算に混ざらない。
 *
 * ## 航法定数の意味
 *
 * 非機動の目標に対する視線回転率は λ̇ ∝ t_go^(N−2) で推移する。**N > 2 なら
 * 終末へ向かって 0 に収束し、N < 2 なら発散する。**発散すれば必要な横加速度も
 * 発散するので、上限のある実機では追いつかなくなる。
 *
 * 実測（横 900 m・前方 5,000 m の的、視線回転率 mrad/s）。
 *
 * | N | 残り 2,000 m | 1,000 m | 500 m | 200 m |
 * | 1.0 | 26.91 | 30.97 | 36.92 | 53.51 |
 * | 1.5 | 13.22 | 7.43 | 3.27 | 3.41 |
 * | 2.0 | 6.30 | 0.93 | 1.04 | 1.84 |
 * | 3.5 | 0.26 | 0.80 | 0.38 | 3.27 |
 *
 * **N = 1 だけが距離を詰めるほど増える。**これが発散である。
 *
 * **ただし「N < 2 なら当たらない」とは言えない。**易しい構図では N = 1 でも
 * 当たる。このミサイルは目標より 3 倍速く、信管半径が 8 m あるので、
 * 終末の数十ミリ秒で発散しても間に合ってしまう。差が出るのは横切りの
 * 大きい構図で、実測では 前方 2,000 m・横 3,000 m の的に対して N = 1 が
 * 417 m、N = 1.5 が 27 m 外し、N = 2 以上が当たる。
 *
 * 3〜4 が実用の範囲とされる。ここは 3.5。
 */

/** 全長 m。公表値 */
export const MISSILE_LENGTH = 2.85
/** 直径 m。公表値 */
export const MISSILE_DIAMETER = 0.127
/** 発射重量 kg。公表値 */
export const MISSILE_MASS = 85.5
/** 推進剤の質量 kg。選んだ値 */
export const PROPELLANT_MASS = 25
/** 燃焼時間 秒。選んだ値 */
export const BURN_TIME = 5
/** 推力 N。選んだ値 */
export const THRUST = 9000
/** 抗力係数。選んだ値 */
const DRAG_COEFFICIENT = 0.5
/** 基準面積 m²。直径から出す */
const REFERENCE_AREA = Math.PI * (MISSILE_DIAMETER / 2) ** 2

/** 横加速度の上限 G */
export const MAX_LATERAL_G = 30
/** 航法定数 */
export const NAV_CONSTANT = 3.5
/** シーカーの視野。ミサイル速度からの半角 rad */
export const MISSILE_SEEKER_ANGLE = (60 * Math.PI) / 180
/** 殺傷半径 m。近接信管の作動範囲 */
export const FUZE_RADIUS = 8
/** 安全解除までの秒数 */
export const ARM_TIME = 0.5
/** 寿命 秒 */
export const MISSILE_LIFETIME = 60

/** 煙の履歴の長さと刻み。4 ステップごとに 512 本 = 17.1 秒ぶん */
export const SMOKE_LENGTH = 512
export const SMOKE_STRIDE = 4

/** 煙の 1 点 */
export interface SmokePoint {
  readonly position: Vec3
  /** 煙の濃さ 0..1。燃焼中が濃い */
  smoke: number
}

interface MutableSmokePoint {
  position: Vec3
  smoke: number
}

/** 煙の履歴を読む側が要る最小限 */
export interface SmokeSource {
  readonly trailLength: number
  trailPoint(index: number): SmokePoint
}

export type MissileState = 'idle' | 'flying' | 'detonated' | 'expired'

// 一時変数。使い回してゴミを出さない
const los = new Vec3()
const relative = new Vec3()
const omega = new Vec3()
const command = new Vec3()
const acceleration = new Vec3()
const forward = new Vec3()
const scratch = new Vec3()
const hit: HitResult = createHitResult()

export interface MissileOptions {
  /**
   * 航法定数。既定は `NAV_CONSTANT`。
   *
   * **差し替えられるようにしてあるのはテストのため。**「N < 2 では当たらない」
   * を実演するには、同じ物理のまま定数だけを変える必要がある。
   */
  navConstant?: number
}

export class Missile implements SmokeSource {
  readonly navConstant: number

  constructor(options: MissileOptions = {}) {
    this.navConstant = options.navConstant ?? NAV_CONSTANT
  }

  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()

  state: MissileState = 'idle'
  /** 残り寿命 秒 */
  life = 0
  /** 燃焼の残り 秒 */
  motor = 0
  /** 発射からの経過 秒。安全解除の判定に使う */
  age = 0
  /** 現在の質量 kg。燃焼中に減る */
  mass = MISSILE_MASS
  /**
   * 撃った相手の添字。−1 なら相手なし。
   *
   * **シーカーが見失っても消さない。**近接信管は失探後も働くので、Combat が
   * 判定のために相手を渡し続ける必要がある。見えているかどうかは `guiding`。
   * 視野へ戻ってくれば誘導も戻る。
   */
  targetIndex = -1
  /** シーカーが相手を見えているか。見失うと自律飛行になる */
  guiding = false
  /** 直前の視線距離 m。近接信管の判定に使う */
  private previousRange = Infinity
  /** 起爆した位置。爆発を置くのに使う */
  readonly detonation = new Vec3()
  /** 起爆が命中だったか。近接信管が作動したなら true */
  hitTarget = false

  private readonly smoke = new TrailRing<MutableSmokePoint>(SMOKE_LENGTH, () => ({
    position: new Vec3(),
    smoke: 0,
  }))
  private stepIndex = 0

  // 描画補間用
  private readonly prevPosition = new Vec3()
  private readonly prevOrientation = new Quat()

  get trailLength(): number {
    return this.smoke.length
  }

  trailPoint(index: number): SmokePoint {
    return this.smoke.at(index)
  }

  get alive(): boolean {
    return this.state === 'flying'
  }

  /** 発射。機体の位置と速度を引き継ぐ */
  launch(
    position: Vec3,
    velocity: Vec3,
    orientation: Quat,
    targetIndex: number,
  ): void {
    this.position.copy(position)
    this.velocity.copy(velocity)
    this.orientation.copy(orientation)
    this.prevPosition.copy(position)
    this.prevOrientation.copy(orientation)

    this.state = 'flying'
    this.life = MISSILE_LIFETIME
    this.motor = BURN_TIME
    this.age = 0
    this.mass = MISSILE_MASS
    this.targetIndex = targetIndex
    this.previousRange = Infinity
    this.hitTarget = false
    this.stepIndex = 0
    this.guiding = false
    // 前の発射の煙を消す。器は使い回す
    this.smoke.clear()
  }

  /**
   * 1 ステップ進める。
   *
   * **このステップで命中したら true を返す。**呼び出し側が `state` を読んで
   * 判定すると、TypeScript が `step()` の副作用を知らないぶん型の絞り込みで
   * 誤検出する（`'flying'` と `'detonated'` は重ならない、と言われる）。
   * 返り値にすれば呼び側も素直になる。
   *
   * @param target 狙っている標的。null なら自律飛行（誘導しない）
   */
  step(dt: number, target: Target | null): boolean {
    if (this.state !== 'flying') return false

    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)

    this.age += dt
    this.life -= dt
    if (this.life <= 0) {
      this.state = 'expired'
      return false
    }

    const guided = this.guide(target, dt)

    // 推力。燃焼中だけ。速度の向きへ押す
    const speed = this.velocity.length()
    acceleration.set(0, -GRAVITY, 0)
    if (speed > 1e-6) {
      forward.copy(this.velocity).multiplyScalar(1 / speed)
      const density = airDensity(this.position.y)

      if (this.motor > 0) {
        // 燃焼の末端は 1 ステップに収まらない。押した時間で按分する
        const burn = Math.min(dt, this.motor)
        acceleration.addScaledVector(forward, (THRUST / this.mass) * (burn / dt))
        this.motor -= dt
        // 推進剤を消費して軽くなる
        this.mass -= (PROPELLANT_MASS / BURN_TIME) * burn
      }

      // 抗力は速度の逆向き
      const drag = 0.5 * density * speed * speed * REFERENCE_AREA * DRAG_COEFFICIENT
      acceleration.addScaledVector(forward, -drag / this.mass)
    }

    if (guided) acceleration.add(command)

    // semi-implicit Euler。速度を先に更新してから位置に使う
    this.velocity.addScaledVector(acceleration, dt)
    this.position.addScaledVector(this.velocity, dt)

    this.pointAlongVelocity()
    this.recordSmoke()

    if (target === null) return false
    this.checkFuze(target)
    return this.hitTarget
  }

  /**
   * 比例航法の加速度指令を `command` へ書く。
   *
   * 誘導できないときは false を返す（自律飛行になる）。
   */
  private guide(target: Target | null, dt: number): boolean {
    void dt
    if (target === null || !target.alive) {
      this.guiding = false
      return false
    }

    los.subVectors(target.position, this.position)
    const range = los.length()
    if (range < 1e-6) {
      this.guiding = false
      return false
    }

    const speed = this.velocity.length()
    if (speed < 1e-6) {
      this.guiding = false
      return false
    }

    // シーカーの視野。ミサイルの進行方向から測る
    const cos = los.dot(this.velocity) / (range * speed)
    if (Math.acos(Math.min(1, Math.max(-1, cos))) > MISSILE_SEEKER_ANGLE) {
      this.guiding = false
      return false
    }

    proportionalNavigation(
      this.position,
      this.velocity,
      target.position,
      target.velocity,
      this.navConstant,
      command,
    )

    /*
     * 重力の打ち消し。
     *
     * この弾体には揚力を入れていないので、放っておくと落ちる。実測で
     * 12 秒に 927 m 落ちた。比例航法が視線の回転を打ち消すぶんで結果的に
     * 当たるが、横加速度をそこに使ってしまう。
     *
     * 実機の自動操縦は、翼が出す横力の一部を高度の保持に回す。同じことを
     * する。**足せるのは速度に直交する成分だけ。**速度方向の成分を足すと
     * 加速や減速になってしまう。
     */
    scratch.set(0, GRAVITY, 0)
    scratch.addScaledVector(forward.copy(this.velocity).multiplyScalar(1 / speed), -scratch.dot(forward))
    command.add(scratch)

    // 横加速度の上限でクランプ
    const limit = MAX_LATERAL_G * GRAVITY
    const magnitude = command.length()
    if (magnitude > limit) command.multiplyScalar(limit / magnitude)
    this.guiding = true
    return true
  }

  /**
   * 近接信管。
   *
   * **距離が閾値を割った瞬間で判定してはいけない。**マッハ 2.5 のミサイルと
   * 正面から向かい合うと接近速度が 1,000 m/s を超え、1/120 秒で 8.6 m 進む。
   * 殺傷半径 8 m と同じ大きさなので、跨いで通過する。弾と同じ掃引の判定を使う。
   */
  private checkFuze(target: Target): void {
    if (this.age < ARM_TIME || !target.alive) return

    sweptHitsAircraft(
      this.prevPosition,
      this.position,
      target.position,
      target.orientation,
      FUZE_RADIUS,
      undefined,
      hit,
    )
    if (hit.hit) {
      this.detonation.copy(hit.point)
      this.hitTarget = true
      this.state = 'detonated'
      return
    }

    // 最接近を通り過ぎたかどうかも見る。掃引で捉えられない斜めの通過に備える
    const range = scratch.subVectors(target.position, this.position).length()
    if (range > this.previousRange && this.previousRange <= FUZE_RADIUS) {
      this.detonation.copy(this.position)
      this.hitTarget = true
      this.state = 'detonated'
      return
    }
    this.previousRange = range
  }

  /** 機首を速度の向きへ合わせる。空力で安定した弾体の近似 */
  private pointAlongVelocity(): void {
    const speed = this.velocity.length()
    if (speed < 1e-6) return
    forward.copy(this.velocity).multiplyScalar(1 / speed)
    setOrientationFromForward(forward, this.orientation)
  }

  private recordSmoke(): void {
    if (this.stepIndex % SMOKE_STRIDE === 0) {
      const slot = this.smoke.push()
      slot.position.copy(this.position)
      // 燃焼中は濃く、燃え尽きたら薄い残り煙
      slot.smoke = this.motor > 0 ? 1 : 0.25
    }
    this.stepIndex++
  }

  /** マッハ数。実測の確認に使う */
  get mach(): number {
    return this.velocity.length() / speedOfSound(this.position.y)
  }

  /** 描画用に補間した位置と姿勢を書き込む */
  sample(alpha: number, outPosition: Vec3, outOrientation: Quat): void {
    outPosition.copy(this.prevPosition).lerp(this.position, alpha)
    outOrientation.copy(this.prevOrientation).slerp(this.orientation, alpha)
  }

  reset(): void {
    this.state = 'idle'
    this.life = 0
    this.motor = 0
    this.age = 0
    this.targetIndex = -1
    this.guiding = false
    this.hitTarget = false
    this.previousRange = Infinity
  }
}

/**
 * 比例航法の加速度指令。
 *
 * 視線ベクトル r = p_t − p_m、相対速度 v = v_t − v_m として
 *
 *   ω = (r × v) / (r · r)        視線の回転角速度ベクトル
 *   a  = N · (ω × v_m)
 *
 * 外積なので結果はミサイル速度に直交する。速度の大きさを変えずに向きだけを
 * 回すので、推力と抗力の計算に混ざらない。この直交性は単体テストで固定した。
 *
 * 純関数にしてあるので、航法定数を変えたときの振る舞いを直接確かめられる。
 */
export function proportionalNavigation(
  missilePosition: Vec3,
  missileVelocity: Vec3,
  targetPosition: Vec3,
  targetVelocity: Vec3,
  navConstant: number,
  out: Vec3 = new Vec3(),
): Vec3 {
  los.subVectors(targetPosition, missilePosition)
  const rangeSq = los.lengthSq()
  if (rangeSq < 1e-12) return out.set(0, 0, 0)
  relative.subVectors(targetVelocity, missileVelocity)
  omega.crossVectors(los, relative).multiplyScalar(1 / rangeSq)
  return out.crossVectors(omega, missileVelocity).multiplyScalar(navConstant)
}

/**
 * 接近速度 m/s。正で接近。
 *
 *   V_c = −(r · v) / |r|
 */
export function closingSpeed(
  missilePosition: Vec3,
  missileVelocity: Vec3,
  targetPosition: Vec3,
  targetVelocity: Vec3,
): number {
  los.subVectors(targetPosition, missilePosition)
  const range = los.length()
  if (range < 1e-9) return 0
  relative.subVectors(targetVelocity, missileVelocity)
  return -relative.dot(los) / range
}

const axis = new Vec3()
const BODY_FORWARD = new Vec3(0, 0, -1)

/**
 * 前方ベクトルから姿勢を作る。
 *
 * 機首（−Z）を渡された向きへ回す最短の回転。ロールは決まらないが、
 * ミサイルは軸対称なので絵に出ない。
 */
export function setOrientationFromForward(forward: Vec3, out: Quat): Quat {
  const dot = BODY_FORWARD.dot(forward)
  if (dot > 1 - 1e-9) return out.identity()
  if (dot < -1 + 1e-9) {
    // 真後ろ。任意の直交軸まわりに 180 度
    return out.setFromAxisAngle(new Vec3(0, 1, 0), Math.PI)
  }
  axis.crossVectors(BODY_FORWARD, forward).normalize()
  return out.setFromAxisAngle(axis, Math.acos(dot))
}

/**
 * 零化距離。このまま飛んだときの最接近距離 m。
 *
 * 比例航法が効いているかを測るのに使う。視線に直交する相対速度の成分に
 * 残り時間を掛けたもの。
 *
 *   t_go = |r| / V_c
 *   ZEM  = |r × v| / |v|
 */
export function zeroEffortMiss(
  missilePosition: Vec3,
  missileVelocity: Vec3,
  targetPosition: Vec3,
  targetVelocity: Vec3,
): number {
  los.subVectors(targetPosition, missilePosition)
  relative.subVectors(targetVelocity, missileVelocity)
  const speed = relative.length()
  if (speed < 1e-9) return los.length()
  return omega.crossVectors(los, relative).length() / speed
}
