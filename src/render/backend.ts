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
 * 計測の口は `createTimer()` に寄せた（段 18）。生のコンテキストを借りる
 * `webglContext()` は消えている。
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
   * `drain()` が実際に排出できるか。
   *
   * **WebGPU バックエンドでは `getContext()` が `undefined`** なので
   * `gl.finish()` + `readPixels` の手が使えない。false のとき CPU 側の
   * 経過は投入までの時間しか測っていないので、掃引の判定がそれを見る
   */
  readonly cpuSynchronous: boolean

  /**
   * GPU の時間を測る道具を作る。
   *
   * **バックエンドごとに実体が違う。**WebGL2 は
   * `EXT_disjoint_timer_query_webgl2`、node 経路は
   * `renderer.resolveTimestampsAsync()`。呼ぶ側はどちらかを知らない。
   *
   * 段 18 でここへ寄せた。それまでは `webglContext()` で生のコンテキストを
   * 借りていて、**WebGPU 経路では null が返るという逃げ口**になっていた
   */
  createTimer(): GpuFrameTimer
}

/**
 * GPU の時間を測る。
 *
 * 1 枚の描画を `begin` と `end` で挟み、結果は数フレーム後に `collect` で
 * 回収する。**同じタスクの中では結果が揃わない**（`gl.finish()` を挟んでも
 * 揃わなかった）。札を付けて回収するのは、掃引が条件ごとに測るため。
 */
export interface GpuFrameTimer {
  readonly supported: boolean
  /** 回収待ちの数。0 でなければ次の計測を重ねない */
  readonly inflight: number
  /**
   * 捨てた計測の数。
   *
   * **測れなかった回を 0 として数に混ぜない。**代表値は最小値で取るので、
   * 0 が 1 つ混ざると「GPU 0 ms」がそのまま出る。捨てた回はここで数える
   */
  readonly dropped: number
  /** 1 枚の描画を挟む。`id` は回収の照合に使う */
  begin(id: number): void
  end(): void
  /** 揃った結果を回収する。**揃った分だけ返す** */
  collect(): readonly { readonly id: number; readonly ms: number }[]
  dispose(): void
}

interface TimerExtension {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

/** 測れないときの実体。呼ぶ側で分岐を書かずに済む */
export const NO_GPU_TIMER: GpuFrameTimer = {
  supported: false,
  inflight: 0,
  dropped: 0,
  begin() {},
  end() {},
  collect() {
    return []
  },
  dispose() {},
}

function createWebGLTimer(gl: WebGL2RenderingContext): GpuFrameTimer {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
  if (ext === null) return NO_GPU_TIMER

  const pending: { query: WebGLQuery; id: number }[] = []
  let measuring = false
  let dropped = 0

  return {
    supported: true,

    get inflight() {
      return pending.length
    },

    get dropped() {
      return dropped
    },

    begin(id) {
      // クエリは入れ子にできない。走っている最中は重ねない
      if (measuring) return
      const query = gl.createQuery()
      if (query === null) return
      pending.push({ query, id })
      measuring = true
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    },

    end() {
      if (!measuring) return
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      measuring = false
    },

    collect() {
      const out: { id: number; ms: number }[] = []
      // GPU の状態が乱れた区間の値は信用できない。まとめて捨てる
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i]!
        if (disjoint) {
          gl.deleteQuery(item.query)
          pending.splice(i, 1)
          dropped++
          continue
        }
        const ready = gl.getQueryParameter(
          item.query,
          gl.QUERY_RESULT_AVAILABLE,
        ) as boolean
        if (!ready) continue
        const nanoseconds = gl.getQueryParameter(item.query, gl.QUERY_RESULT) as number
        out.push({ id: item.id, ms: nanoseconds / 1e6 })
        gl.deleteQuery(item.query)
        pending.splice(i, 1)
      }
      return out
    },

    dispose() {
      for (const item of pending) gl.deleteQuery(item.query)
      pending.length = 0
    },
  }
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

    // WebGL2 は排出できる。node/WebGPU では false になる
    cpuSynchronous: true,

    createTimer() {
      return createWebGLTimer(gl)
    },
  }
}
