import type { RenderBackend } from './backend'
import type { FramePassTimes } from './pipeline/passTimes'

/**
 * パスの和と three の合計の食い違いの許容 ms（段 S0a）。
 *
 * 両方とも同じ解決の同じ Map から出るので、定義の上では一致する。食い違うのは
 * フレームの選び方が three とずれたときで、それを数えて計器に出す
 */
export const PASS_SUM_TOLERANCE_MS = 0.01

/**
 * 内訳を残すフレーム数。実機の計測（`tools/win-pass-perf.mjs`）が 0.5 秒おきに
 * 読んでも取りこぼさない長さ（60 fps で 4 秒）
 */
export const PASS_HISTORY = 240

/**
 * GPU のフレーム時間を計器へ出す。
 *
 * 実機は vsync で 60fps に張り付くので、CPU 側の経過時間を見ても余裕が
 * 分からない。16.7 ms のうち実際に 5 ms しか使っていないのか 16 ms なのかで、
 * 雲のレイマーチ解像度をどこまで上げられるかの判断が変わる。
 *
 * **測り方はバックエンドが持つ。**WebGL2 は
 * `EXT_disjoint_timer_query_webgl2`、node 経路は
 * `renderer.resolveTimestampsAsync()`。ここはどちらかを知らず、
 * 計器が読む「直近の値」と「直近しばらくの最大値」だけを作る（段 18）。
 */

export interface GpuTimer {
  readonly supported: boolean
  /** 直近に取得できた GPU フレーム時間 ms。未取得なら 0 */
  readonly lastMs: number
  /**
   * 直近しばらくの最大値 ms。
   *
   * 現在値だけでは予算の判断を誤る。結果が揃ったときにしか更新されないので、
   * 重いフレームほど古い軽い値が残り続ける。実際に GPU 10.8 ms と出ている
   * 横で FPS が 46 に落ちていた。budget を決めるのは最大値のほう。
   */
  readonly maxMs: number
  /** 直近の回のパスごとの内訳。読めていなければ null（段 S0a） */
  readonly lastPasses: FramePassTimes | null
  /**
   * パスの和が合計と `PASS_SUM_TOLERANCE_MS` を超えて食い違った回数。
   * 0 でなければ内訳を信じない
   */
  readonly passMismatches: number
  /**
   * 直近 `PASS_HISTORY` フレームぶんの内訳。古い順。解決を待つ間に描いた
   * フレームも入る（`GpuFrameSample.frames`）
   */
  readonly passHistory: readonly FramePassTimes[]
  /** フレームの計測を開始する */
  begin(): void
  /** フレームの計測を終える。結果は数フレーム後に読める */
  end(): void
  dispose(): void
}

const NOT_SUPPORTED: GpuTimer = {
  supported: false,
  lastMs: 0,
  maxMs: 0,
  lastPasses: null,
  passMismatches: 0,
  passHistory: [],
  begin() {},
  end() {},
  dispose() {},
}

export function createGpuTimer(backend: RenderBackend): GpuTimer {
  const timer = backend.createTimer()
  if (!timer.supported) return NOT_SUPPORTED

  let lastMs = 0
  let maxMs = 0
  let lastPasses: FramePassTimes | null = null
  let passMismatches = 0
  const passHistory: FramePassTimes[] = []

  return {
    supported: true,

    get lastMs() {
      return lastMs
    },

    get maxMs() {
      return maxMs
    },

    get lastPasses() {
      return lastPasses
    },

    get passMismatches() {
      return passMismatches
    },

    get passHistory() {
      return passHistory
    },

    begin() {
      for (const result of timer.collect()) {
        lastMs = result.ms
        // ゆっくり減衰させる。1 回の外れ値に張り付かず、直近の重さは残る
        maxMs = Math.max(lastMs, maxMs * 0.995)
        if (result.passes !== undefined) {
          if (Math.abs(result.passes.totalMs - result.ms) > PASS_SUM_TOLERANCE_MS) {
            passMismatches++
          }
          lastPasses = result.passes
        }
        for (const frame of result.frames ?? []) passHistory.push(frame)
        if (passHistory.length > PASS_HISTORY) {
          passHistory.splice(0, passHistory.length - PASS_HISTORY)
        }
      }
      // 前の計測がまだ回収できていないなら重ねない
      if (timer.inflight > 0) return
      timer.begin(0)
    },

    end() {
      timer.end()
    },

    dispose() {
      timer.dispose()
    },
  }
}
