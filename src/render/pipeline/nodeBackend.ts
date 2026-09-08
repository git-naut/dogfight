import { Vector2 } from 'three'
import type { Renderer } from 'three/webgpu'
import type { DrawingBufferSize, RenderBackend } from '../backend'
import { createNodeTimer } from './nodeTimer'

/**
 * node 経路のバックエンド。
 *
 * `createWebGLBackend` と同じ契約を `WebGPURenderer` の API で満たす。
 * 対応は `backend.ts` の表のとおり。
 *
 * **`kind` から `webglVersion` を導いてはいけない。**導くと
 * 「`kind` が `node-webgl` なら 2」というただの言い換えになり、
 * 「WebGL2 が取れているか」の検査が原理的に落ちなくなる（段 7 で 1 度
 * 踏んだ形）。node/WebGL2 のバックエンドは生のコンテキストを
 * `backend.gl` に持っているので、そこから `gl.VERSION` の実物を読む。
 *
 * **WebGPU では排出できない。**`getContext()` が空実装で `gl.finish()` +
 * `readPixels` の手が使えないので、`cpuSynchronous` を false にする。
 * CPU 側の経過は投入までの時間しか測っていないので、掃引の判定が
 * それを見る（`benchUnreadable`）。node/WebGL2 では `gl` があるので
 * 排出できる。**ここも `kind` ではなく実物の有無で決める。**
 */
interface NodeBackendInternals {
  isWebGPUBackend?: boolean
  gl?: WebGL2RenderingContext | null
}

export function createNodeBackend(renderer: Renderer): RenderBackend {
  const internals = renderer.backend as unknown as NodeBackendInternals
  const isWebGPU = 'isWebGPUBackend' in internals
  const gl = internals.gl ?? null

  // 集計は自分で 0 に戻す。**node 経路は `setAnimationLoop` を使ったときだけ
  // `Animation.js` が `info.reset()` を呼ぶ**ので、自分で `render()` を回すと
  // `autoReset` が true のままでも積算され続ける（段 9 の実測で 9 倍になった）
  renderer.info.autoReset = false

  // 版は起動時に 1 度だけ読む。WebGPU では生のコンテキストが無いので 0
  const webglVersion =
    gl === null ? 0 : /WebGL 2/.test(gl.getParameter(gl.VERSION) as string) ? 2 : 1

  const pixel = new Uint8Array(4)
  const size: DrawingBufferSize = { width: 0, height: 0 }
  const scratch = new Vector2()

  return {
    kind: isWebGPU ? 'node-webgpu' : 'node-webgl',
    domElement: renderer.domElement,
    webglVersion,

    get drawCalls() {
      // **`calls` ではなく `drawCalls`。**node 経路は名前が違う
      return renderer.info.render.drawCalls
    },
    get triangles() {
      return renderer.info.render.triangles
    },
    get programs() {
      // **`programs.length` ではなく `memory.programs`。**数そのものが入る
      return renderer.info.memory.programs
    },

    resetInfo() {
      renderer.info.reset()
    },

    drawingBufferSize(out = size) {
      renderer.getDrawingBufferSize(scratch)
      out.width = scratch.x
      out.height = scratch.y
      return out
    },

    drain() {
      if (gl === null) return
      gl.finish()
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    },

    get cpuSynchronous() {
      return gl !== null
    },

    createTimer() {
      return createNodeTimer(renderer)
    },
  }
}
