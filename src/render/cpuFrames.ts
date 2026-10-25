/**
 * フレームごとの CPU の内訳（段 S0e）。
 *
 * 計器の CPU の内訳は平滑化した値しか持たない。段 S0d で「投入（three が命令を
 * 積む時間）と GPU が 1 フレームの中で直列に足され、和が 16.7 ms を超えると vsync に
 * 間に合わない」という見立てが立ったので、フレームごとの値を GPU の内訳と同じ
 * フレーム番号で残し、遅れたフレームと突き合わせる。
 *
 * three に依存しない。node で検査でき、歯型が効く。
 */

export interface CpuFrame {
  /** GPU の timestamp の鍵と同じフレーム番号（描いたときの `info.frame`） */
  readonly frame: number
  /** rAF の時刻 ms。隣のフレームとの差がフレームの間隔 */
  readonly at: number
  readonly simMs: number
  readonly syncMs: number
  /** 投入。`view.render()` の CPU 側の経過 */
  readonly renderMs: number
  readonly hudMs: number
}

/** 残すフレーム数。`gpuTimer.ts` の `PASS_HISTORY` と同じ長さ（60 fps で 4 秒） */
export const CPU_FRAME_HISTORY = 240

/** 上限つきの輪に積む。古い順に並び、上限を超えたら前から捨てる */
export function pushFrame<T>(ring: T[], item: T, cap: number = CPU_FRAME_HISTORY): void {
  ring.push(item)
  if (ring.length > cap) ring.splice(0, ring.length - cap)
}
