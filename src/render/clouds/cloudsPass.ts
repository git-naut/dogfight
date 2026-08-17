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
import cloudResolveFrag from './shaders/cloudResolve.frag?raw'
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

/**
 * 光マーチが太陽方向へ見る距離の、初歩に対する比。
 *
 * 初歩 40 m の 26.3 倍で約 1,050 m。積雲を横切るのに要る距離としてこの
 * あたりが妥当で、段数を変えてもここは保つ。
 */
const LIGHT_REACH_RATIO = 26.3

/**
 * 等比数列の和が LIGHT_REACH_RATIO になる公比を返す。
 *
 * 段数を減らしても太陽方向を見る距離が変わらないようにする。
 */
export function lightStepGrowth(steps: number): number {
  if (steps <= 1) return 1
  let low = 1.001
  let high = 64
  for (let i = 0; i < 40; i++) {
    const g = (low + high) / 2
    const sum = (Math.pow(g, steps) - 1) / (g - 1)
    if (sum < LIGHT_REACH_RATIO) low = g
    else high = g
  }
  return (low + high) / 2
}

/**
 * 履歴に現フレームを混ぜる割合。
 *
 * 小さいほど時間方向に長く均されて誤差が消えるが、動きに対する追従が遅れる。
 * 1/8 なら 8 フレーム、60fps で 0.13 秒で入れ替わる。
 */
const BLEND_WEIGHT = 0.125

/** ずらしの周期。この本数ぶんで一巡する */
const JITTER_PERIOD = 16

/**
 * キャプチャモードで収束させる本数。
 *
 * 通常のループは指数平均なので収束に十数フレームかかるが、キャプチャは
 * カメラが止まっているので 1/(n+1) の重みで真の平均を取れる。8 枚で
 * 8 標本の平均になり、それ以上増やしても絵はほとんど動かない。
 * 1 枚あたりの描画がソフトウェアレンダラでは重いので、本数は最小に抑える。
 */
export const CAPTURE_CONVERGE_FRAMES = 8

/**
 * 低食い違い列。Halton の 2 進と 3 進。
 *
 * 乱数でずらすと粗密ができて収束が遅い。等間隔だと格子が残る。
 */
function halton(index: number, base: number): number {
  let result = 0
  let f = 1 / base
  let i = index
  while (i > 0) {
    result += f * (i % base)
    i = Math.floor(i / base)
    f /= base
  }
  return result
}

/** マーチの上限距離 m。clouds.frag の MAX_MARCH_DISTANCE と揃える */
const MAX_MARCH_DISTANCE = 26_000
/** 手前の歩幅 m。clouds.frag の NEAR_STEP と揃える */
const NEAR_STEP = 45

/**
 * 歩幅の伸び率の尺度を歩数から解く。
 *
 * 歩幅を s(t) = NEAR_STEP * (1 + t / G) とすると、k 歩目の距離は
 * t(k) = G * (exp(NEAR_STEP * k / G) - 1) になる。t(maxSteps) が上限距離に
 * なる G を二分法で求める。これで到達距離が歩数から保証され、マーチが
 * 途中で止まらない。止まると位置がカメラの移動で前後し、遠くの雲が
 * 現れたり消えたりする。
 */
export function stepGrowthScale(maxSteps: number): number {
  let low = 10
  let high = 1e6
  for (let i = 0; i < 60; i++) {
    const g = (low + high) / 2
    const reach = g * (Math.exp((NEAR_STEP * maxSteps) / g) - 1)
    if (reach > MAX_MARCH_DISTANCE) low = g
    else high = g
  }
  return (low + high) / 2
}

/** 雲影マップの一辺。地面に落ちる影なのでこの程度で足りる */
const SHADOW_SIZE = 256
/** 雲影マップが覆う世界の一辺 m */
export const SHADOW_EXTENT = 30_000

