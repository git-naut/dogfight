import * as THREE from 'three'
import type { AircraftSample } from '../sim/aircraft'
import type { LookOffset } from '../input/mouseLook'
import { createChaseCamera, type ChaseCamera } from './camera'
import { createAircraftView, type AircraftView } from './aircraftView'
import { createAtmosphere, DEFAULT_HOUR, type AtmosphereHandle } from './atmosphere'
import { createComposer, type ComposerHandle } from './composer'
import {
  applyQualityOverride,
  getQuality,
  type QualityOverride,
  type PresetName,
  type QualitySettings,
} from './quality'
import { createGpuTimer, type GpuTimer } from './gpuTimer'
import { generateCloudNoise, type CloudNoise } from './clouds/noise'
import { CloudsPass, SHADOW_EXTENT } from './clouds/cloudsPass'
import { cloudTime } from './clouds/geometry'
import {
  createTerrainMesh,
  createTerrainUniforms,
  type TerrainMesh,
} from './terrain/terrainMesh'
import { createWater, type Water } from './terrain/water'
import {
  createHeightTexture,
  createNormalTexture,
} from './terrain/heightTexture'
import { defaultTerrain, type Terrain, type TerrainStats } from '../sim/terrain'
import { FIXED_DT } from '../sim/loop'

/**
 * Phase 2 のシーン。
 *
 * 空は @takram/three-atmosphere による物理ベースの大気散乱。ライティングも
 * 大気の LUT から導かれるので、時刻を変えれば光の色と強さが一貫して変わる。
 *
 * 地面は起伏する地形と海面。高さ場は sim が持っていて、ここはそれを
 * テクスチャへ上げて頂点シェーダで引くだけ。
 */

/**
 * 大気ライブラリへ渡す地面のアルベド。
 *
 * 自前の地形と海面は 48 km と 300 km で切れるので、その先は大気ライブラリが
 * 持つ楕円体の地面が見える。島嶼と外洋の題材なので、境目が目立たないよう
 * 深い海の色に寄せる。
 */
const ATMOSPHERE_GROUND_ALBEDO = new THREE.Color(0x0a1c26)

export interface SceneHandle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  chase: ChaseCamera
  /** 太陽高度 rad。デバッグ表示と E2E の検証に使う */
  readonly sunElevation: number
  /**
   * 太陽光と天空光の放射輝度。
   *
   * 外に出しておく理由がある。ライブラリのコンストラクタ引数の名前違いで
   * 太陽光の色が白のまま固定されていたのを、この値を実測して見つけた。
   * E2E から読めれば「時刻を変えると色が変わる」を数値で検査できる。
   */
  readonly sunRadiance: THREE.Vector3
  readonly skyRadiance: THREE.Vector3
  /** 雲ノイズの生成にかかったミリ秒。性能の記録用 */
  readonly noiseMs: number
  /** 雲ノイズが空でないことの確認用 */
  readonly noiseStats: { min: number; max: number; mean: number }
  /** GPU のフレーム時間 ms。拡張が無ければ 0 */
  readonly gpuFrameMs: number
  /** 直近しばらくの GPU フレーム時間の最大 ms。予算の判断はこちらで行う */
  readonly gpuFrameMaxMs: number
  /** そのうち雲のパスが占める ms */
  readonly gpuCloudMs: number
  /** 雲のパスの直近の最大 ms */
  readonly gpuCloudMaxMs: number
  /** GPU 時間の計測が使えるか */
  readonly gpuTimerSupported: boolean
  /** 雲の密度サンプル数の統計。?probe=1 のときだけ意味を持つ */
  readCloudProbe(): { mean: number; max: number; p99: number }
  /** 雲のバッファが 16bit 浮動小数か。8bit だと横線が出る */
  readonly cloudHdrTarget: boolean
  /** 高さ場の生成にかかったミリ秒 */
  readonly terrainMs: number
  /** 高さ場の中身。min と max が同じなら生成に失敗している */
  readonly terrainStats: TerrainStats
  /** 描いている地形パッチの枚数と三角形数。予算の確認に使う */
  readonly terrainPatches: number
  readonly terrainTriangles: number
  readonly quality: QualitySettings
  /**
   * sim の状態を描画へ反映する。
   *
   * @param frame sim のフレーム番号。雲の流れをここから導くので実時間は渡さない
   */
  sync(
    sample: AircraftSample,
    frame: number,
    dt: number,
    look: LookOffset,
    snap?: boolean,
  ): void
  render(): void
  resize(width: number, height: number, devicePixelRatio: number): void
  setQuality(preset: PresetName): void
  setHour(hour: number): void
  setExposure(value: number): void
  dispose(): void
}

