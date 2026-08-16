import { FIXED_DT } from './loop'
import { Rng } from './rng'

/**
 * 1ステップ分の操縦入力。
 *
 * 生のキーイベントではなく正規化した値で受け取る。こうしておくと
 * キーボードでもゲームパッドでもリプレイスクリプトでも同じ型で流し込める。
 */
export interface InputState {
  /** ピッチ。-1 が機首下げ、+1 が機首上げ */
  pitch: number
  /** ロール。-1 が左バンク、+1 が右バンク */
  roll: number
  /** ヨー。-1 が左、+1 が右 */
  yaw: number
  /** スロットル目標。0 が最小、1 が最大 */
  throttle: number
  fireGun: boolean
  fireMissile: boolean
}

export function neutralInput(): InputState {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0.5,
    fireGun: false,
    fireMissile: false,
  }
}

export interface WorldOptions {
  /** 乱数シード。同じシードと同じ入力からは常に同じ結果が出る。 */
  seed: number
}

/**
 * シミュレーション世界。
 *
 * Phase 0 の時点ではフレームを数えるだけの骨格。機体、ミサイル、AI は
 * 後続の Phase でここにぶら下げていく。
 */
export class World {
  readonly rng: Rng
  readonly seed: number

  /** 経過ステップ数。ここが唯一の時間の源。 */
  private _frame = 0

  constructor(options: WorldOptions) {
    this.seed = options.seed
    this.rng = new Rng(options.seed)
  }

  get frame(): number {
    return this._frame
  }

  /**
   * シム内の経過秒。
   *
   * time += dt と積算せず、毎回 frame から計算し直す。浮動小数点の
   * 加算を何万回も繰り返すと誤差が蓄積して、同じフレーム数でも実行ごとに
   * 時刻がずれる。掛け算1回なら誤差は乗らない。
   */
  get time(): number {
    return this._frame * FIXED_DT
  }

  /** 1ステップ進める。呼び出しは必ず FixedStepDriver 経由にする。 */
  step(_input: InputState): void {
    this._frame++
  }
}
