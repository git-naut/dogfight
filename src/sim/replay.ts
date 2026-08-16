import { Vec3 } from './vec3'
import { Quat } from './quat'
import { airDensity } from './isa'
import { trimCondition } from './flightModel'
import { type InputState, neutralInput } from './input'

/**
 * 入力スクリプトの再生。
 *
 * フレーム番号と入力の対応表を決定論ループへ流し込む。用途は2つある。
 * ひとつはリグレッション検証で、「この入力列でこう飛ぶ」をアサートしておけば
 * 飛行モデルが壊れた瞬間に検出できる。もうひとつはスクリーンショット回帰で、
 * 撮りたい場面を再現性のある形で指定できる。
 *
 * 当初は src/input/ に置く構成案だったが、vitest から node 環境で走らせるため
 * three にもブラウザにも依存できない。sim 層に置く。
 */

/** 機体の初期条件。数値だけで表せる形にしてスクリプトを宣言的に保つ。 */
export interface SpawnSpec {
  altitude: number
  speed: number
  /** バンク角 rad。右が正 */
  bank?: number
  /** 上昇角 rad。機首の仰角ではなく速度ベクトルの向き */
  climbAngle?: number
}

export interface ReplayKeyframe {
  /** このフレーム以降に適用する。フレーム昇順で並べる */
  frame: number
  input: Partial<InputState>
}

export interface ReplayScript {
  name: string
  seed: number
  spawn: SpawnSpec
  keyframes: ReplayKeyframe[]
}

export interface SpawnState {
  position: Vec3
  velocity: Vec3
  orientation: Quat
  throttle: number
}

const BODY_RIGHT = new Vec3(1, 0, 0)
const BODY_FORWARD = new Vec3(0, 0, -1)

/**
 * 初期条件を実際の状態へ展開する。
 *
 * 迎角とスロットルは水平定常飛行のトリムから解く。こうしないと開始直後に
 * 高度が沈むか浮くかして、そのぶんだけ検証がぶれる。
 */
export function spawnFromSpec(spec: SpawnSpec): SpawnState {
  const density = airDensity(spec.altitude)
  const { alpha, throttle } = trimCondition(spec.speed, density)
  const climb = spec.climbAngle ?? 0

  // 速度は上昇角ぶん傾けた -Z 方向
  const velocity = new Vec3(
    0,
    Math.sin(climb) * spec.speed,
    -Math.cos(climb) * spec.speed,
  )

  // 機首は速度からさらに迎角ぶん上を向く。そのあと機首軸まわりにバンクさせる
  const orientation = new Quat().setFromAxisAngle(BODY_RIGHT, climb + alpha)
  if (spec.bank) {
    orientation.multiply(new Quat().setFromAxisAngle(BODY_FORWARD, spec.bank))
  }

  return {
    position: new Vec3(0, spec.altitude, 0),
    velocity,
    orientation,
    throttle,
  }
}

/**
 * キーフレームを畳み込んで各フレームの入力を返す。
 *
 * 指定のないキーは直前の値を引き継ぐ。全部書かずに変化点だけ書けるので
 * スクリプトが読みやすくなる。
 */
export class ReplayPlayer {
  private readonly keyframes: ReplayKeyframe[]
  private readonly current: InputState
  private nextIndex = 0

  constructor(script: ReplayScript) {
    this.keyframes = [...script.keyframes].sort((a, b) => a.frame - b.frame)
    this.current = neutralInput()

    // spawn のトリムスロットルを初期値にしておく
    this.current.throttle = spawnFromSpec(script.spawn).throttle
  }

  /**
   * frame 時点の入力。フレームは 0 から順に呼ぶこと。
   * 戻り値は内部状態を使い回すので、保持せずその場で使う。
   */
  at(frame: number): InputState {
    while (
      this.nextIndex < this.keyframes.length &&
      this.keyframes[this.nextIndex]!.frame <= frame
    ) {
      Object.assign(this.current, this.keyframes[this.nextIndex]!.input)
      this.nextIndex++
    }
    return this.current
  }
}