export interface CloudsPassOptions {
  camera: PerspectiveCamera
  noise: CloudNoise
  quality: QualitySettings
  /** 雲量 0..1 */
  coverage?: number
  /** 1 = 密度サンプル数、2 = 歩数を使い切ったか。バッファは 8bit に固定される */
  probe?: number
  /** 時間方向の足し込みを使うか。比較用 */
  temporal?: boolean
  /** 近傍で挟む幅の倍率。動きの速い場面で履歴の尾を切る */
  clampScale?: number
  /** キャプチャモードか。収束の重み付けが変わる */
  captureMode?: boolean
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
  /**
   * 時間方向に足し込んだ結果。大気エフェクトはここを見続ける。
   *
   * ping-pong で書き先を入れ替えてはいけない。setOverlay はテクスチャの
   * 参照を一度しか受け取らないので、入れ替えると大気側が片方の古い
   * バッファを見続ける。実際にそれで蓄積がまったく効いていなかった。
   */
  private readonly output: WebGLRenderTarget
  /** 前フレームの結果。output からここへ写して次フレームで読む */
  private readonly history: WebGLRenderTarget
  private readonly resolveMaterial: ShaderMaterial
  private readonly copyMaterial: ShaderMaterial
  private readonly resolveQuad: { scene: Scene; camera: OrthographicCamera }
  private readonly copyQuad: { scene: Scene; camera: OrthographicCamera }
  private renderCount = 0
  /** サイズや品質が変わった直後は履歴を捨てる */
  private historyValid = false
  private readonly probeMode: boolean
  /** 時間方向の足し込みを使うか。比較用に切れる */
  private readonly temporal: boolean
  /** 近傍で挟む幅の倍率。0 なら挟まない */
  private readonly clampScale: number
  /** キャプチャモードか。収束の重み付けが変わる */
  private readonly captureMode: boolean
  private resolveCount = 0
  private readonly previousViewProjection = new Matrix4()
  private readonly previousCameraPosition = new Vector3()
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
    const probe = (options.probe ?? 0) > 0
    this.probeMode = probe
    this.temporal = options.temporal ?? true
    this.clampScale = options.clampScale ?? 0
    this.captureMode = options.captureMode ?? false
    this.target = new WebGLRenderTarget(1, 1, {
      format: RGBAFormat,
      // probe モードは整数を詰めるので 8bit にする
      type: probe ? UnsignedByteType : HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    })

    const historyOptions = {
      format: RGBAFormat,
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    } as const
    this.output = new WebGLRenderTarget(1, 1, historyOptions)
    this.history = new WebGLRenderTarget(1, 1, historyOptions)

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
        lightGrowth: { value: lightStepGrowth(options.quality.cloudLightSteps) },
        stepGrowthScale: { value: stepGrowthScale(options.quality.cloudMaxSteps) },
        useDetail: { value: options.quality.cloudDetail },
        probeMode: { value: options.probe ?? 0 },
        startJitter: { value: 0 },
        pixelJitter: { value: new Vector2() },
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

