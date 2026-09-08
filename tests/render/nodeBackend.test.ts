import { describe, expect, it } from 'vitest'
import type { Renderer } from 'three/webgpu'
import { createNodeBackend } from '@render/pipeline/nodeBackend'

/**
 * node 経路のバックエンド。
 *
 * **`kind` から導いた値は検査を無力化する。**段 7 で `webglVersion` を
 * `kind === 'node-webgpu' ? 0 : 2` と書いて、「WebGL2 が取れているか」の
 * 検査が原理的に落ちなくなった記録がある（`docs/lessons.md`）。ここでは
 * 「`kind` が `node-webgl` でも生のコンテキストが無ければ 0」を固定して、
 * 言い換えに戻ったら落ちるようにする。
 *
 * 排出できるかどうかも同じ。**`kind` ではなく `gl` の有無で決まる。**
 */
interface FakeGl {
  finished: number
  reads: number
}

function fakeGl(version = 'WebGL 2.0 (OpenGL ES 3.0 Chromium)'): {
  gl: WebGL2RenderingContext
  log: FakeGl
} {
  const log: FakeGl = { finished: 0, reads: 0 }
  const gl = {
    VERSION: 0x1f02,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    getParameter: () => version,
    finish: () => {
      log.finished++
    },
    readPixels: () => {
      log.reads++
    },
  }
  return { gl: gl as unknown as WebGL2RenderingContext, log }
}

interface FakeRenderer {
  renderer: Renderer
  info: {
    autoReset: boolean
    resets: number
    render: { drawCalls: number; triangles: number }
    memory: { programs: number }
  }
  sizeCalls: number
}

function scripted(backend: object, width = 1920, height = 1080): FakeRenderer {
  const info = {
    autoReset: true,
    resets: 0,
    render: { drawCalls: 0, triangles: 0 },
    memory: { programs: 0 },
    reset() {
      info.resets++
    },
  }
  const state = { sizeCalls: 0 }
  const renderer = {
    backend,
    info,
    domElement: {} as HTMLCanvasElement,
    getDrawingBufferSize(target: { x: number; y: number }) {
      state.sizeCalls++
      target.x = width
      target.y = height
      return target
    },
  }
  return {
    renderer: renderer as unknown as Renderer,
    info: info as unknown as FakeRenderer['info'],
    get sizeCalls() {
      return state.sizeCalls
    },
  }
}

describe('node 経路のバックエンド', () => {
  it('WebGPU では生のコンテキストが無いので版が 0、排出もできない', () => {
    const fake = scripted({ isWebGPUBackend: true })
    const backend = createNodeBackend(fake.renderer)

    expect(backend.kind).toBe('node-webgpu')
    expect(backend.webglVersion).toBe(0)
    expect(backend.cpuSynchronous).toBe(false)
    // 呼んでも落ちない。何もしないだけ
    expect(() => backend.drain()).not.toThrow()
  })

  it('node/WebGL2 では `gl.VERSION` の実物を読み、排出もできる', () => {
    const { gl, log } = fakeGl()
    const fake = scripted({ gl })
    const backend = createNodeBackend(fake.renderer)

    expect(backend.kind).toBe('node-webgl')
    expect(backend.webglVersion).toBe(2)
    expect(backend.cpuSynchronous).toBe(true)

    backend.drain()
    // **`finish()` だけでは足りない。**読み戻しで排出させる（`bench.ts` の記録）
    expect(log.finished).toBe(1)
    expect(log.reads).toBe(1)
  })

  it('`kind` が node-webgl でもコンテキストが無ければ版は 0', () => {
    // **ここが言い換えの見張り。**`kind` から導くとこのケースが 2 になる
    const fake = scripted({})
    const backend = createNodeBackend(fake.renderer)

    expect(backend.kind).toBe('node-webgl')
    expect(backend.webglVersion).toBe(0)
    expect(backend.cpuSynchronous).toBe(false)
  })

  it('WebGL1 のコンテキストなら 1 を返す', () => {
    const { gl } = fakeGl('WebGL 1.0 (OpenGL ES 2.0 Chromium)')
    const backend = createNodeBackend(scripted({ gl }).renderer)
    expect(backend.webglVersion).toBe(1)
  })

  it('集計は自分で 0 に戻す', () => {
    // node 経路は `setAnimationLoop` を使ったときだけ three が戻す。
    // 自分で `render()` を回すと積算され続ける（段 9 で 9 倍になった）
    const fake = scripted({ isWebGPUBackend: true })
    const backend = createNodeBackend(fake.renderer)

    expect(fake.info.autoReset).toBe(false)
    expect(fake.info.resets).toBe(0)
    backend.resetInfo()
    expect(fake.info.resets).toBe(1)
  })

  it('投入の集計は node の名前から読む', () => {
    const fake = scripted({ isWebGPUBackend: true })
    const backend = createNodeBackend(fake.renderer)

    fake.info.render.drawCalls = 150
    fake.info.render.triangles = 438_000
    fake.info.memory.programs = 27
    // `info.render.calls` と `info.programs.length` は node 経路に無い
    expect(backend.drawCalls).toBe(150)
    expect(backend.triangles).toBe(438_000)
    expect(backend.programs).toBe(27)
  })

  it('描いている大きさは器を使い回して返す', () => {
    const fake = scripted({ isWebGPUBackend: true }, 1280, 720)
    const backend = createNodeBackend(fake.renderer)

    const first = backend.drawingBufferSize()
    expect(first).toEqual({ width: 1280, height: 720 })
    // 器を使い回す。呼ぶたびに作らない
    expect(backend.drawingBufferSize()).toBe(first)

    const mine: { width: number; height: number } = { width: 0, height: 0 }
    expect(backend.drawingBufferSize(mine)).toBe(mine)
    expect(mine).toEqual({ width: 1280, height: 720 })
  })

  it('GPU タイマーを作る口がある', () => {
    // 解決の口が無いレンダラでは測らない実体が返る（`nodeTimer` の判定）
    const backend = createNodeBackend(scripted({ isWebGPUBackend: true }).renderer)
    expect(backend.createTimer().supported).toBe(false)
  })
})
