import { renderToneProbe } from '../toneProbe'
import { renderOverlayProbe } from '../overlayProbe'
import {
  createSurfaceProbeShadowTexture,
  renderTerrainSurfaceProbe,
  renderWaterSurfaceProbe,
} from '../terrain/surfaceProbeGl'
import { WATER_PROBE_REGIONS } from '../terrain/surfaceProbe'
import { renderSpriteProbe } from '../weapons/spriteProbe'
import * as THREE from 'three'
import { createChaseCamera } from '../camera'
import { createSceneViews } from './views'
import { createWebGLBackend } from '../backend'
import { createAtmosphere, DEFAULT_HOUR, type AtmosphereHandle } from '../atmosphere'
import { createComposer, type ComposerHandle } from '../composer'
import {
  applyQualityOverride,
  getQuality,
  type PresetName,
  PRESET_ORDER,
} from '../quality'
import { createGpuTimer, type GpuTimer } from '../gpuTimer'
import { createEnvironmentProbe, type EnvironmentProbe } from '../environment'
import {
  createAircraftShadow,
  type AircraftShadow,
  type ShadowLight,
} from '../aircraftShadow'
import { generateCloudNoise, type CloudNoise } from '../clouds/noise'
import { CloudsPass, SHADOW_EXTENT } from '../clouds/cloudsPass'
import {
  createTerrainMesh,
  createTerrainUniforms,
  type TerrainMesh,
} from '../terrain/terrainMesh'
import { createWater, type Water } from '../terrain/water'
import { createHeightTexture, createNormalTexture } from '../terrain/heightTexture'
import { defaultTerrain, type Terrain } from '../../sim/terrain'
import {
  DEFAULT_COVERAGE,
  DEFAULT_EXPOSURE,
  type ScenePipeline,
  type SceneOptions,
} from './types'

/**
 * WebGL2 でパイプラインを組む。
 *
 * **段 15 まではこれが唯一の実装。**`pipeline/node.ts` が同じ `ScenePipeline`
 * を WebGPU と TSL で組めるようになった時点で、`scene.ts` の帳簿は 1 行も
 * 動かさずに差し替わる。
 *
 * **組み立ての順番を変えないこと。**three の描画順は、不透明が
 * `groupOrder → renderOrder → material.id → z → object.id`、半透明が
 * `groupOrder → renderOrder → z の降順 → object.id` で決まる
 * （`three/src/renderers/webgl/WebGLRenderLists.js:1-49`）。`material.id` も
 * `object.id` も生成のたびに 1 つ増える大域の連番なので（`Material.js:43`、
 * `Object3D.js:89`）、**生成の順番を入れ替えると描画順が変わる。**
 * とくに不透明では深度より材質の連番が先に効くため、前後関係に関係なく
 * 絵が動きうる。基準画像 42 枚がそれを見張っている。
 */

/**
 * 大気ライブラリへ渡す地面のアルベド。
 *
 * 自前の地形と海面は 48 km と 300 km で切れるので、その先は大気ライブラリが
 * 持つ楕円体の地面が見える。島嶼と外洋の題材なので、境目が目立たないよう
 * 深い海の色に寄せる。
 */
const ATMOSPHERE_GROUND_ALBEDO = new THREE.Color(0x0a1c26)

/**
 * シーンを組み立てる。
 *
 * 大気の LUT 読み込みが非同期なので Promise を返す。呼び出し側は await して
 * から描画ループを回すこと。待たずに描くとテクスチャのない絵になる。
 */
