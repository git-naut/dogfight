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
  /** フレームの計測を開始する */
  begin(): void
  /** フレームの計測を終える。結果は数フレーム後に読める */
  end(): void
  dispose(): void
}

const NOT_SUPPORTED: GpuTimer = {
  supported: false,
  lastMs: 0,
  begin() {},
  end() {},
  dispose() {},
}

export function createGpuTimer(renderer: WebGLRenderer): GpuTimer {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
  if (ext === null) return NOT_SUPPORTED

  let pending: WebGLQuery | null = null
  let measuring = false
  let lastMs = 0

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
    gl.deleteQuery(pending)
    pending = null
  }

  return {
    supported: true,

    get lastMs() {
      return lastMs
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

    dispose() {
      if (pending !== null) {
        gl.deleteQuery(pending)
        pending = null
      }
    },
  }
}