/**
 * トーンマッピングの露出。
 *
 * 大気ライブラリが返す相対輝度を表示域へ持ち上げる係数。1 のままだと真昼でも
 * 空の輝度が 255 中 62 にしかならない。5 から 40 まで振って絵で比べ、空に
 * 深みが残り地面の緑も飛ばない 6 を採った。経緯は
 * docs/decisions/0002-atmosphere-integration.md にある。
 */
export const DEFAULT_EXPOSURE = 6

/** 既定の雲量。点在する積雲になる値 */
export const DEFAULT_COVERAGE = 0.3

export interface SceneOptions {
  preset: PresetName
  hour?: number
  /** 雲量 0..1 */
  coverage?: number
  /** トーンマッピングの露出。調整用に上書きできる */
  exposure?: number
  /** 大気の LUT を置いた URL */
  texturesUrl: string
  /** プリセットの上書き。実機でつまみを振るときに使う */
  qualityOverride?: QualityOverride
  /** 雲バッファの持ち方の比較用。決着したら消す */
  /** 1 = 密度サンプル数、2 = 歩数を使い切ったか */
  cloudProbe?: number
  /** 時間方向の足し込みを使うか。比較用 */
  cloudTemporal?: boolean
  /** キャプチャモードか。雲の収束の重み付けが変わる */
  cloudCaptureMode?: boolean
  /** 地形と海面を描くか。GPU 時間の内訳を差分で測るための切り替え */
  showTerrain?: boolean
  showWater?: boolean
}

/**
 * シーンを組み立てる。
 *
 * 大気の LUT 読み込みが非同期なので Promise を返す。呼び出し側は await して
 * から描画ループを回すこと。待たずに描くとテクスチャのない絵になる。
 */
