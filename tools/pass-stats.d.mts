/** `tools/pass-stats.mjs` の型。本体は node が変換なしで実行するため素の JavaScript */

/** フックの `gpuPassHistory` の 1 要素（`FramePassTimes` と同じ形） */
export interface PassFrame {
  readonly frame: number
  readonly totalMs: number
  readonly passes: readonly { readonly uid: string; readonly label: string; readonly group: string; readonly ms: number }[]
  readonly unlabeled: number
}

export interface GroupStats {
  readonly group: string
  /** その群が出たフレーム数 */
  readonly frames: number
  /** 出たフレームの割合 */
  readonly share: number
  /** 出たフレームの中での値 */
  readonly median: number | null
  readonly p95: number | null
  readonly max: number
  /** 全フレームで均した寄与。間欠の群の「平均の重さ」 */
  readonly meanPerFrame: number
}

export interface PassStats {
  readonly frames: number
  readonly unlabeled: number
  readonly total: {
    readonly min: number | null
    readonly median: number | null
    readonly p95: number | null
    readonly max: number | null
  }
  readonly groups: readonly GroupStats[]
}

export function quantile(values: readonly number[], q: number): number | null
export function collectFrames(seen: Map<number, PassFrame>, history: readonly PassFrame[]): number
export function groupSums(frame: PassFrame): Map<string, number>
export function passStats(frames: readonly PassFrame[]): PassStats
