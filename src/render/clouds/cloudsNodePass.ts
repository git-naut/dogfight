import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
} from 'three'
import {
  NodeMaterial,
  NodeUpdateType,
  TempNode,
  type Node,
  type NodeFrame,
  type Renderer,
} from 'three/webgpu'
import { float, int, texture, uniform, uv, vec2 } from 'three/tsl'
import { cloudMarchFragmentNode } from './marchNodes'
import { cloudResolveFragmentNode } from './resolveNodes'
import { cloudShadowFragmentNode } from './densityNodes'
import { SHADOW_SIZE, lightStepGrowth, stepGrowthScale } from './geometry'
import {
  BLEND_WEIGHT,
  JITTER_PERIOD,
  SHADOW_EXTENT,
  halton,
  type CloudsUpdate,
} from './cloudsPass'
import type { QualitySettings } from '../quality'

/**
 * 雲を node 経路で焼く。
 *
 * 断片シェーダは段 12〜13 で TSL へ移してある（`densityNodes` /
 * `marchNodes` / `resolveNodes`）。ここが持つのはその外側、つまり
 * レンダーターゲットと毎フレームのユニフォームと足し込みの順序。
 *
 * **`CloudsPass` の写しを作らない。**足し込みの重み、ずらしの周期、Halton の
 * 列、雲影の一辺は `cloudsPass.ts` と `geometry.ts` から読む。写しを 2 つ
 * 持つと、片方だけ直したときに検査が素通りする（段 16）。
 *
 * ## 場面のパスより後に走らせる
 *
 * マーチは地形より手前で打ち切るために場面の深度を読む。node 経路では
 * `pass(scene, camera)` が `updateBefore` で場面を焼くので、雲はその後に
 * 走らなければ 1 フレーム前の深度を読む。**`updateBefore` の呼ばれる順は
 * ノードを辿った順で決まる**（`NodeBuilder.addSequentialNode` は
 * `setup()` の後に呼ばれるので子が先）。出力の式で場面のテクスチャを雲より
 * 先に触ることで順を決めている。
 *
 * 順に頼るのは脆いので、走った時点の `info.render.frameCalls` を持ち帰る。
 * 場面のパスが先に走っていれば 1 以上になる。**式の順を入れ替えた瞬間に
 * 数で出る。**
 */

export interface CloudsNodeTextures {
  /** node 経路で焼いた形状ノイズ 64³ */
  shape: Texture
  /** node 経路で焼いたディテールノイズ */
  detail: Texture
  /** node 経路で焼いた気象マップ */
  weather: Texture
}

export interface CloudsNodePassOptions {
  camera: PerspectiveCamera
  noise: CloudsNodeTextures
  quality: QualitySettings
  /** 雲量 0..1 */
  coverage: number
  /** 場面の深度。`pass(scene, camera)` の深度テクスチャ */
  sceneDepth: Texture
  /** キャプチャモードか。足し込みの重み付けが変わる */
  captureMode: boolean
  /** 近傍で挟む幅の倍率。0 なら挟まない。**生成時に畳まれる** */
  clampScale: number
}

export interface CloudsNodePass {
  /**
   * 合成へ渡す雲。時間方向に足し込んだ結果。
   *
   * **書き先を入れ替えない。**合成のノードはテクスチャの参照を 1 度しか
   * 受け取らないので、ping-pong にすると片方の古いバッファを見続ける
   * （`CloudsPass` が同じ罠を記録している）
   */
  readonly node: Node<'vec4'>
  readonly texture: Texture
  /** 地形と海面が引く雲影マップ */
  readonly shadowTexture: Texture
  update(params: CloudsUpdate): void
  /**
   * 雲影マップを焼く。
   *
   * **合成の鎖の外で呼ぶ。**地面を描くのは場面のパスなので、鎖の中で
   * 焼くと反映が次のフレームになる。キャプチャモードは 1 枚しか描かない
   * ので永久に反映されない（`CloudsPass` の記録と同じ）
   */
  renderShadow(renderer: Renderer): void
  setSize(width: number, height: number): void
  /**
   * プリセットを当てる。
   *
   * **`cloudDetail` が変わると材質を組み直す。**`useDetail` は生成時に
   * 畳まれるので、ユニフォームでは切り替えられない
   */
  setQuality(quality: QualitySettings): void
  /**
   * マーチの断片シェーダの本文。
   *
   * **1 枚の絵では組み直しを確かめられない。**ずらしがフレームごとに動く
   * ので、同じ材質でも 2 枚は一致しない（実測で 328 バイト）。同じ
   * プリセットが同じ本文を出すかは文字列で見る
   */
  marchShaderSource(renderer: Renderer): Promise<string>
  /** 直前に焼いた時点の `frameCalls`。場面のパスが先なら 1 以上 */
  readonly frameCallsAtRun: number
  /**
   * 直前に焼いた時点の `drawCalls`。
   *
   * **`frameCalls` だけでは弱い。**全画面クアッドのパス（雲影や SMAA）も
   * 1 つずつ数えるので、場面のパスが走ったかどうかは出てこない。場面は
   * 機体と空母のメッシュぶんの描画呼び出しを投げるので、こちらで見る
   */
  readonly drawCallsAtRun: number
  /** 焼いた回数 */
  readonly renderCount: number
  dispose(): void
}