export async function createScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<SceneHandle> {
  const qualityOverride = options.qualityOverride ?? {}
  let quality = applyQualityOverride(getQuality(options.preset), qualityOverride)

  const renderer = new THREE.WebGLRenderer({
    canvas,
    // ポストプロセス側で SMAA をかけるので、ここでは無効にする
    antialias: false,
    powerPreference: 'high-performance',
  })
  // トーンマッピングは EffectComposer の最後段が持つ。ここでは二重に掛けない。
  //
  // ただし露出はレンダラ側の値がポスト側のシェーダへ渡る。大気ライブラリは
  // 輝度を「単位放射輝度の太陽の輝度」で正規化して返すので、空はその何桁も
  // 下の値になる。掛け直さないと真昼でも薄暗い絵にしかならない。
  renderer.toneMapping = THREE.NoToneMapping
  renderer.toneMappingExposure = options.exposure ?? DEFAULT_EXPOSURE

  const scene = new THREE.Scene()
  // near 0.5 / far 400,000 だと比が 80 万あり、地形が遠くまで伸びると遠景の
  // 稜線で z ファイティングが出る。追従カメラは機体の 23 m 後方にいるので
  // near 5 m で切れるものはない。far は地形 48 km と海面 300 km を覆えれば
  // 足りる。比が 4 万になり精度は 20 倍良くなる。
  //
  // 対数深度バッファは使えない。雲シェーダが標準の射影式で深度を線形化して
  // いるので、深度の分布を変えると壊れる
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 5, 200_000)
  const chase = createChaseCamera(camera)

  const atmosphere: AtmosphereHandle = await createAtmosphere(renderer, camera, {
    texturesUrl: options.texturesUrl,
    hour: options.hour ?? DEFAULT_HOUR,
    groundAlbedo: ATMOSPHERE_GROUND_ALBEDO,
  })

  scene.add(atmosphere.sky)
  scene.add(atmosphere.sunLight)
  scene.add(atmosphere.sunLight.target)
  scene.add(atmosphere.skyLight)

  // 雲のノイズを焼く。起動時の一度だけで、以降は使い回す
  const noise: CloudNoise = generateCloudNoise(renderer)

  // 地形。高さ場は sim が持つ。ここはテクスチャへ上げて頂点シェーダで引くだけ。
  // 生成時間は sim 層で測れない（performance.now() が使えない）のでここで挟む
  const terrainStart = performance.now()
  const terrain: Terrain = defaultTerrain()
  const terrainMs = performance.now() - terrainStart

  const heightTexture = createHeightTexture(terrain)
  const normalTexture = createNormalTexture(terrain)

  // 地形と海面でユニフォームを共有する。毎フレーム同じ値を 2 回書かない。
  // 雲影のテクスチャは CloudsPass を作ったあとで差し込む
  const terrainUniforms = createTerrainUniforms(terrain, SHADOW_EXTENT)
  terrainUniforms.heightMap.value = heightTexture
  terrainUniforms.terrainNormalMap.value = normalTexture

  const terrainMesh: TerrainMesh = createTerrainMesh(terrain, quality, terrainUniforms)
  terrainMesh.mesh.visible = options.showTerrain ?? true
  scene.add(terrainMesh.mesh)

  const water: Water = createWater(quality, terrainUniforms)
  water.mesh.visible = options.showWater ?? true
  scene.add(water.mesh)

  const aircraft: AircraftView = createAircraftView()
  scene.add(aircraft.object)

  const cloudsPass = new CloudsPass({
    camera,
    noise,
    quality,
    coverage: options.coverage ?? DEFAULT_COVERAGE,
    ...(options.cloudProbe !== undefined ? { probe: options.cloudProbe } : {}),
    ...(options.cloudTemporal !== undefined ? { temporal: options.cloudTemporal } : {}),
    ...(options.cloudCaptureMode !== undefined ? { captureMode: options.cloudCaptureMode } : {}),
  })
  // 雲を大気の合成点へ差し込む。合成の順序はライブラリ側が持つ
  atmosphere.setOverlay({ map: cloudsPass.texture })

  const composer: ComposerHandle = createComposer({
    renderer,
    scene,
    camera,
    aerialPerspective: atmosphere.effect,
    cloudsPass,
    quality,
  })

  terrainUniforms.cloudShadowMap.value = cloudsPass.shadowTexture

  const gpuTimer: GpuTimer = createGpuTimer(renderer)
  let measureClouds = false
  const shadowCenter = new THREE.Vector2()
  const cameraWorld = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  let cssWidth = 1280
  let cssHeight = 720
  let dpr = 1

  function applySize(): void {
    const ratio = Math.min(dpr, quality.maxPixelRatio) * quality.renderScale
    renderer.setPixelRatio(ratio)
    // composer が内部でレンダラのサイズも合わせる。CSS は stylesheet 任せ
    composer.setSize(cssWidth, cssHeight, false)
    camera.aspect = cssWidth / cssHeight
    camera.updateProjectionMatrix()
  }

  return {
    renderer,
    scene,
    camera,
    chase,

    get sunRadiance() {
      return atmosphere.sunRadiance
    },

    get skyRadiance() {
      return atmosphere.skyRadiance
    },

    get sunElevation() {
      return atmosphere.sunElevation
    },

    get noiseMs() {
      return noise.elapsedMs
    },

    get noiseStats() {
      return noise.stats
    },

    get gpuFrameMs() {
      return gpuTimer.lastMs
    },

    get gpuFrameMaxMs() {
      return gpuTimer.maxMs
    },

    get gpuCloudMs() {
      return cloudsPass.gpuMs
    },

    get gpuCloudMaxMs() {
      return cloudsPass.gpuMaxMs
    },

    get gpuTimerSupported() {
      return gpuTimer.supported
    },

    get cloudHdrTarget() {
      return cloudsPass.isHdrTarget
    },

    get terrainMs() {
      return terrainMs
    },

    get terrainStats() {
      return terrain.stats
    },

    get terrainPatches() {
      return terrainMesh.patchCount
    },

    get terrainTriangles() {
      return terrainMesh.triangleCount
    },

    readCloudProbe() {
      return cloudsPass.readProbe(renderer)
    },

    get quality() {
      return quality
    },

    sync(sample, frame, dt, look, snap = false) {
      aircraft.object.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      quaternion.set(
        sample.orientation.x,
        sample.orientation.y,
        sample.orientation.z,
        sample.orientation.w,
      )
      aircraft.object.quaternion.copy(quaternion)
      aircraft.setThrottle(sample.throttle)

      // 太陽光と天空光の基準位置を機体に合わせる。高度によって透過率が変わる。
      // ライト本体の位置は update() が太陽方向から決めるので触らない
      atmosphere.sunLight.target.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      atmosphere.skyLight.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      atmosphere.update()

      if (snap) chase.snap(sample, look)
      else chase.update(sample, dt, look)

      // 雲の流れは実時間ではなく sim のフレーム番号から導く。
      // これでキャプチャモードの絵が固定される
      shadowCenter.set(sample.position.x, sample.position.z)
      cloudsPass.update({
        cloudTime: cloudTime(frame, FIXED_DT),
        sunDirection: atmosphere.sunDirectionWorld,
        sunColor: atmosphere.sunRadiance,
        ambientColor: atmosphere.skyRadiance,
        coverage: options.coverage ?? DEFAULT_COVERAGE,
        shadowCenter,
        groundShadow: quality.cloudGroundShadow,
      })

      // 地形と海面が参照する雲影の領域も合わせる
      terrainUniforms.cloudShadowCenter.value.copy(shadowCenter)
      terrainUniforms.cloudShadowEnabled.value = quality.cloudGroundShadow ? 1 : 0

      // ライティングは自前で組む。MeshStandardMaterial を使わないので three の
      // ライトは効かない。大気ライブラリの放射輝度をそのまま渡す
      terrainUniforms.sunDirectionWorld.value.copy(atmosphere.sunDirectionWorld)
      terrainUniforms.sunRadiance.value.copy(atmosphere.sunRadiance)
      terrainUniforms.skyRadiance.value.copy(atmosphere.skyRadiance)

      // LOD はカメラ位置で決める。機体位置ではない（追従カメラは後方にいる）。
      // chase の更新後に読むこと
      camera.getWorldPosition(cameraWorld)
      terrainMesh.update(cameraWorld.x, cameraWorld.z)
      water.follow(cameraWorld.x, cameraWorld.z)
      // 波の位相もフレーム番号から導く。実時間を使うと絵が固定されない
      water.setWaveTime(cloudTime(frame, FIXED_DT))
    },

    render() {
      // TIME_ELAPSED クエリは入れ子にできない。フレーム全体と雲のパスを
      // 1 フレームおきに交互で測る。どちらも定常状態なので値は使える
      measureClouds = !measureClouds
      cloudsPass.setTimingEnabled(measureClouds)

      if (!measureClouds) gpuTimer.begin()
      // 雲影は地面を描く前に焼く。composer の中では手遅れになる
      cloudsPass.renderShadow(renderer)
      composer.render()
      if (!measureClouds) gpuTimer.end()
    },

    resize(width, height, devicePixelRatio) {
      cssWidth = width
      cssHeight = height
      dpr = devicePixelRatio
      applySize()
    },

    setQuality(preset) {
      quality = applyQualityOverride(getQuality(preset), qualityOverride)
      composer.setQuality(quality)
      cloudsPass.setQuality(quality)
      terrainMesh.setQuality(quality)
      water.setQuality(quality)
      applySize()
    },

    setHour(hour) {
      atmosphere.setHour(hour)
    },

    setExposure(value) {
      renderer.toneMappingExposure = value
    },

    dispose() {
      gpuTimer.dispose()
      aircraft.dispose()
      cloudsPass.dispose()
      noise.dispose()
      atmosphere.dispose()
      composer.dispose()
      terrainMesh.dispose()
      water.dispose()
      heightTexture.dispose()
      normalTexture.dispose()
      renderer.dispose()
    },
  }
}

