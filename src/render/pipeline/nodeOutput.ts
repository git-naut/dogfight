import type { Texture } from 'three'
import { Fn, directionToColor, mix, mrt, normalView, output, pass, uv, vec2 } from 'three/tsl'
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
  setMRT?(mrt: unknown): unknown
  getMRT?(): unknown
}

export interface ScenePassOptions {
  /**
   * 場面のパスで法線も書き出すか（MRT の 2 本目、名前は `normal`）。
   *
   * **SSR の前提。**計画書は「SSR の実装コストのほぼ全部は海面が深度と法線を
   * 書いていないことにある」と書いている。深度は既に `depthTexture` がある
   * ので、足すのは法線だけ。書き出すだけで、読む側はまだ無い（段 27a）。
   *
   * 値は `directionToColor(normalView)`（視点空間の法線を 0..1 へ詰めたもの）。
   * three の SSR と GTAO の例と同じ形。既定は false で、false のあいだは
   * `setMRT` を呼ばない（書き出す面が増えると帯域を払うため）
   */
  normals?: boolean
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
  /** 法線のテクスチャのノード。`normals` を立てなければ null */
  normalNode: Node<'vec4'> | null
}

export function createScenePass(
  scene: Scene,
  camera: Camera,
  options: ScenePassOptions = {},
): ScenePassHandle {
  const scenePass = pass(scene, camera) as unknown as ScenePassLike
  let normalNode: Node<'vec4'> | null = null
  if (options.normals === true) {
    // **`RenderPipeline` を作る前に済ませる**（`nodeBuild.ts` の順序 1）。
    // ここは組み立ての最初に呼ばれるので、呼ぶ側に順序を任せなくてよい
    scenePass.setMRT!(mrt({ output, normal: directionToColor(normalView) }))
    normalNode = scenePass.getTextureNode('normal')
  }
  return { scenePass, depthTexture: scenePass.renderTarget.depthTexture, normalNode }
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

  /**
   * 風圧の演出。`radialBlur` と自前のビネット。
   *
   * **色収差は外した。**`chromaticAberration` は `convertToTexture` をもう
   * 1 回通すので、実機で GPU が 9.7 から 14.0 ms へ上がり FPS が 60 から
   * 53 へ落ちた（Intel Xe-2LPG）。絵の寄与は滲みと周辺減光に比べて小さい。
   *
   * **トーンマップの後ろに置く。**放射ブラーと色収差は表示域の色に掛けるのが
   * 本来で、HDR の線形値に掛けると暗部の滲みが出ない。そのため
   * `RenderPipeline.outputColorTransform` を切って、ここで `renderOutput` を
   * 自分で挟む（`RenderPipeline` の doc が FXAA を例に説明している形）。
   */
  lens?: LensEffects
  /** 荷重倍数の uniform。**1 G で 0 になる**ので水平飛行の絵は動かない */
  loadFactor?: Node<'float'>
  /** 風圧を鎖に入れるか。`?lens=0` で外す */
  showLens?: boolean
  /**
   * 風圧の鎖をどこまで組むか。`?lens=tone|blur`。
   *
   * **差分の帰属を測る口。**1 G では 3 つとも恒等になる設計なので、絵が
   * 動いたらどの段が動かしたのかを 1 つずつ切って見る。既定は全部。
   */
  lensStage?: LensStage
}

/** 風圧の鎖をどこまで組むか */
export type LensStage = 'tone' | 'blur' | 'full'

/** 風圧に使う three の関数。呼ぶ側が動的 import して渡す */
export interface LensEffects {
  radialBlur: (node: Node, options: Record<string, unknown>) => Node
  renderOutput: (color: Node, toneMapping?: unknown, colorSpace?: unknown) => Node
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
  /**
   * 鎖が自前で `renderOutput` を挟んだか。
   *
   * **`buildNodePipeline` へそのまま渡す。**呼ぶ側が条件を書き写すと、
   * 風圧の条件を直したときに片方だけ直して**トーンマッピングが 2 度掛かる**
   */
  ownsOutputTransform: boolean
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

  const antialiased = input.smaa(bloomed)

  // **風圧はトーンマップの後ろ。**放射ブラーと色収差は表示域の色に掛ける。
  // HDR の線形値に掛けると、暗部の滲みが出ないまま明部だけが暴れる。
  //
  // そのために `RenderPipeline.outputColorTransform` を切って、ここで
  // `renderOutput` を自分で挟む（`RenderPipeline` の doc が FXAA を例に
  // 説明している形）。**切り忘れるとトーンマッピングが 2 度掛かる。**
  const lensEnabled =
    input.lens !== undefined && (input.showLens ?? true) && input.quality.lensEffects

  if (!lensEnabled) return { composite, outputNode: antialiased, ownsOutputTransform: false }

  const { radialBlur, renderOutput } = input.lens as LensEffects
  const g = input.loadFactor as Node<'float'>

  // **1 G で 0 になる形にする。**水平飛行の絵を動かさないため。
  // `LENS_FULL_G` で 1 に届く。それ以上は伸ばさない（画面が読めなくなる）
  // **1 G ちょうどを閾値にしない。**水平飛行でも荷重倍数はトリムの残差で
  // 1.0000 にならず、`(g - 1) / 5` が 0.00002 のような値を返す。それでも
  // 絵は 1 階調動く（実測で 42 枚が 1.07%）。**効き始めを 1.5 G に上げて、
  // 巡航中は完全に 0 にする。**
  const amount = (g as unknown as { smoothstep(a: number, b: number): Node<'float'> }).smoothstep(
    LENS_START_G,
    LENS_FULL_G,
  )