    this.resolveMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: cloudResolveFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        currentFrame: { value: null },
        historyFrame: { value: null },
        inverseProjectionMatrix: { value: new Matrix4() },
        inverseViewMatrix: { value: new Matrix4() },
        previousViewProjection: { value: new Matrix4() },
        cameraPositionWorld: { value: new Vector3() },
        previousCameraPosition: { value: new Vector3() },
        blendWeight: { value: 1 },
        texelSize: { value: new Vector2() },
        clampScale: { value: 0 },
      },
    })

    this.copyMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D source;
        in vec2 vUv;
        out vec4 fragColor;
        void main() { fragColor = texture(source, vUv); }
      `,
      depthTest: false,
      depthWrite: false,
      uniforms: { source: { value: null } },
    })

    this.quad = createQuad(this.material)
    this.shadowQuad = createQuad(this.shadowMaterial)
    this.resolveQuad = createQuad(this.resolveMaterial)
    this.copyQuad = createQuad(this.copyMaterial)
  }

  /** このパスの GPU 時間 ms。計測できていなければ 0 */
  get gpuMs(): number {
    return this.timer?.lastMs ?? 0
  }

  /** 直近しばらくの最大 ms。重い視点の費用はこちらで見る */
  get gpuMaxMs(): number {
    return this.timer?.maxMs ?? 0
  }

  /** フレーム全体の計測と交互に切り替える */
  setTimingEnabled(enabled: boolean): void {
    this.timingEnabled = enabled
  }

  /**
   * 大気エフェクトへ渡すテクスチャ。overlay.map に入れる。
   *
   * 時間方向に足し込んだ結果を返す。probe モードでは生のマーチ結果を返す
   * （実行量を数えるのに履歴が混ざっては困る）。
   */
  get texture(): Texture {
    return this.probeMode ? this.target.texture : this.output.texture
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

  /**
   * 密度サンプル数の統計を読み戻す。probe モードのときだけ意味を持つ。
   *
   * 計時はばらつきが大きく最適化の効果が埋もれるので、実行量そのものを
   * 数えて比べる。読み戻しは重いので計測時にしか呼ばない
   */
  readProbe(renderer: WebGLRenderer): { mean: number; max: number; p99: number } {
    const w = this.target.width
    const h = this.target.height
    const buffer = new Uint8Array(w * h * 4)
    renderer.readRenderTargetPixels(this.target, 0, 0, w, h, buffer)

    const counts = new Int32Array(w * h)
    let sum = 0
    let max = 0
    for (let i = 0; i < w * h; i++) {
      const c = buffer[i * 4]! * 256 + buffer[i * 4 + 1]!
      counts[i] = c
      sum += c
      if (c > max) max = c
    }
    counts.sort()
    return {
      mean: sum / (w * h),
      max,
      p99: counts[Math.floor((w * h - 1) * 0.99)] ?? 0,
    }
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
    this.output.setSize(w, h)
    this.history.setSize(w, h)
    this.resolveMaterial.uniforms['texelSize']!.value.set(1 / w, 1 / h)
    // 大きさが変わったら履歴は使えない
    this.historyValid = false
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality
    this.historyValid = false
    this.material.uniforms['maxSteps']!.value = quality.cloudMaxSteps
    this.material.uniforms['lightSteps']!.value = quality.cloudLightSteps
    this.material.uniforms['lightGrowth']!.value = lightStepGrowth(quality.cloudLightSteps)
    this.material.uniforms['stepGrowthScale']!.value = stepGrowthScale(quality.cloudMaxSteps)
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

    // フレームごとに誤差の出方をずらす。フレーム番号から決まるので
    // 実時間には依存しない
    const j = this.renderCount % JITTER_PERIOD
    u['startJitter']!.value = halton(j + 1, 2)
    u['pixelJitter']!.value.set(
      (halton(j + 1, 2) - 0.5) / this.target.width,
      (halton(j + 1, 3) - 0.5) / this.target.height,
    )
    this.renderCount++

    renderer.setRenderTarget(this.target)
    renderer.render(this.quad.scene, this.quad.camera)

    if (!this.probeMode) this.resolve(renderer, camera)

    if (timing) this.timer.end()
  }

  /**
   * 現フレームの結果を履歴へ足し込む。
   *
   * 前フレームの結果はそのまま重ねると機体の移動でずれるので、雲層との
   * 交点を使って前フレームの画面座標へ投影し直してから重ねる。
   */
  private resolve(renderer: WebGLRenderer, camera: PerspectiveCamera): void {
    const r = this.resolveMaterial.uniforms

    r['currentFrame']!.value = this.target.texture
    r['historyFrame']!.value = this.history.texture
    r['inverseProjectionMatrix']!.value.copy(camera.projectionMatrixInverse)
    r['inverseViewMatrix']!.value.copy(camera.matrixWorld)
    r['previousViewProjection']!.value.copy(this.previousViewProjection)
    r['cameraPositionWorld']!.value.copy(
      this.material.uniforms['cameraPositionWorld']!.value as Vector3,
    )
    r['previousCameraPosition']!.value.copy(this.previousCameraPosition)
    // キャプチャは 1/(n+1) で真の平均を取る。通常のループは指数平均で、
    // 動きに追従しつつ十数フレームで入れ替わる
    const weight = this.captureMode ? 1 / (this.resolveCount + 1) : BLEND_WEIGHT
    r['blendWeight']!.value = this.historyValid && this.temporal ? weight : 1
    r['clampScale']!.value = this.clampScale

    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.output)
    renderer.render(this.resolveQuad.scene, this.resolveQuad.camera)

    // 次フレームの読み元へ写す。出力先を入れ替えないための一手間
    this.copyMaterial.uniforms['source']!.value = this.output.texture
    renderer.setRenderTarget(this.history)
    renderer.render(this.copyQuad.scene, this.copyQuad.camera)
    renderer.setRenderTarget(previous)

    this.historyValid = true
    this.resolveCount++

    // 次フレームの再投影のために現フレームの行列を残す
    this.previousViewProjection
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse)
    camera.getWorldPosition(this.previousCameraPosition)
  }

  override dispose(): void {
    this.timer?.dispose()
    this.target.dispose()
    this.output.dispose()
    this.history.dispose()
    this.shadowTarget.dispose()
    this.material.dispose()
    this.shadowMaterial.dispose()
    this.resolveMaterial.dispose()
    this.copyMaterial.dispose()
    disposeQuad(this.quad)
    disposeQuad(this.shadowQuad)
    disposeQuad(this.resolveQuad)
    disposeQuad(this.copyQuad)
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
