import type { Texture } from 'three'
import { Fn, pass } from 'three/tsl'
import type { Camera, Node, Scene } from 'three/webgpu'
import { overlayCompositeNode } from '../overlayNodes'
import type { QualitySettings } from '../quality'

/**
 * node 経路の出力ノードを組む。
 *
 * 鎖は `pass(scene, camera)` → 雲の合成 → `smaa` → `renderOutput`。
 * 最後の `renderOutput` は `RenderPipeline._update` が足すので、ここでは
 * `smaa` までを組む。露出とトーンマッピングはレンダラの値から入る
 * （`ToneMappingNode` の露出は `rendererReference('toneMappingExposure')`
 * なので、GLSL 経路と同じ「レンダラに 6 を置く」形になる）。
 *
 * **場面のパスを雲より先に触る。**`updateBefore` の呼ばれる順はノードを
 * 辿った順で決まる（`NodeBuilder.addSequentialNode` が `setup()` の後に
 * 呼ばれるので子が先に並ぶ）。雲が先になると 1 フレーム前の深度で
 * 打ち切る。**絵には出ない**（深度テクスチャに前の中身が残るので、
 * 区画平均 16 個が 1 つも動かない）。見張るのは「雲を焼いた時点の描画
 * 呼び出しが 20 より多い」ことで、`frameCalls` は全画面クアッドのパスも
 * 数えるので使えない。
 *
 * **大気の呼び出しは `Else` の中に置く。**雲が完全不透明な画素で大気を
 * 計算しない早期打ち切りを GLSL 版から引き継ぐため。`.toVar()` で外に
 * 出すと稼ぎが消える。ここでは `overlayCompositeNode` の第 2 引数が
 * 遅延評価なので、参照は `Else` の中だけで起きる。
 */
type AtmosphereWebgpu = typeof import('@takram/three-atmosphere/webgpu')

/** `pass()` の戻り値のうち、ここで使う面だけ */
export interface ScenePassLike {
  getTextureNode(name?: string): Node<'vec4'>
  renderTarget: { depthTexture: Texture }
}

export interface ScenePassHandle {
  scenePass: ScenePassLike
  /**
   * 深度のテクスチャ。雲の材質へはこちらを渡す。
   *
   * **`pass.getTextureNode()` を自前の材質へ渡してはいけない。**その材質を
   * 焼くたびに `PassNode.updateBefore` が走って場面がもう 1 度描かれる
   */
  depthTexture: Texture
}

export function createScenePass(scene: Scene, camera: Camera): ScenePassHandle {
  const scenePass = pass(scene, camera) as unknown as ScenePassLike
  return { scenePass, depthTexture: scenePass.renderTarget.depthTexture }
}

export interface NodeOutputInput {
  atmos: AtmosphereWebgpu
  /** `three/examples/jsm/tsl/display/SMAANode.js` の `smaa` */
  smaa: (node: Node) => Node
  scenePass: ScenePassLike
  /** 雲の色。`CloudsNodePass.node` */
  cloudNode: Node<'vec4'>
  /**
   * 品質の設定。**鎖の段数がここで決まる。**
   *
   * プリセットが変わったら呼ぶ側が組み直す（`nodeScene.ts` の `buildOutput`）。
   * ポストの段を足すときは `quality.ts` の表に列を作ってからここへ渡す
   * （`CLAUDE.md` の規約）。
   */
  quality: QualitySettings
  /**
   * `three/examples/jsm/tsl/display/BloomNode.js` の `bloom`。
   *
   * **`nodeOutput.ts` で動的 import しない。**呼ぶ側が読んで渡す（`smaa` と
   * 同じ形）。SMAA は 53 KB の別チャンクになっていて、既定のバンドルに
   * 載せない方針をブルームにも当てる。
   */
  bloom?: BloomFactory
  /** ブルームの強さ。`quality.bloomStrength` を uniform で包んだもの */
  bloomStrength?: Node<'float'>
  /**
   * ブルームの閾値。**露出前の値。**
   *
   * `createNodeOutputNode` が組む鎖は `renderOutput` の内側に無いので、
   * ここを流れる値には露出が掛かっていない（`quality.ts` の
   * `bloomStrength` の注記に経緯）。空の線形値の最大は 0.1844。
   */
  bloomThreshold?: Node<'float'>
  /** ブルームを鎖に入れるか。`?bloom=0` で外す */
  showBloom?: boolean
  /**
   * 強さが 0 より大きいか。**呼ぶ側が決める。**
   *
   * `quality.bloomStrength` を直に見ない。`?bloomstrength=` の上書きが
   * あるので、どちらが効いているかを知っているのは呼ぶ側（`nodeScene.ts`）。
   * ここで表の値だけを見ると、low で上書きしても鎖に入らない
   */
  bloomActive?: boolean
}

