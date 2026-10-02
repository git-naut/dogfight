import { FIXED_DT } from './loop'
import { TrailRing } from './trail'

/**
 * 撃墜の記録と点数（段 32、計画書の段 29）。
 *
 * 参考画像の左上は `SCORE 007320` と、撃墜の瞬間だけ出る `TARGET TU-160 +1200`。
 * 合計は表示層でも組めるが、**加点の表示には撃墜したフレームが要る**ので sim に置く。
 * キャプチャモードは `sync()` が 1 回しか走らないので、描画側に状態を置くと何も出ない
 * （爆発の `Effects` と同じ理由、同じ形）
 */

/** 撃墜 1 件 */
export interface Kill {
  /** 撃墜したフレーム。空の器は −1 */
  frame: number
  /** 機名。HUD の `TARGET` の後ろに出す */
  designation: string
  points: number
}

/** 加点の表示を出しておく秒数 */
export const KILL_SHOW_SECONDS = 3

/** 覚えておく撃墜の数。表示に使うのは最後の 1 件だけなので小さくてよい */
const KILL_POOL = 16

export class ScoreLog {
  private readonly ring = new TrailRing<Kill>(KILL_POOL, () => ({
    frame: -1,
    designation: '',
    points: 0,
  }))
  /** 合計の点数 */
  total = 0

  record(frame: number, designation: string, points: number): void {
    const kill = this.ring.push()
    kill.frame = frame
    kill.designation = designation
    kill.points = points
    this.total += points
  }

  /**
   * 加点の表示を出す撃墜。最後の撃墜から `KILL_SHOW_SECONDS` 秒のあいだだけ返す。
   *
   * 経過は**フレーム番号の差**から出す（`time += dt` を積まない）
   */
  latest(frame: number): Kill | null {
    if (this.ring.length === 0) return null
    const kill = this.ring.at(0)
    const age = (frame - kill.frame) * FIXED_DT
    if (kill.frame < 0 || age < 0 || age >= KILL_SHOW_SECONDS - 1e-9) return null
    return kill
  }

  reset(): void {
    this.ring.clear()
    this.total = 0
  }
}
