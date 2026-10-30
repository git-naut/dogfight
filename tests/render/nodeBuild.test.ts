import { describe, expect, it } from 'vitest'
import type { Camera, Node, Renderer, Scene } from 'three/webgpu'
import { buildNodePipeline, type ShadowCaster } from '@render/pipeline/nodeBuild'

/**
 * node 経路の組み立ての順序。
 *
 * **順序を破っても例外は出ない。**どれも実測で踏んでいる。
 * `castShadow` を立てたまま組むと影のノードが 2 つできて落ち、雲のクアッドを
 * 別に組まないと 1 枚目にシェーダ生成が乗る（3,210.7 ms 対 987.0 ms）。
 * takram の LUT を最後に作る順序は、段 S2b-2 で takram を外して消えた。
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
  }
}

function caster(): ShadowCaster {
  return { castShadow: false, shadow: { autoUpdate: true, needsUpdate: false } }
}

describe('node 経路の組み立ての順序', () => {
  it('場面を 1 度だけ組む', async () => {
    const light = caster()
    const s = scripted(light)
    const built = await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
      shadowLight: light,
    })

    // takram の LUT を最後に作る段は S2b-2 で、体積の雲のクアッドを別に組む段は
    // S4b で消えた（`nodeBuild.ts` の注記）
    expect(s.log.calls).toEqual(['compileAsync'])
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

  it('影の無い場面でも組める', async () => {
    const s = scripted(null)
    const built = await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
    })
    expect(s.log.calls).toEqual(['compileAsync'])
    expect(built.totalMs).toBeGreaterThanOrEqual(0)
  })

  it('所要は内訳と総和で返る', async () => {
    const light = caster()
    const s = scripted(light)
    const built = await buildNodePipeline({
      renderer: s.renderer,
      scene: s.scene,
      camera: s.camera,
      outputNode: s.outputNode,
      shadowLight: light,
    })
    for (const [name, value] of Object.entries({
      compileSceneMs: built.compileSceneMs,
      totalMs: built.totalMs,
    })) {
      expect(Number.isFinite(value), `${name} が ${value}`).toBe(true)
      expect(value, name).toBeGreaterThanOrEqual(0)
    }
    // 総和は内訳を下回らない
    expect(built.totalMs).toBeGreaterThanOrEqual(built.compileSceneMs)
  })
})
