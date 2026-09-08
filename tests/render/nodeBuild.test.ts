import { describe, expect, it } from 'vitest'
import type { Camera, Node, Renderer, Scene } from 'three/webgpu'
import { buildNodePipeline, type ShadowCaster } from '@render/pipeline/nodeBuild'

/**
 * node 経路の組み立ての順序。
 *
 * **順序を破っても例外は出ない。**3 つは実測で踏んでいる。
 * 照度を LUT の前に焼くと 3 成分とも 0 が返って地表が真っ黒になり、
 * `castShadow` を立てたまま組むと影のノードが 2 つできて落ち、雲のクアッドを
 * 別に組まないと 1 枚目にシェーダ生成が乗る（3,210.7 ms 対 987.0 ms）。
 *
 * どれも E2E では「絵が出ているか」「所要が下がったか」でしか見えない。
 * **順序そのものを数で固定する。**
 */
interface Log {
  calls: string[]
  /** `compileAsync` を呼んだ時点の影の状態 */
  duringCompile: { castShadow: boolean; autoUpdate: boolean } | null
}

function scripted(shadowLight: ShadowCaster | null): {
  log: Log
  renderer: Renderer
  scene: Scene
  camera: Camera
  outputNode: Node
  clouds: { compile(renderer: Renderer): Promise<void> }
  lutNode: { updateTextures(renderer: Renderer): Promise<unknown> }
} {
  const log: Log = { calls: [], duringCompile: null }
  const renderer = {
    async compileAsync() {
      log.calls.push('compileAsync')
      log.duringCompile =
        shadowLight === null
          ? null
          : { castShadow: shadowLight.castShadow, autoUpdate: shadowLight.shadow.autoUpdate }
    },
  }
  return {
    log,
    renderer: renderer as unknown as Renderer,
    scene: {} as Scene,
    camera: {} as Camera,
    outputNode: {} as Node,
    clouds: {
      async compile() {
        log.calls.push('clouds.compile')
      },
    },
    lutNode: {
      async updateTextures() {
        log.calls.push('lut.updateTextures')
        return undefined
      },
    },
  }
}

function caster(): ShadowCaster {
  return { castShadow: false, shadow: { autoUpdate: true, needsUpdate: false } }
}

describe('node 経路の組み立ての順序', () => {
  it('場面 → 雲 → LUT の順で組む', async () => {
    const light = caster()
    const s = scripted(light)
    const built = await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
      shadowLight: light,
      clouds: s.clouds,
      lutNode: s.lutNode,
    })

    // **LUT が最後。**先に呼ぶと照度が 0 になる
    expect(s.log.calls).toEqual(['compileAsync', 'clouds.compile', 'lut.updateTextures'])
    expect(built.pipeline.outputNode).toBe(s.outputNode)
  })

  it('組み立てのあいだ castShadow は伏せたまま', async () => {
    const light = caster()
    const s = scripted(light)
    await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
      shadowLight: light,
      clouds: s.clouds,
      lutNode: s.lutNode,
    })

    // 立ったまま組むと three の光の系が影のノードをもう 1 つ作る
    expect(s.log.duringCompile).toEqual({ castShadow: false, autoUpdate: false })
  })

  it('組み立てのあとで castShadow を立て、焼き直しを頼む', async () => {
    const light = caster()
    const s = scripted(light)
    await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
      shadowLight: light,
      clouds: s.clouds,
      lutNode: s.lutNode,
    })

    // **伏せたままでは影マップが焼かれない。**立てる側も要る
    expect(light.castShadow).toBe(true)
    expect(light.shadow.autoUpdate).toBe(true)
    expect(light.shadow.needsUpdate).toBe(true)
  })

  it('立ったまま渡されたら投げる', async () => {
    const light = caster()
    light.castShadow = true
    const s = scripted(light)
    await expect(
      buildNodePipeline({
        renderer: s.renderer,
        scene: s.scene,
        camera: s.camera,
        outputNode: s.outputNode,
        shadowLight: light,
      }),
    ).rejects.toThrow(/castShadow/)
    // 投げる前に何も組まない
    expect(s.log.calls).toEqual([])
  })

  it('影も雲も LUT も無い場面でも組める', async () => {
    const s = scripted(null)
    const built = await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
    })
    expect(s.log.calls).toEqual(['compileAsync'])
    expect(built.compileCloudsMs).toBeGreaterThanOrEqual(0)
    expect(built.lutMs).toBeGreaterThanOrEqual(0)
  })

  it('所要は 3 つの内訳と総和で返る', async () => {
    const light = caster()
    const s = scripted(light)
    const built = await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
      shadowLight: light,
      clouds: s.clouds,
      lutNode: s.lutNode,
    })
    for (const [name, value] of Object.entries({
      compileSceneMs: built.compileSceneMs,
      compileCloudsMs: built.compileCloudsMs,
      lutMs: built.lutMs,
      totalMs: built.totalMs,
    })) {
      expect(Number.isFinite(value), `${name} が ${value}`).toBe(true)
      expect(value, name).toBeGreaterThanOrEqual(0)
    }
    // 総和は内訳を下回らない
    expect(built.totalMs).toBeGreaterThanOrEqual(built.compileSceneMs)
  })
})