/** `bloom(node, strength, radius, threshold)` の形だけ見る */
export type BloomFactory = (
  node: Node,
  strength: unknown,
  radius: unknown,
  threshold: unknown,
) => Node

export interface NodeOutput {
  /**
   * `smaa` を掛ける前の合成。
   *
   * **SMAA が効いているかは数で見る。**鎖に入れただけでは辺を拾って
   * いるかどうか分からないので、外して撮り直し、パスの数と絵の両方が
   * 動くことを確かめる。そのために外へ出す
   */
  composite: Node
  /** `smaa` まで掛けた出力。`RenderPipeline` へ渡す */
  outputNode: Node
}

export function createNodeOutputNode(input: NodeOutputInput): NodeOutput {
  const { atmos, scenePass, cloudNode } = input

  const composite = Fn(() => {
    // **ここで順が決まる。**場面のパスを雲より先に触る
    const sceneColor = scenePass.getTextureNode().toVar()
    const sceneDepth = scenePass.getTextureNode('depth')
    return overlayCompositeNode(cloudNode, () =>
      atmos.aerialPerspective(sceneColor as never, sceneDepth as never) as unknown as Node<'vec4'>,
    )
  })() as unknown as Node

  // **ブルームは SMAA より前。**HDR の値に掛ける。トーンマッピングの後ろへ
  // 回すと、AgX が潰したあとの階調からハイライトを探すことになる。
  //
  // **`quality.bloomStrength` が 0 なら鎖に入れない。**0 を渡しても
  // `BloomNode` は 5 段のガウシアンぼかしを焼く（`BloomNode.js` の
  // `_renderTargetsHorizontal` / `Vertical` が各 5 枚）。low で切る意味が
  // 費用の側にあるので、段そのものを外す。
  const bloomEnabled =
    input.bloom !== undefined && (input.showBloom ?? true) && (input.bloomActive ?? false)

  // **`bloom()` は成分だけを返す。足すのは呼ぶ側。**three の doc の例も
  // `renderPipeline.outputNode = scenePassColor.add( bloomPass )` の形。
  // 足さずに渡すと**元の絵が消えてぼかしたハイライトだけになる**（実測。
  // 全画面が最大 215 階調動いて、黒地に光る筋だけの絵が出た）
  const bloomed = bloomEnabled
    ? (composite as unknown as { add(n: Node): Node }).add(
        (input.bloom as BloomFactory)(
          composite,
          input.bloomStrength,
          BLOOM_RADIUS,
          input.bloomThreshold,
        ),
      )
    : composite

  return { composite, outputNode: input.smaa(bloomed) }
}

/**
 * ブルームのぼかしの広がり。
 *
 * `BloomNode` は 5 段のミップを `lerpBloomFactor(factor, radius)` で混ぜる。
 * 0 なら細かい段が強く出て輪郭のすぐ外だけが光り、1 なら粗い段が強く出て
 * 広く滲む。**強さと閾値とは独立に効く**ので、掃引では固定して 2 つだけ振る。
 */
const BLOOM_RADIUS = 0.35
