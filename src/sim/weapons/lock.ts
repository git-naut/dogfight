import { Vec3 } from '../vec3'
import type { Quat } from '../quat'
import type { Target } from '../target'

/**
 * ロックオン。赤外線シーカーの捕捉。
 *
 * 段階は 3 つ。**探索**（誰も捉えていない）、**捕捉中**（視野に入ってから
 * 一定時間が経つのを待つ）、**ロック**（発射できる）。視野から外れるか、
 * 距離が限界を超えるか、目標が落ちると探索へ戻る。
 *
 * この仕組みが要る理由は絵で測って分かった。追従カメラの垂直画角は速度
 * 250 m/s で 66.4 度あり、190 m の機体でも実測 28 x 10 画素にしかならない。
 * **交戦距離の相手は肉眼では見つけられない。**ロックボックスがないと、
 * どこを狙っているのか分からない。
 *
 * 諸元の出どころを書き分ける。
 *
 * | 項目 | 値 | 出どころ |
 * | 追従できる視野（機軸から） | 40 度 | AIM-9 の後期型のジンバル限界として公表されている値 |
 * | 捕捉を始める視野 | 20 度 | **選んだ値。**機首を向けないと捕捉が始まらない手触りにした |
 * | 最大距離 | 15,000 m | **選んだ値。**赤外線シーカーの実効距離は条件で大きく変わる |
 * | 捕捉にかかる時間 | 0.7 秒 | **選んだ値。**機首を通り過ぎただけでロックしない長さ |
 *
 * 地形による遮蔽は見ていない。山の裏の目標もロックできる。Phase 6 で
 * 敵機と AI を入れるときに、必要なら足す。
 */

const DEG = Math.PI / 180

/** 追従できる視野。機軸からの半角 rad */
export const SEEKER_TRACK_ANGLE = 40 * DEG
/** 捕捉を始める視野。機軸からの半角 rad */
export const SEEKER_ACQUIRE_ANGLE = 20 * DEG
/** 捕捉できる最大距離 m */
export const SEEKER_MAX_RANGE = 15_000
/** 捕捉にかかる時間 秒 */
export const SEEKER_ACQUIRE_TIME = 0.7

export type LockState = 'none' | 'acquiring' | 'locked'

// 一時変数。使い回してゴミを出さない
const nose = new Vec3()
const toTarget = new Vec3()
const relativeVelocity = new Vec3()

export interface LockView {
  readonly state: LockState
  /** 捉えている標的の添字。none なら -1 */
  readonly index: number
  /** 距離 m */
  readonly range: number
  /** 接近速度 m/s。正が接近、負が離脱 */
  readonly closingSpeed: number
  /** 機軸からの角度 rad */
  readonly angleOffBoresight: number
  /** 捕捉の進み 0..1。locked なら 1 */
  readonly progress: number
}

export class Lock implements LockView {
  state: LockState = 'none'
  index = -1
  range = 0
  closingSpeed = 0
  angleOffBoresight = 0
  progress = 0

  /** 捕捉を始めてからの経過秒 */
  private acquired = 0

  /**
   * 1 ステップ進める。
   *
   * ロック中はその目標を追い続ける。**毎ステップ選び直すと、機首の前を
   * 別の目標が横切った瞬間に乗り換える。**追い続けたうえで、条件が崩れたら
   * 落とす。
   */
  step(
    position: Vec3,
    velocity: Vec3,
    orientation: Quat,
    targets: readonly Target[],
    dt: number,
  ): void {
    orientation.forward(nose)

    if (this.state !== 'none' && this.holds(position, velocity, targets)) {
      this.advance(dt)
      return
    }

    const best = this.pick(position, targets)
    if (best < 0) {
      this.release()
      return
    }

    this.index = best
    this.measure(position, velocity, targets[best]!)
    this.state = 'acquiring'
    this.acquired = 0
    this.progress = 0
    this.advance(dt)
  }

  /**
   * いま捉えている目標を持ち続けられるか。
   *
   * 追従の視野は捕捉の視野より広い。いったん掴んだら機首を外しても
   * しばらく追えるという振る舞いにしてある。
   */
  private holds(
    position: Vec3,
    velocity: Vec3,
    targets: readonly Target[],
  ): boolean {
    const held = targets[this.index]
    if (held === undefined || !held.alive) return false
    this.measure(position, velocity, held)
    return (
      this.angleOffBoresight <= SEEKER_TRACK_ANGLE && this.range <= SEEKER_MAX_RANGE
    )
  }

  /**
   * 捕捉を始める相手を選ぶ。機軸にいちばん近いもの。
   *
   * 距離ではなく角度で選ぶ。遠くても正面にいる相手のほうが「狙っている」
   * 相手である。
   */
  private pick(position: Vec3, targets: readonly Target[]): number {
    let best = -1
    let bestAngle = SEEKER_ACQUIRE_ANGLE
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      if (!target.alive) continue
      toTarget.subVectors(target.position, position)
      const range = toTarget.length()
      if (range > SEEKER_MAX_RANGE || range < 1e-6) continue
      const cos = toTarget.dot(nose) / range
      const angle = Math.acos(Math.min(1, Math.max(-1, cos)))
      if (angle >= bestAngle) continue
      bestAngle = angle
      best = i
    }
    return best
  }

  /** 距離と接近速度と機軸からの角度を測る */
  private measure(position: Vec3, velocity: Vec3, target: Target): void {
    toTarget.subVectors(target.position, position)
    this.range = toTarget.length()
    if (this.range < 1e-6) {
      this.angleOffBoresight = 0
      this.closingSpeed = 0
      return
    }
    // 視線の単位ベクトルと機軸の内積が角度になる
    const cos = toTarget.dot(nose) / this.range
    this.angleOffBoresight = Math.acos(Math.min(1, Math.max(-1, cos)))

    // 接近速度は視線方向の相対速度。正で接近
    relativeVelocity.subVectors(target.velocity, velocity)
    this.closingSpeed = -relativeVelocity.dot(toTarget) / this.range
  }

  /** 捕捉の時間を進める。溜まったらロックへ上げる */
  private advance(dt: number): void {
    if (this.state === 'locked') {
      this.progress = 1
      return
    }
    this.acquired += dt
    this.progress = Math.min(1, this.acquired / SEEKER_ACQUIRE_TIME)
    if (this.acquired >= SEEKER_ACQUIRE_TIME) this.state = 'locked'
  }

  release(): void {
    this.state = 'none'
    this.index = -1
    this.range = 0
    this.closingSpeed = 0
    this.angleOffBoresight = 0
    this.progress = 0
    this.acquired = 0
  }
}
