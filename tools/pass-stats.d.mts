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

/** フックの `cpuFrameHistory` の 1 要素（`src/render/cpuFrames.ts` の `CpuFrame` と同じ形） */
export interface CpuFrame {
  readonly frame: number
  readonly at: number
  readonly simMs: number
  readonly syncMs: number
  readonly renderMs: number
  readonly hudMs: number
}

export interface FrameOutliers {
  readonly gpu: {
    /** 合計が 1 フレームの長さを越えたコマの数 */
    readonly over: number
    readonly worst: readonly { readonly frame: number; readonly totalMs: number; readonly groups: readonly { readonly group: string; readonly ms: number }[] }[]
  }
  /** CPU の記録が無い版では null */
  readonly cpu: {
    readonly intervals: number
    /** rAF の間隔が 1.5 フレームを越えた数 */
    readonly dropped: number
    readonly worst: readonly {
      readonly frame: number
      readonly intervalMs: number
      readonly simMs: number
      readonly syncMs: number
      readonly renderMs: number
      readonly hudMs: number
      readonly gpuMs: number | null
    }[]
  } | null
}

export const FRAME_BUDGET_MS: number
export const DROPPED_INTERVAL_MS: number
export const READ_GAP_MS: number
export function frameOutliers(frames: readonly PassFrame[], cpuFrames: readonly CpuFrame[], limit?: number): FrameOutliers
export function quantile(values: readonly number[], q: number): number | null
export function collectFrames(seen: Map<number, PassFrame>, history: readonly PassFrame[]): number
export function groupSums(frame: PassFrame): Map<string, number>
export function passStats(frames: readonly PassFrame[]): PassStats
