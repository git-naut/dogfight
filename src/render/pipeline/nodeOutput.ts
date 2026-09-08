import type { Texture } from 'three'
import { Fn, pass } from 'three/tsl'
import type { Camera, Node, Scene } from 'three/webgpu'
import { overlayCompositeNode } from '../overlayNodes'

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
}

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

  return { composite, outputNode: input.smaa(composite) }
}