export async function createWebGLPipeline(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<ScenePipeline> {
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

  // 統計を自動で消させない。既定では renderer.render() ごとに 0 へ戻るので、
  // 最後のポストパスだけが残って「ドローコール 1」に見える。フレームの頭で
  // 自分で消して、合計を読む。`createWebGLBackend` が `autoReset` を落とす
  const backend = createWebGLBackend(renderer)

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
  const noise: CloudNoise = generateCloudNoise(renderer, () => backend.drain())

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

  // 場面に置く物のうち、バックエンドに依存しない部分。**写しを 2 つ
  // 作らない**ために `views.ts` が持つ（段 20a-2-2）
  const views = await createSceneViews({ scene, quality, options })
  const {
    aircraft,
    targetViews,
    enemyViews,
    tracers,
    missileViews,
    missileSmoke,
    damageSmoke,
    explosions,
    flares,
    trails,
  } = views

  const aircraftShadow: AircraftShadow = createAircraftShadow({
    renderer,
    light: atmosphere.sunLight as ShadowLight,
    caster: aircraft.object,
    quality,
  })
  terrainUniforms.aircraftShadowMatrix.value = aircraftShadow.matrix

  // 環境反射を空から焼く。機体を追加したあとに作ると、焼くあいだに機体を
  // 隠す処理が効く（自分の映り込みを取り込まないため）
  const environment: EnvironmentProbe = createEnvironmentProbe({
    renderer,
    scene,
    sky: atmosphere.sky,
    quality,
  })
  scene.environment = (options.showEnvironment ?? true) ? environment.texture : null

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

  const gpuTimer: GpuTimer = createGpuTimer(backend)


  /** 雲のパスを描いているか。計測で切ったときは影の焼き込みも止める */
  let cloudsEnabled = true
  const shadowAllowed = options.showAircraftShadow ?? true
  /** 計測で影を切っているか。setMeasureConfig から動かす */
  let measureShadow = true
  /**
   * カメラのワールド位置。
   *
   * LOD の判定に使う。**機体位置ではない**（追従カメラは後方にいる）。
   * 帳簿が `updateCameraWorld()` で取り直し、地形とビューがこれを読む
   */
  const cameraWorld = new THREE.Vector3()

  /** 影のユニフォームを入れ直す。描画のたびに呼ぶ */
  function updateShadowUniforms(): void {
    // 型を合わせるため、切っているときも深度テクスチャを束縛したままにする
    terrainUniforms.aircraftShadowMap.value = aircraftShadow.depthTexture
    terrainUniforms.aircraftShadowEnabled.value =
      shadowAllowed && measureShadow && aircraftShadow.ready ? 1 : 0
    terrainUniforms.aircraftShadowTexel.value =
      1 / Math.max(1, quality.aircraftShadowMapSize)
  }
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

  /**
   * 内側の計測を挟まずに 1 枚描く。
   *
   * ハンドルの外に置いてあるのは `compileAllPresets` が呼ぶため
   */
  function renderPlainImpl(): void {
    backend.resetInfo()
    updateShadowUniforms()
    // 雲を切っているときは影も焼かない。切った意味がなくなる
    if (cloudsEnabled) cloudsPass.renderShadow(renderer)
    composer.render()
  }

  /**
   * 品質プリセットを当てる。
   *
   * ハンドルの外に置いてあるのは `compileAllPresets` が呼ぶため。
   * メソッドどうしを `this` で呼ぶと、オブジェクトリテラルの推論が
   * `ScenePipeline | PromiseLike<ScenePipeline>` になって型が付かない
   */
  function applyPreset(preset: PresetName): void {
    quality = applyQualityOverride(getQuality(preset), qualityOverride)
    composer.setQuality(quality)
    cloudsPass.setQuality(quality)
    terrainMesh.setQuality(quality)
    water.setQuality(quality)
    trails.setQuality(quality)
    missileSmoke.setQuality(quality)
    damageSmoke.setQuality(quality)
    explosions.setQuality(quality)
    environment.setQuality(quality)
    scene.environment = environment.texture
    aircraftShadow.setQuality(quality)
    applySize()
  }

  return {
    backend,
    scene,
    camera,
    chase,

    terrain,
    terrainMesh,
    water,
    aircraft,
    targetViews,
    enemyViews,
    tracers,
    missileViews,
    missileSmoke,
    damageSmoke,
    explosions,
    flares,
    trails,

    get sunElevation() {
      return atmosphere.sunElevation
    },

    get sunRadiance() {
      return atmosphere.sunRadiance
    },

    get skyRadiance() {
      return atmosphere.skyRadiance
    },

    get sunDirectionWorld() {
      return atmosphere.sunDirectionWorld
    },

    setLightAnchor(x, y, z) {
      atmosphere.sunLight.target.position.set(x, y, z)
      atmosphere.skyLight.position.set(x, y, z)
    },

    updateAtmosphere() {
      atmosphere.update()
    },

    setSurfaceFrame(frame) {
      // 地形と海面が参照する雲影の領域
      terrainUniforms.cloudShadowCenter.value.copy(frame.cloudShadowCenter)
      terrainUniforms.cloudShadowEnabled.value = frame.cloudShadowEnabled ? 1 : 0
      // ライティングは自前で組む。`MeshStandardMaterial` を使わないので
      // three のライトは効かない。大気の放射輝度をそのまま渡す
      terrainUniforms.sunDirectionWorld.value.copy(frame.sunDirectionWorld)
      terrainUniforms.sunRadiance.value.copy(frame.sunRadiance)
      terrainUniforms.skyRadiance.value.copy(frame.skyRadiance)
      // **影を焼くパスでも主カメラの位置を使う**ため、組み込みの
      // `cameraPosition` ではなくこれを渡す
      terrainUniforms.morphOrigin.value.copy(frame.morphOrigin)
    },

    updateClouds(update) {
      cloudsPass.update(update)
    },

    get noiseMs() {
      return noise.elapsedMs
    },

    get noiseStats() {
      return noise.stats
    },

    get noiseSlice() {
      return noise.slice
    },

    get weatherSlice() {
      return noise.weatherSlice
    },
    get cloudHdrTarget() {
      return cloudsPass.isHdrTarget
    },

    readCloudProbe() {
      return cloudsPass.readProbe(renderer)
    },

    readShadowHistogram() {
      return cloudsPass.readShadowHistogram(renderer)
    },

    readMarchProbe(mode: 0 | 1 | 2) {
      return cloudsPass.readMarchProbe(renderer, mode)
    },

    readResolveProbe() {
      return cloudsPass.readResolveProbe(renderer)
    },

    readSpriteProbe(opaqueCore: boolean) {
      return renderSpriteProbe(renderer, opaqueCore)
    },

    readToneProbe() {
      return renderToneProbe(renderer)
    },

    readOverlayProbe(marker: boolean) {
      return renderOverlayProbe(renderer, marker)
    },

    readSurfaceProbe() {
      // 雲影の代わりは固定の `DataTexture`。**本番の雲影マップは使わない。**
      // 雲量とカメラで中身が変わるので、突き合わせの入力にならない
      const cloudShadowMap = createSurfaceProbeShadowTexture()
      const inputs = {
        heightMap: heightTexture,
        terrainNormalMap: normalTexture,
        terrainExtent: terrain.extent,
        terrainTexels: terrain.size,
        cloudShadowMap,
      }
      try {
        const water: number[][] = []
        const waterBranches: number[][] = []
        for (let i = 0; i < WATER_PROBE_REGIONS.length; i++) {
          water.push(renderWaterSurfaceProbe(renderer, inputs, i, false))
          waterBranches.push(renderWaterSurfaceProbe(renderer, inputs, i, true))
        }
        return {
          terrain: renderTerrainSurfaceProbe(renderer, inputs, false),
          terrainBranches: renderTerrainSurfaceProbe(renderer, inputs, true),
          water,
          waterBranches,
        }
      } finally {
        cloudShadowMap.dispose()
      }
    },

    updateAircraftShadow(position) {
      aircraftShadow.update(position, atmosphere.sunDirectionWorld)
    },

    get aircraftShadowReady() {
      return aircraftShadow.ready
    },

    get environmentReady() {
      return scene.environment !== null
    },

    get gpuFrameMs() {
      return gpuTimer.lastMs
    },

    get gpuFrameMaxMs() {
      return gpuTimer.maxMs
    },

    get gpuTimerSupported() {
      return gpuTimer.supported
    },

    get drawCalls() {
      return backend.drawCalls
    },

    get drawnTriangles() {
      return backend.triangles
    },

    get terrainMs() {
      return terrainMs
    },

    get cameraWorld() {
      return cameraWorld
    },

    updateCameraWorld() {
      camera.getWorldPosition(cameraWorld)
      return cameraWorld
    },

    get cssHeight() {
      return cssHeight
    },

    get quality() {
      return quality
    },

    setQuality: applyPreset,

    renderPlain: renderPlainImpl,

    setSize(width, height, devicePixelRatio) {
      cssWidth = width
      cssHeight = height
      dpr = devicePixelRatio
      applySize()
    },

    async compile() {
      await renderer.compileAsync(scene, camera)
    },


    async compileAllPresets(current, onProgress) {
      let done = 0
      for (const name of PRESET_ORDER) {
        onProgress?.(done, PRESET_ORDER.length)
        applyPreset(name)
        await renderer.compileAsync(scene, camera)
        // **実際に 1 枚描く。**`compileAsync` だけでは足りない。影の状態が
        // 変わったことによる作り直しは `WebGLRenderer.setProgram` の中で
        // 判定されるので、描かないと起きない。実測で、medium を当てて
        // `compileAsync` を呼んでも medium 用の機体プログラムは 1 つも
        // 作られなかった（起動後の分布が `306,512` の 10 個だけだった）
        renderPlainImpl()
        done++
      }
      onProgress?.(done, PRESET_ORDER.length)
      // **最後に戻す。**呼ぶ前の見た目に影響を残さない
      applyPreset(current)
      await renderer.compileAsync(scene, camera)
      renderPlainImpl()
    },

    render() {
      backend.resetInfo()
      // 影のテクスチャは three が最初の描画で作る。sync() で入れると
      // 1 枚目が null のままになり、キャプチャモード（sync は 1 回だけ、
      // 描画は 8 回）では影がまったく出ない。毎フレームここで入れ直す
      updateShadowUniforms()

      // **交互計測はやめた。**内訳は `?sweep=1` の差分に一本化してある
      // （段 18）。フレーム全体を毎枚測る
      gpuTimer.begin()
      // 雲影は地面を描く前に焼く。composer の中では手遅れになる
      cloudsPass.renderShadow(renderer)
      composer.render()
      gpuTimer.end()
    },

    setMeasureConfig(config) {
      if (config.terrain !== undefined) terrainMesh.mesh.visible = config.terrain
      if (config.water !== undefined) water.mesh.visible = config.water
      if (config.sky !== undefined) atmosphere.sky.visible = config.sky
      if (config.aircraft !== undefined) aircraft.object.visible = config.aircraft
      if (config.environment !== undefined) {
        scene.environment = config.environment ? environment.texture : null
      }
      if (config.aircraftShadow !== undefined) measureShadow = config.aircraftShadow
      if (config.trails !== undefined) trails.object.visible = config.trails
      if (config.targets !== undefined) targetViews.object.visible = config.targets
      if (config.enemies !== undefined) enemyViews.object.visible = config.enemies
      if (config.damageSmoke !== undefined) {
        damageSmoke.object.visible = config.damageSmoke
      }
      if (config.flares !== undefined) flares.object.visible = config.flares
      if (config.tracers !== undefined) tracers.object.visible = config.tracers
      if (config.missiles !== undefined) missileViews.object.visible = config.missiles
      if (config.smoke !== undefined) missileSmoke.object.visible = config.smoke
      if (config.explosions !== undefined) {
        explosions.object.visible = config.explosions
      }
      if (config.detailNormals !== undefined) {
        terrainMesh.setDetailNormals(config.detailNormals)
      }
      if (config.clouds !== undefined) {
        cloudsEnabled = config.clouds
        cloudsPass.enabled = config.clouds
        // 差し込み口も外す。外さないと最後に焼いた雲が残り続ける
        atmosphere.setOverlay(config.clouds ? { map: cloudsPass.texture } : null)
      }
      if (
        config.lodDistanceScale !== undefined ||
        config.terrainPatchCells !== undefined
      ) {
        quality = applyQualityOverride(quality, {
          ...(config.lodDistanceScale !== undefined
            ? { lodDistanceScale: config.lodDistanceScale }
            : {}),
          ...(config.terrainPatchCells !== undefined
            ? { terrainPatchCells: config.terrainPatchCells }
            : {}),
        })
        terrainMesh.setQuality(quality)
        // パッチを選び直さないと、セル数だけ変わって枚数が古いままになる
        terrainMesh.update(cameraWorld.x, cameraWorld.z)
      }
    },

    setHour(hour) {
      atmosphere.setHour(hour)
      // 空が変わったら環境反射も焼き直す。時刻を変えたときだけなので安い。
      // atmosphere.setHour は次の update() で反映されるので、その後に焼く
      atmosphere.update()
      environment.refresh()
      scene.environment = environment.texture
    },

    setExposure(value) {
      renderer.toneMappingExposure = value
    },

    dispose() {
      gpuTimer.dispose()
      views.dispose()
      cloudsPass.dispose()
      noise.dispose()
      atmosphere.dispose()
      composer.dispose()
      terrainMesh.dispose()
      water.dispose()
      environment.dispose()
      heightTexture.dispose()
      normalTexture.dispose()
      renderer.dispose()
    },
  }
}