/** 全画面クアッド。材質ごとに 1 つ持つ */
function createQuad(material: NodeMaterial): {
  scene: Scene
  camera: OrthographicCamera
  mesh: Mesh
} {
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  scene.add(mesh)
  return { scene, camera, mesh }
}

/**
 * `NodeMaterial.fragmentNode` へ入れる。
 *
 * `@types/three` はこの枠を宣言していないので、逃げ口を 1 か所へ寄せる
 * （`clouds/volume.ts` と同じ理由）
 */
function fragmentMaterial(node: Node<'vec4'>): NodeMaterial {
  const material = new NodeMaterial()
  ;(material as unknown as { fragmentNode: unknown }).fragmentNode = node
  material.depthTest = false
  material.depthWrite = false
  return material
}

export function createCloudsNodePass(
  options: CloudsNodePassOptions,
): CloudsNodePass {
  const { camera, quality } = options

  // 16 ビット浮動小数で持つ。8 ビットにしてはいけない理由は `CloudsPass` の
  // 注記にある（放射輝度が 0.02〜0.3 に寄るので横線が出る）
  const floatOptions = {
    format: RGBAFormat,
    type: HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  } as const

  const marchTarget = new RenderTarget(1, 1, floatOptions)
  const output = new RenderTarget(1, 1, floatOptions)
  const history = new RenderTarget(1, 1, floatOptions)
  for (const t of [marchTarget, output, history]) {
    t.texture.minFilter = LinearFilter
    t.texture.magFilter = LinearFilter
    t.texture.generateMipmaps = false
  }

  const shadowTarget = new RenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  shadowTarget.texture.minFilter = LinearFilter
  shadowTarget.texture.magFilter = LinearFilter
  shadowTarget.texture.generateMipmaps = false

  // 密度に関わるユニフォームはマーチと雲影で同じものを指す。`CloudsPass` の
  // `sharedDensity` と同じ作り
  const cloudTime = uniform(0)
  const coverage = uniform(options.coverage)
  const sunDirection = uniform(new Vector3(0, 1, 0))

  const density = {
    shapeNoise: options.noise.shape,
    detailNoise: options.noise.detail,
    weatherMap: options.noise.weather,
    cloudTime: cloudTime as unknown as Node<'float'>,
    coverage: coverage as unknown as Node<'float'>,
  }

  const inverseProjectionMatrix = uniform(new Matrix4())
  const inverseViewMatrix = uniform(new Matrix4())
  const cameraPositionWorld = uniform(new Vector3())
  const cameraNear = uniform(camera.near)
  const cameraFar = uniform(camera.far)
  const sunColor = uniform(new Vector3(1, 1, 1))
  const ambientColor = uniform(new Vector3(0.1, 0.12, 0.15))
  const startJitter = uniform(0)
  const pixelJitter = uniform(new Vector2())
  const shadowCenter = uniform(new Vector2())

  // 足し込みのユニフォーム
  const previousViewProjection = uniform(new Matrix4())
  const blendWeight = uniform(1)
  const texelSize = uniform(new Vector2())

  // **深度は素の `texture()` で引く。**`pass.getTextureNode('depth')` を使うと
  // その材質の依存にパスのノードが入り、この材質を焼くたびに場面がもう 1 度
  // 描かれる。深度テクスチャは `isRenderTargetTexture` が立っているので、
  // v の裏返しは `TextureNode.setupUV()` が入れる（三の他の経路と同じ約束）
  const sceneDepthNode = texture(options.sceneDepth, uv()).r as unknown as Node<'float'>

  let quadQuality = quality
  let marchMaterial: NodeMaterial | null = null
  let marchQuad: ReturnType<typeof createQuad> | null = null

  /**
   * マーチの材質を組む。
   *
   * **`useDetail` は生成時に畳まれる**（`MarchInputs.useDetail` が JS の
   * boolean）。プリセットで切り替わるので、変わったら組み直す
   */
  function buildMarch(q: QualitySettings): void {
    marchMaterial?.dispose()
    const node = cloudMarchFragmentNode({
      ...density,
      sceneDepth: sceneDepthNode,
      inverseProjectionMatrix: inverseProjectionMatrix as unknown as Node<'mat4'>,
      inverseViewMatrix: inverseViewMatrix as unknown as Node<'mat4'>,
      cameraPositionWorld: cameraPositionWorld as unknown as Node<'vec3'>,
      cameraNear: cameraNear as unknown as Node<'float'>,
      cameraFar: cameraFar as unknown as Node<'float'>,
      sunDirection: sunDirection as unknown as Node<'vec3'>,
      sunColor: sunColor as unknown as Node<'vec3'>,
      ambientColor: ambientColor as unknown as Node<'vec3'>,
      maxSteps: int(q.cloudMaxSteps) as unknown as Node<'int'>,
      lightSteps: int(q.cloudLightSteps) as unknown as Node<'int'>,
      lightGrowth: float(lightStepGrowth(q.cloudLightSteps)) as unknown as Node<'float'>,
      maxMarchDistance: float(q.cloudMaxDistance) as unknown as Node<'float'>,
      stepGrowthScale: float(
        stepGrowthScale(q.cloudMaxSteps, q.cloudMaxDistance),
      ) as unknown as Node<'float'>,
      startJitter: startJitter as unknown as Node<'float'>,
      pixelJitter: pixelJitter as unknown as Node<'vec2'>,
      useDetail: q.cloudDetail,
    })
    marchMaterial = fragmentMaterial(node)
    if (marchQuad === null) marchQuad = createQuad(marchMaterial)
    else marchQuad.mesh.material = marchMaterial
  }

  buildMarch(quality)

  const resolveMaterial = fragmentMaterial(
    cloudResolveFragmentNode({
      currentFrame: marchTarget.texture,
      historyFrame: history.texture,
      inverseProjectionMatrix: inverseProjectionMatrix as unknown as Node<'mat4'>,
      inverseViewMatrix: inverseViewMatrix as unknown as Node<'mat4'>,
      previousViewProjection: previousViewProjection as unknown as Node<'mat4'>,
      cameraPositionWorld: cameraPositionWorld as unknown as Node<'vec3'>,
      blendWeight: blendWeight as unknown as Node<'float'>,
      texelSize: texelSize as unknown as Node<'vec2'>,
      clampScale: options.clampScale,
    }),
  )
  const resolveQuad = createQuad(resolveMaterial)

  // 履歴へ写す。**焼き先を入れ替えないので写しが要る**
  const copyMaterial = fragmentMaterial(
    texture(output.texture, vec2(uv().x, float(1).sub(uv().y))) as unknown as Node<'vec4'>,
  )
  const copyQuad = createQuad(copyMaterial)

  const shadowMaterial = fragmentMaterial(
    cloudShadowFragmentNode(
      density,
      uv(),
      shadowCenter as unknown as Node<'vec2'>,
      float(SHADOW_EXTENT) as unknown as Node<'float'>,
      sunDirection as unknown as Node<'vec3'>,
    ),
  )
  const shadowQuad = createQuad(shadowMaterial)

  /**
   * 雲を焼いてから雲のテクスチャを返すノード。
   *
   * **`updateBefore` で焼く。**three 自身が入れ子の描画をここでやっている
   * （`PassNode` が場面を焼く）。`update` は束縛の更新中に走るので、入れ子の
   * 描画が安全だという裏取りがない
   */
  class CloudsRenderNode extends TempNode<'vec4'> {
    constructor() {
      super('vec4')
      this.updateBeforeType = NodeUpdateType.FRAME
    }

    override updateBefore(frame: NodeFrame): undefined {
      render(frame.renderer as unknown as Renderer)
      return undefined
    }

    override setup(): Node<'vec4'> {
      // 焼くときは `uv()` で書いたので、引くときは v を裏返す
      // （`resolveNodes.ts` の `sampleTarget` と同じ約束）
      return texture(
        output.texture,
        vec2(uv().x, float(1).sub(uv().y)),
      ) as unknown as Node<'vec4'>
    }
  }

  const cloudNode = new CloudsRenderNode() as unknown as Node<'vec4'>

  let width = 1
  let height = 1
  let historyValid = false
  let renderCount = 0
  let resolveCount = 0
  let groundShadow = true
  let frameCallsAtRun = -1
  let drawCallsAtRun = -1
  const viewProjection = new Matrix4()

  function setSize(w: number, h: number): void {
    width = w
    height = h
    const scale = quadQuality.cloudResolutionScale
    const tw = Math.max(1, Math.round(w * scale))
    const th = Math.max(1, Math.round(h * scale))
    marchTarget.setSize(tw, th)
    output.setSize(tw, th)
    history.setSize(tw, th)
    texelSize.value.set(1 / tw, 1 / th)
    // 大きさが変わったら履歴は使えない
    historyValid = false
    resolveCount = 0
  }

  function draw(
    renderer: Renderer,
    quad: { scene: Scene; camera: OrthographicCamera },
    target: RenderTarget | null,
  ): void {
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    renderer.render(quad.scene, quad.camera)
    renderer.setRenderTarget(previous)
  }

  /** 雲を 1 枚焼く。合成の鎖の中から呼ばれる */
  function render(renderer: Renderer): void {
    frameCallsAtRun = renderer.info.render.frameCalls
    drawCallsAtRun = renderer.info.render.drawCalls

    camera.updateMatrixWorld()
    inverseProjectionMatrix.value.copy(camera.projectionMatrixInverse)
    inverseViewMatrix.value.copy(camera.matrixWorld)
    camera.getWorldPosition(cameraPositionWorld.value)
    cameraNear.value = camera.near
    cameraFar.value = camera.far

    // フレームごとに誤差の出方をずらす。フレーム番号から決まるので実時間に
    // 依存しない。列は `cloudsPass.ts` の `halton` をそのまま読む
    const j = renderCount % JITTER_PERIOD
    startJitter.value = halton(j + 1, 2)
    pixelJitter.value.set(
      (halton(j + 1, 2) - 0.5) / marchTarget.width,
      (halton(j + 1, 3) - 0.5) / marchTarget.height,
    )
    renderCount++

    draw(renderer, marchQuad!, marchTarget)

    // キャプチャは 1/(n+1) で真の平均を取る。通常のループは指数平均
    blendWeight.value = historyValid
      ? options.captureMode
        ? 1 / (resolveCount + 1)
        : BLEND_WEIGHT
      : 1
    draw(renderer, resolveQuad, output)
    resolveCount++

    draw(renderer, copyQuad, history)
    historyValid = true

    viewProjection
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse)
    previousViewProjection.value.copy(viewProjection)
  }

  return {
    node: cloudNode,
    get texture() {
      return output.texture
    },
    get shadowTexture() {
      return shadowTarget.texture
    },
    get frameCallsAtRun() {
      return frameCallsAtRun
    },
    get drawCallsAtRun() {
      return drawCallsAtRun
    },
    get renderCount() {
      return renderCount
    },

    update(params: CloudsUpdate) {
      cloudTime.value = params.cloudTime
      coverage.value = params.coverage
      sunDirection.value.copy(params.sunDirection)
      sunColor.value.copy(params.sunColor)
      ambientColor.value.copy(params.ambientColor)
      shadowCenter.value.copy(params.shadowCenter)
      groundShadow = params.groundShadow
    },

    renderShadow(renderer: Renderer) {
      if (!groundShadow) return
      draw(renderer, shadowQuad, shadowTarget)
    },

    setSize,

    async marchShaderSource(renderer: Renderer) {
      const shader = await renderer.debug.getShaderAsync(
        marchQuad!.scene,
        marchQuad!.camera,
        marchQuad!.mesh,
      )
      return shader.fragmentShader ?? ''
    },

    setQuality(next: QualitySettings) {
      quadQuality = next
      buildMarch(next)
      setSize(width, height)
    },

    dispose() {
      marchTarget.dispose()
      output.dispose()
      history.dispose()
      shadowTarget.dispose()
      marchMaterial?.dispose()
      resolveMaterial.dispose()
      copyMaterial.dispose()
      shadowMaterial.dispose()
      for (const q of [marchQuad, resolveQuad, copyQuad, shadowQuad]) {
        if (q !== null) (q.mesh.geometry as PlaneGeometry).dispose()
      }
    },
  }
}
