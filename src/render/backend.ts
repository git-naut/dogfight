import type { WebGLRenderer } from 'three'

/**
 * 描画バックエンドの継ぎ目。
 *
 * **WebGPU へ移すと消えるか名前が変わるものだけを、ここに集める。**
 * 描画そのもの（`render` や `setRenderTarget`）はまだ `renderer` が持つ。
 * パイプラインの分離は段 8 で行う。
 *
 * ここに集めた面は次のとおり。どれも `WebGPURenderer` では別の形になる。
 *
 * | いま | node 経路 |
 * |---|---|
 * | `renderer.info.render.calls` | `renderer.info.render.drawCalls` |
 * | `renderer.info.programs.length` | `renderer.info.memory.programs` |
 * | `gl.drawingBufferWidth/Height` | `renderer.getDrawingBufferSize(v)` |
 * | `renderer.capabilities.isWebGL2` | `renderer.backend.isWebGPUBackend` |
 * | `gl.finish()` + `gl.readPixels()` | `await resolveTimestampsAsync()` |
 * | `renderer.getContext()` | **WebGPU では `undefined`** |
 *
 * `renderer.getContext()` が空になるのが効く。`Backend.getContext()` は
 * three の WebGPU 側では空実装で、計測の排出も GPU タイマーもそこに
 * ぶら下がっている。
 */
export type BackendKind = 'webgl' | 'node-webgl' | 'node-webgpu'

export interface DrawingBufferSize {
  width: number
  height: number
}

export interface RenderBackend {
  readonly kind: BackendKind
  readonly domElement: HTMLCanvasElement

  /**
   * 段 8 までの過渡的な口。
   *
   * 描画とレンダーターゲットの操作はまだこちらを使う。移行が進むにつれて
   * 参照は減る。**新しく増やさない。**
   */
  readonly renderer: WebGLRenderer

  /** 直近のフレームで投入したドローコール */
  readonly drawCalls: number
  /** 直近のフレームで投入した三角形 */
  readonly triangles: number
  /** 作ったシェーダプログラムの数 */
  readonly programs: number

  /**
   * 生きているコンテキストから読んだ WebGL の版。WebGPU 経路では 0。
   *
   * **`kind` から導いてはいけない。**導くと `webglVersion` は
   * 「`kind` が `webgl` なら 2」というただの言い換えになり、
   * `smoke.spec.ts` の「WebGL2 が取れているか」が原理的に落ちなくなる。
   * ここは `gl.VERSION` の実物を読む
   */
  readonly webglVersion: number

  /**
   * フレーム頭で投入の集計を 0 に戻す。
   *
   * `renderer.info.autoReset = false` にしてあるので自分で呼ぶ。既定のまま
   * だと `render()` ごとに 0 に戻り、雲やポストを含めた総数が読めない。
   */
  resetInfo(): void

  /** 実際に描いている画素の大きさ。器を使い回す */
  drawingBufferSize(out?: DrawingBufferSize): DrawingBufferSize

  /**
   * 投入済みを排出して待つ。計測専用。
   *
   * **`gl.finish()` では足りない。**Chrome は描画コマンドを溜めるので、
   * 読み戻しで排出させないと投入時間しか測れない。実測で全解像度が
   * 1/4 解像度より速く出て気づいた。
   */
  drain(): void

  /**
   * WebGL の生のコンテキスト。**逃げ口。**
   *
   * GPU タイマー（`EXT_disjoint_timer_query_webgl2`）だけがこれを使う。
   * WebGPU 経路では null を返すので、呼ぶ側は必ず null を見る。
   * 段 16 で計測系を作り直すときに消す。
   */
  webglContext(): WebGL2RenderingContext | null
}

export function createWebGLBackend(renderer: WebGLRenderer): RenderBackend {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const pixel = new Uint8Array(4)
  const size: DrawingBufferSize = { width: 0, height: 0 }

  // 集計は自分で 0 に戻す。理由は `resetInfo` の注記
  renderer.info.autoReset = false

  // 版は起動時に 1 度だけ読む。文字列は
  // `WebGL 2.0 (OpenGL ES 3.0 Chromium)` のような形で返る
  const webglVersion = /WebGL 2/.test(gl.getParameter(gl.VERSION) as string) ? 2 : 1

  return {
    kind: 'webgl',
    domElement: renderer.domElement,
    renderer,
    webglVersion,

    get drawCalls() {
      return renderer.info.render.calls
    },
    get triangles() {
      return renderer.info.render.triangles
    },
    get programs() {
      return renderer.info.programs?.length ?? 0
    },

    resetInfo() {
      renderer.info.reset()
    },

    drawingBufferSize(out = size) {
      out.width = gl.drawingBufferWidth
      out.height = gl.drawingBufferHeight
      return out
    },

    drain() {
      gl.finish()
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    },

    webglContext() {
      return gl
    },
  }
}
