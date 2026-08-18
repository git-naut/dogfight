import type { WebGLRenderer } from 'three'

/**
 * GPU のフレーム時間を測る。
 *
 * 実機は vsync で 60fps に張り付くので、CPU 側の経過時間を見ても余裕が
 * 分からない。16.7 ms のうち実際に 5 ms しか使っていないのか 16 ms なのかで、
 * 雲のレイマーチ解像度をどこまで上げられるかの判断が変わる。
 *
 * WebGL2 の EXT_disjoint_timer_query_webgl2 で GPU 側の経過を直接測る。
 * 拡張が無い環境（多くのソフトウェアレンダラ）では supported が false になり、
 * 表示側で伏せる。
 */

interface TimerExtension {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

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
  /** フレームの計測を開始する */
  begin(): void
  /** フレームの計測を終える。結果は数フレーム後に読める */
  end(): void
  /**
   * 1 回の描画を同期で測って ms を返す。計測モード専用。拡張が無ければ null。
   *
   * begin/end は結果が数フレーム後に届く非同期の計測で、途切れなく回る
   * ループが前提になっている。設定を切り替えながら測るときは、その 1 枚の
   * 値がその場で要る。クエリの完了を待ってから返す。
   */
  measureSync(draw: () => void): number | null
  dispose(): void
}

const NOT_SUPPORTED: GpuTimer = {
  supported: false,
  lastMs: 0,
  maxMs: 0,
  begin() {},
  end() {},
  measureSync(draw) {
    draw()
    return null
  },
  dispose() {},
}

export function createGpuTimer(renderer: WebGLRenderer): GpuTimer {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
  if (ext === null) return NOT_SUPPORTED

  let pending: WebGLQuery | null = null
  let measuring = false
  let lastMs = 0
  let maxMs = 0

  /** 結果が揃っていれば取り込む。揃うまで数フレームかかる */
  function collect(): void {
    if (pending === null) return
    const available = gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE) as boolean
    const disjoint = gl.getParameter(ext!.GPU_DISJOINT_EXT) as boolean

    if (disjoint) {
      // GPU の状態が乱れた区間の値は信用できない。捨てる
      gl.deleteQuery(pending)
      pending = null
      return
    }
    if (!available) return

    const nanoseconds = gl.getQueryParameter(pending, gl.QUERY_RESULT) as number
    lastMs = nanoseconds / 1e6
    // ゆっくり減衰させる。1 回の外れ値に張り付かず、直近の重さは残る
    maxMs = Math.max(lastMs, maxMs * 0.995)
    gl.deleteQuery(pending)
    pending = null
  }

  return {
    supported: true,

    get lastMs() {
      return lastMs
    },

    get maxMs() {
      return maxMs
    },

    begin() {
      collect()
      // 前の計測がまだ回収できていないなら重ねない
      if (pending !== null || measuring) return
      const query = gl.createQuery()
      if (query === null) return
      pending = query
      measuring = true
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    },

    end() {
      if (!measuring) return
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      measuring = false
    },

    measureSync(draw) {
      // 進行中の非同期計測があると入れ子になる。TIME_ELAPSED は入れ子にできない
      if (measuring) {
        gl.endQuery(ext.TIME_ELAPSED_EXT)
        measuring = false
      }
      if (pending !== null) {
        gl.deleteQuery(pending)
        pending = null
      }

      const query = gl.createQuery()
      if (query === null) {
        draw()
        return null
      }

      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
      draw()
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      // 完了させてから待つ。finish のあとなら数回のポーリングで揃う
      gl.finish()

      for (let i = 0; i < 100_000; i++) {
        if (gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean) {
          gl.deleteQuery(query)
          return null
        }
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean) {
          const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
          gl.deleteQuery(query)
          return nanoseconds / 1e6
        }
      }

      gl.deleteQuery(query)
      return null
    },

    dispose() {
      if (pending !== null) {
        gl.deleteQuery(pending)
        pending = null
      }
    },
  }
}
