import type { Camera, Node, Renderer, Scene } from 'three/webgpu'
import { RenderPipeline } from 'three/webgpu'

/**
 * node 経路のポストの鎖を組む。**順序がこの関数の中身。**
 *
 * 外せない順序が 3 つあり、どれも破っても例外が出ない形で壊れる。
 * どれも実測で踏んでいて `docs/lessons.md` に記録がある。
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
 *
 * 段 S2b-2 まで 4 つ目があった。takram の大気の LUT は `compileAsync` の
 * あとでなければ作れず、先に照度を焼くと地表が真っ黒になった。自前の空
 * （`sky/hillaireSky.ts`）は LUT を作ってから場面を組むので、この順序は消えた。
 *
 * **写しを 2 つ作らない。**プローブと本番の場面で同じ順序を 2 度書くと、
 * 片方だけ直したときに気づけない。順序を知っているのはここだけにする。
 */

/** 影の投げ手。`DirectionalLight` のうち、ここで触る面だけ見る */
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
   * 鎖が自前で `renderOutput` を挟んだか。
   *
   * **挟んだなら `outputColorTransform` を切る。**切らないとトーンマッピング
   * が 2 度掛かる。風圧の段（トーンマップ後に置く効果）が立つときだけ true
   */
  ownsOutputTransform?: boolean
  /**
   * 影の投げ手。**入ってくる時点で `castShadow` は false でなければ
   * ならない。**立っていたら投げる（黙って進むと落ちる場所が遠くなる）
   */
  shadowLight?: ShadowCaster | null
  /** 雲のパス。場面に入っていないので別に組む */
  clouds?: { compile(renderer: Renderer): Promise<void> } | null
}

export interface NodePipelineBuild {
  pipeline: RenderPipeline
  /** 場面の事前コンパイルにかかったミリ秒 */
  compileSceneMs: number
  /** 雲のクアッドの事前コンパイルにかかったミリ秒 */
  compileCloudsMs: number
  /** 上の 2 つを含む総和 */
  totalMs: number
}

export async function buildNodePipeline(
  input: NodePipelineBuildInput,
): Promise<NodePipelineBuild> {
  const { renderer, scene, camera, outputNode } = input
  const ownsOutputTransform = input.ownsOutputTransform ?? false
  const shadowLight = input.shadowLight ?? null
  const clouds = input.clouds ?? null

  if (shadowLight !== null && shadowLight.castShadow) {
    throw new Error(
      '組み立ての時点で castShadow が立っている。three の光の系が影のノードを' +
        'もう 1 つ作り、compileAsync の中で depthTexture が null のまま落ちる',
    )
  }

  const pipeline = new RenderPipeline(renderer, outputNode)

  // **鎖が自前で `renderOutput` を挟んだら、ここは切る。**
  //
  // 既定では `_updateContext` が `renderOutput(outputNode, ...)` で包む。
  // 風圧（放射ブラー・色収差・ビネット）はトーンマップの**後ろ**に置くので、
  // 鎖の側が先に挟んでいる。切らないと**トーンマッピングが 2 度掛かる。**
  // `RenderPipeline` の doc が FXAA を例に同じ形を説明している。
  if (ownsOutputTransform) pipeline.outputColorTransform = false

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

  return {
    pipeline,
    compileSceneMs,
    compileCloudsMs,
    totalMs: performance.now() - started,
  }
}

/**
 * ノードのフレーム番号を 1 つ進める。
 *
 * **手で `render()` を続けて回すと `FRAME` 型の更新が 1 度しか走らない。**
 * `NodeUpdateType.FRAME` の更新は `NodeFrame` が `frameId` で重複を潰す。
 * その `frameId` を進めるのは `Animation.js` の `nodeFrame.update()` で、rAF の
 * たびに 1 度だけ呼ばれる。**内部のループは `setAnimationLoop` を使わなくても
 * 初期化で必ず始まる**（`Renderer.js` の `init` の `this._animation.start()`）。
 * キャプチャは 1 つのタスクの中で rAF を挟まずに続けて描くので、その間は
 * 番号が進まない。
 *
 * **ライブでは番号が描画 1 回で 2 進む。**内部のループの 1 と、ここの 1。
 * どちらも害は無い（重複を潰すのに要るのは「前と違う」ことだけ）。段 S0a で
 * 実機の鍵を読んで確かめた（2026-10-25）。最初は「ライブでも進まない」と
 * 読み違えていた。
 *
 * 進めないと、場面の `PassNode` も雲のパスも 1 枚目しか描かれない。
 * **絵は出る。**レンダーターゲットに前の中身が残るので、2 枚目以降も同じ
 * 絵が返る。実測で 1 枚目が 167 描画呼び出し・39 パス・458,486 三角形、
 * 2 枚目以降が 2 呼び出し・2 パス・3 三角形だった（段 20a-2-3）。
 *
 * **`nodeFrame.update()` は呼ばない。**あれは `performance.now()` から
 * `deltaTime` と `time` を進めるので、実時間が描画へ入る。この repo は
 * それを禁じている（`CLAUDE.md` の決定論の規則）。番号だけ進める。
 *
 * **`info.frame` にも同じ番号を入れる**（段 S0a）。`Animation.js` は
 * `this.info.frame = this.nodes.nodeFrame.frameId` を rAF のたびに行う。
 * three の中でこれを読むのは GPU の timestamp の鍵（`Backend.js` の
 * `updateTimeStampUID` の `:f<フレーム>`）だけ。**キャプチャ**で入れないと、
 * 続けて描く N 枚が同じフレーム番号の鍵になり、パスごとの内訳が枚をまたいで
 * 混ざる。ライブは内部のループが入れているので、この 1 行が無くても混ざらない。
 * 絵には関わらない
 */
interface NodeFrameHolder {
  _nodes: { nodeFrame: { frameId: number } }
  info: { frame: number }
}

export function advanceNodeFrame(renderer: Renderer): void {
  const holder = renderer as unknown as NodeFrameHolder
  holder._nodes.nodeFrame.frameId++
  holder.info.frame = holder._nodes.nodeFrame.frameId
}
