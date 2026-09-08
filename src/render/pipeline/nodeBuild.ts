import type { Camera, Node, Renderer, Scene } from 'three/webgpu'
import { RenderPipeline } from 'three/webgpu'

/**
 * node 経路のポストの鎖を組む。**順序がこの関数の中身。**
 *
 * 外せない順序が 4 つあり、どれも破っても例外が出ない形で壊れる。
 * 3 つは実測で踏んでいて `docs/lessons.md` に記録がある。
 *
 * 1. `RenderPipeline` を作る前に `setMRT()` と `getTextureNode()` を
 *    済ませる（`PassNode.setup` の注記）。呼ぶ側が組み終えた
 *    `outputNode` を渡す形にして、ここでは受けるだけにしている。
 * 2. **`castShadow` は `compileAsync` のあとで立てる。**立ったまま組むと
 *    three の光の系が影のノードをもう 1 つ作り、その本体が生成されない
 *    まま `updateBefore` だけ残って `compileAsync` の中で落ちる。
 *    伏せたままでは影マップが焼かれないので、あとで立てる側も要る。
 * 3. **雲のクアッドは場面に入っていない。**`compileAsync(scene, camera)`
 *    は場面の物しか組まないので、別に組む（段 19。1 枚目 3,210.7 ms 対
 *    2 枚目 987.0 ms）。
 * 4. **大気の LUT の中身は組み立てのあとにできる。**`AtmosphereLUTNode`
 *    の `setup()` が走るのは `compileAsync` の中で、`updateTextures` は
 *    その後でなければ効かない。先に照度を焼くと 3 成分とも 0 が返り、
 *    例外は出ないまま地表が真っ黒になる。
 *
 * **写しを 2 つ作らない。**プローブと本番の場面で同じ順序を 2 度書くと、
 * 片方だけ直したときに気づけない。順序を知っているのはここだけにする。
 */

/** 影の投げ手。`DirectionalLight` と `AtmosphereLight` の共通部分だけ見る */
export interface ShadowCaster {
  castShadow: boolean
  shadow: { autoUpdate: boolean; needsUpdate: boolean }
}

export interface NodePipelineBuildInput {
  renderer: Renderer
  scene: Scene
  camera: Camera
  /** 組み終えた出力のノード。`smaa()` まで掛けたもの */
  outputNode: Node
  /**
   * 影の投げ手。**入ってくる時点で `castShadow` は false でなければ
   * ならない。**立っていたら投げる（黙って進むと落ちる場所が遠くなる）
   */
  shadowLight?: ShadowCaster | null
  /** 雲のパス。場面に入っていないので別に組む */
  clouds?: { compile(renderer: Renderer): Promise<void> } | null
  /** 大気の LUT。中身は組み立てのあとで作る */
  lutNode?: { updateTextures(renderer: Renderer): Promise<unknown> } | null
}

export interface NodePipelineBuild {
  pipeline: RenderPipeline
  /** 場面の事前コンパイルにかかったミリ秒 */
  compileSceneMs: number
  /** 雲のクアッドの事前コンパイルにかかったミリ秒 */
  compileCloudsMs: number
  /** 大気の LUT の計算にかかったミリ秒 */
  lutMs: number
  /** 上の 3 つを含む総和 */
  totalMs: number
}

export async function buildNodePipeline(
  input: NodePipelineBuildInput,
): Promise<NodePipelineBuild> {
  const { renderer, scene, camera, outputNode } = input
  const shadowLight = input.shadowLight ?? null
  const clouds = input.clouds ?? null
  const lutNode = input.lutNode ?? null

  if (shadowLight !== null && shadowLight.castShadow) {
    throw new Error(
      '組み立ての時点で castShadow が立っている。three の光の系が影のノードを' +
        'もう 1 つ作り、compileAsync の中で depthTexture が null のまま落ちる',
    )
  }

  const pipeline = new RenderPipeline(renderer, outputNode)

  const started = performance.now()

  // 影マップの焼き直しを組み立てのあいだ止める
  if (shadowLight !== null) shadowLight.shadow.autoUpdate = false
  await renderer.compileAsync(scene, camera)
  if (shadowLight !== null) {
    shadowLight.castShadow = true
    shadowLight.shadow.autoUpdate = true
    shadowLight.shadow.needsUpdate = true
  }
  const compileSceneMs = performance.now() - started

  const cloudsStarted = performance.now()
  if (clouds !== null) await clouds.compile(renderer)
  const compileCloudsMs = performance.now() - cloudsStarted

  const lutStarted = performance.now()
  if (lutNode !== null) await lutNode.updateTextures(renderer)
  const lutMs = performance.now() - lutStarted

  return {
    pipeline,
    compileSceneMs,
    compileCloudsMs,
    lutMs,
    totalMs: performance.now() - started,
  }
}
