import {
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { Pass } from 'postprocessing'
import cloudsFrag from './shaders/clouds.frag?raw'
import cloudShadowFrag from './shaders/cloudShadow.frag?raw'
import densityChunk from './shaders/density.glsl?raw'
import type { CloudNoise } from './noise'
import type { QualitySettings } from '../quality'
import { createGpuTimer, type GpuTimer } from '../gpuTimer'

/**
 * 雲のレイマーチを低解像度で走らせ、結果を大気エフェクトの overlay へ渡す。
 * あわせて地面へ落とす雲影のマップも焼く。
 *
 * 自前で合成しないのは、大気の in-scatter と透過の順序をライブラリ側が
 * 持っているため。overlay へ流し込めば
 * `outputColor.rgb * (1 - a) + rgb` の形で正しい位置に入る。
 *
 * このパスは入力バッファも出力バッファも触らない。自分のレンダーターゲットに
 * 描くだけなので needsSwap は false。
 */

// 密度の定義を本体と影で共有する。three の include 解決に載せる。
// ShaderChunk の型は組み込みの名前で固定されているのでキャストが要る
;(ShaderChunk as unknown as Record<string, string>)['cloud_density'] = densityChunk

const VERTEX_SHADER = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/** 雲影マップの一辺。地面に落ちる影なのでこの程度で足りる */
const SHADOW_SIZE = 256
/** 雲影マップが覆う世界の一辺 m */
export const SHADOW_EXTENT = 30_000

/**
 * 雲バッファの持ち方。
 *
 * 8bit だと放射輝度 0.02〜0.3 を 1/255 刻みで丸めることになり、露出 6 倍と
 * AGX がその段差を等高線として拡大する。16bit 浮動小数なら消えるが、
 * 実機での費用がまだ測れていない。既定は従来どおり 8bit にしておき、
 * ?buf=hdr で切り替えて計測する。
 */
export type CloudBuffer = 'u8' | 'hdr'

export interface CloudsPassOptions {
  camera: PerspectiveCamera
  noise: CloudNoise
  quality: QualitySettings
  /** 雲量 0..1 */
  coverage?: number
  buffer?: CloudBuffer
}

export interface CloudsUpdate {
  /** sim のフレーム番号から導いた秒。実時間を渡さないこと */
  cloudTime: number
  sunDirection: Vector3
  sunColor: Vector3
  ambientColor: Vector3
  coverage: number
  /** 雲影マップの中心。自機の真下あたりに置く */
  shadowCenter: Vector2
  /** 雲影を焼くか。プリセットで切る */
  groundShadow: boolean
}

export class CloudsPass extends Pass {
  private readonly cloudCamera: PerspectiveCamera
  private readonly target: WebGLRenderTarget
  private readonly shadowTarget: WebGLRenderTarget
  private readonly material: ShaderMaterial
  private readonly shadowMaterial: ShaderMaterial
  private readonly quad: { scene: Scene; camera: OrthographicCamera }
  private readonly shadowQuad: { scene: Scene; camera: OrthographicCamera }

  private quality: QualitySettings
  private width = 1
  private height = 1
  private groundShadow = true

  /**
   * このパスだけの GPU 時間。
   *
   * WebGL2 の TIME_ELAPSED クエリは入れ子にできないので、フレーム全体の
   * 計測とは交互に走らせる。どちらも定常状態なので交互でも値は使える。
   */
  private timer: GpuTimer | null = null
  private timingEnabled = false

  constructor(options: CloudsPassOptions) {
    super('CloudsPass')

    this.cloudCamera = options.camera
    this.quality = options.quality

    this.needsSwap = false
    // 地形より手前で打ち切るために深度が要る
    this.needsDepthTexture = true

    // 16bit 浮動小数で持つ。8bit にしてはいけない。
    //
    // ここに書くのはトーンマッピング前の放射輝度で、値は 0.02 から 0.3 の
    // あたりに寄る。8bit だと 1/255 刻みしかないので、この範囲を 5 から 75 の
    // 段階でしか表せない。そのあと露出 6 倍と AGX を通るので、段差が
    // そのまま等高線として拡大される。雲は輝度が高度と光学的厚みで滑らかに
    // 変わるので、等輝度線はおおむね水平になる。実機で見えていた横線は
    // これだった。
    //
    // 実測では、低空から雲底を見上げる構図で縦横の段差比が 1.635 から
    // 1.477 へ下がり、全解像度・256 ステップの参照品質（1.472）に並んだ。
    // 歩幅、ディザの振れ幅、ステップ数はどれも比を動かさなかった。
    const buffer = options.buffer ?? 'u8'
    this.target = new WebGLRenderTarget(1, 1, {
      format: RGBAFormat,
      type: buffer === 'hdr' ? HalfFloatType : UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    })

    this.shadowTarget = new WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    })

    // 密度に関わるユニフォームは両方のマテリアルで同じものを指す
    const sharedDensity = {
      shapeNoise: { value: options.noise.shape },
      detailNoise: { value: options.noise.detail },
      weatherMap: { value: options.noise.weather },
      cloudTime: { value: 0 },
      coverage: { value: options.coverage ?? 0.3 },
    }

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: cloudsFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...sharedDensity,
        sceneDepth: { value: null },
        inverseProjectionMatrix: { value: new Matrix4() },
        inverseViewMatrix: { value: new Matrix4() },
        cameraPositionWorld: { value: new Vector3() },
        cameraNear: { value: 0.5 },
        cameraFar: { value: 400_000 },
        sunDirection: { value: new Vector3(0, 1, 0) },
        sunColor: { value: new Vector3(1, 1, 1) },
        ambientColor: { value: new Vector3(0.1, 0.12, 0.15) },
        maxSteps: { value: options.quality.cloudMaxSteps },
        lightSteps: { value: options.quality.cloudLightSteps },
        useDetail: { value: options.quality.cloudDetail },
      },
    })

    this.shadowMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: cloudShadowFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...sharedDensity,
        shadowCenter: { value: new Vector2() },
        shadowExtent: { value: SHADOW_EXTENT },
        sunDirection: { value: new Vector3(0, 1, 0) },
      },
    })

    this.quad = createQuad(this.material)
    this.shadowQuad = createQuad(this.shadowMaterial)
  }

  /** このパスの GPU 時間 ms。計測できていなければ 0 */
  get gpuMs(): number {
    return this.timer?.lastMs ?? 0
  }

  /** フレーム全体の計測と交互に切り替える */
  setTimingEnabled(enabled: boolean): void {
    this.timingEnabled = enabled
  }

  /** 大気エフェクトへ渡すテクスチャ。overlay.map に入れる */
  get texture(): Texture {
    return this.target.texture
  }

  /**
   * 雲のバッファが 16bit 浮動小数か。
   *
   * 8bit へ戻すと等高線状の横線が復活する。スクリーンショット回帰では
   * 許容差 2% に埋もれて検出できなかったので、型そのものを検査する。
   */
  get isHdrTarget(): boolean {
    return this.target.texture.type === HalfFloatType
  }

  /** 地面シェーダが参照する雲影マップ */
  get shadowTexture(): Texture {
    return this.shadowTarget.texture
  }

  override setDepthTexture(depthTexture: Texture, depthPacking = 0): void {
    this.material.uniforms['sceneDepth']!.value = depthTexture
    void depthPacking
  }

  override setSize(width: number, height: number): void {
    this.width = width
    this.height = height
    const scale = this.quality.cloudResolutionScale
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    this.target.setSize(w, h)
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality
    this.material.uniforms['maxSteps']!.value = quality.cloudMaxSteps
    this.material.uniforms['lightSteps']!.value = quality.cloudLightSteps
    this.material.uniforms['useDetail']!.value = quality.cloudDetail
    this.setSize(this.width, this.height)
  }

  /** 毎フレーム呼ぶ。 */
  update(params: CloudsUpdate): void {
    const u = this.material.uniforms
    const s = this.shadowMaterial.uniforms

    for (const uniforms of [u, s]) {
      uniforms['cloudTime']!.value = params.cloudTime
      uniforms['coverage']!.value = params.coverage
      uniforms['sunDirection']!.value.copy(params.sunDirection)
    }

    u['sunColor']!.value.copy(params.sunColor)
    u['ambientColor']!.value.copy(params.ambientColor)
    s['shadowCenter']!.value.copy(params.shadowCenter)
    this.groundShadow = params.groundShadow
  }

  /**
   * 雲影マップを焼く。
   *
   * このパス自身の render() の中でやってはいけない。地面を描くのは前段の
   * RenderPass なので、後から焼いても反映は次のフレームになる。通常の
   * ループなら 1 フレームの遅れで済むが、キャプチャモードは 1 フレームしか
   * 描かないので永久に反映されない。実測でそうなった。
   *
   * 呼ぶのは composer.render() より前。
   */
  renderShadow(renderer: WebGLRenderer): void {
    if (!this.groundShadow) return
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.shadowTarget)
    renderer.render(this.shadowQuad.scene, this.shadowQuad.camera)
    renderer.setRenderTarget(previous)
  }

  override render(renderer: WebGLRenderer): void {
    if (this.timer === null) this.timer = createGpuTimer(renderer)
    const timing = this.timingEnabled && this.timer.supported
    if (timing) this.timer.begin()

    const camera = this.cloudCamera
    const u = this.material.uniforms

    camera.updateMatrixWorld()
    u['inverseProjectionMatrix']!.value.copy(camera.projectionMatrixInverse)
    u['inverseViewMatrix']!.value.copy(camera.matrixWorld)
    camera.getWorldPosition(u['cameraPositionWorld']!.value)
    u['cameraNear']!.value = camera.near
    u['cameraFar']!.value = camera.far

    renderer.setRenderTarget(this.target)
    renderer.render(this.quad.scene, this.quad.camera)

    if (timing) this.timer.end()
  }

  override dispose(): void {
    this.timer?.dispose()
    this.target.dispose()
    this.shadowTarget.dispose()
    this.material.dispose()
    this.shadowMaterial.dispose()
    disposeQuad(this.quad)
    disposeQuad(this.shadowQuad)
    super.dispose()
  }
}

function createQuad(material: ShaderMaterial): {
  scene: Scene
  camera: OrthographicCamera
} {
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  scene.add(new Mesh(new PlaneGeometry(2, 2), material))
  return { scene, camera }
}

function disposeQuad(quad: { scene: Scene }): void {
  for (const child of quad.scene.children) {
    if (child instanceof Mesh) child.geometry.dispose()
  }
}