  const stage: LensStage = input.lensStage ?? 'full'
  const toned = renderOutput(antialiased)
  if (stage === 'tone') return { composite, outputNode: toned, ownsOutputTransform: true }

  // **強さを `exposure` で振らない。`mix` で振る。**
  //
  // `exposure: 0` にすれば数式の上では恒等（`radialBlur.js` の最後が
  // `mix(blur, base.mul(2), 0.5)` なので blur が 0 なら base に戻る）。
  // だが `radialBlur` は先頭で `convertToTexture(textureNode)` を通す。
  // **入力が中間のテクスチャへ 1 度焼かれ、読み戻すときに量子化される。**
  // 実測で 1 G の絵が 42 枚とも 8% ・1 階調動いた。
  //
  // `exposure` は固定にして、混ぜ率を G で動かす。`mix(a, b, 0)` は
  // `a * 1 + b * 0` なので、b が有限なら a とビットまで一致する。
  //
  // **`mix` はメソッド形式で呼ばない。**`addMethodChaining('mix', mixElement)`
  // の `mixElement` は `(t, e1, e2) => mix(e1, e2, t)` なので、
  // `a.mix(b, c)` は `mix(b, c, a)` になる。**a が混ぜ率**になり、実測で
  // 全画面が 226 階調動いた。関数形式で書く
  const blurredRaw = radialBlur(toned, { exposure: LENS_BLUR_MAX, count: LENS_BLUR_SAMPLES })
  const blurred = blend(toned, blurredRaw, amount)

  if (stage === 'blur') return { composite, outputNode: blurred, ownsOutputTransform: true }

  return { composite, outputNode: vignette(blurred, amount), ownsOutputTransform: true }
}

/**
 * `a` と `b` を `t` で混ぜる。
 *
 * **`mix` はメソッド形式で呼ばない。**`addMethodChaining('mix', mixElement)`
 * の `mixElement` は `(t, e1, e2) => mix(e1, e2, t)` なので、`a.mix(b, c)` は
 * `mix(b, c, a)` になる。**a が混ぜ率**になり、実測で全画面が 226 階調動いた。
 *
 * `t = 0` のとき `a * 1 + b * 0` なので、b が有限なら a とビットまで一致する。
 */
function blend(a: Node, b: Node, t: Node<'float'>): Node {
  return (mix as unknown as (x: unknown, y: unknown, k: unknown) => Node)(a, b, t)
}

/**
 * 画面の四隅を暗くする。
 *
 * three に既製品が無いので自前。中心からの距離で `smoothstep` する。
 * **縦横比を打ち消さない。**横長の画面では横方向に伸びた楕円になるほうが
 * 自然に見える（レンズの口径食と同じ形）。
 */
function vignette(node: Node, amount: Node<'float'>): Node {
  const color = node as unknown as { mul(n: unknown): Node }
  const d = (uv() as unknown as { sub(v: unknown): { length(): Node<'float'> } })
    .sub(vec2(0.5, 0.5))
    .length()
  const fall = (d as unknown as { smoothstep(a: number, b: number): Node<'float'> })
    .smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER)
  const darken = (fall as unknown as { mul(n: unknown): { oneMinus(): Node<'float'> } })
    .mul(amount.mul(VIGNETTE_MAX))
    .oneMinus()
  return color.mul(darken)
}

/**
 * 演出が効き始める G。
 *
 * **1 G ちょうどにしない。**水平飛行でも荷重倍数は 1.0000 にならないので、
 * 閾値を 1 に置くと巡航中の絵が 1 階調動く。1.5 G は素直な旋回でも越える
 * 値なので、演出が出ない場面が増えるわけではない
 */
const LENS_START_G = 1.5

/** ここまで G が掛かると演出が最大になる。実機で振って決める */
const LENS_FULL_G = 6

/**
 * 放射ブラーのサンプル数。
 *
 * **実機で 24 は高すぎた。**`?lens=0` の GPU 8.0 ms に対して 14.4 ms、
 * FPS が 60 から 54 へ落ちた（Intel Xe-2LPG、`docs/measuring.md`）。
 * `radialBlur` は全画面をこの数だけ引くので、そのまま費用になる。
 *
 * three の doc は 16〜64 を勧めるが、下限より下げる。**帯が出るかは実測で
 * 見る**（`interleavedGradientNoise` でディザしているので 8 でも保つ）。
 */
const LENS_BLUR_SAMPLES = 8

/** 放射ブラーの `exposure` の上限。0 で無効、既定の 5 は強すぎる */
const LENS_BLUR_MAX = 0.22

/** ビネットの内側。ここまでは暗くしない（中心からの距離） */
const VIGNETTE_INNER = 0.18

/** ビネットの外側。ここで最大に暗くなる */
const VIGNETTE_OUTER = 0.75

/** ビネットの最大の暗さ。1 で真っ黒 */
const VIGNETTE_MAX = 0.72

/**
 * ブルームのぼかしの広がり。
 *
 * `BloomNode` は 5 段のミップを `lerpBloomFactor(factor, radius)` で混ぜる。
 * 0 なら細かい段が強く出て輪郭のすぐ外だけが光り、1 なら粗い段が強く出て
 * 広く滲む。**強さと閾値とは独立に効く**ので、掃引では固定して 2 つだけ振る。
 */
const BLOOM_RADIUS = 0.35
