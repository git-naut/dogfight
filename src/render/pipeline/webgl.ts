import * as THREE from 'three'
import { createChaseCamera } from '../camera'
import { createWebGLBackend } from '../backend'
import { createAircraftView, type AircraftView } from '../aircraftView'
import { loadAircraftModel, type AircraftModel } from '../aircraft/model'
import { loadCarrier, placeCarrier, type Carrier } from '../carrier'
import { createTargetViews, type TargetViews } from '../targetView'
import { createEnemyViews, type EnemyViews } from '../enemyView'
import { createDamageSmoke, type DamageSmokeView } from '../damageSmoke'
import { createTracers, type Tracers } from '../weapons/tracers'
import { createMissileViews, type MissileViews } from '../weapons/missileView'
import { createMissileSmoke, type MissileSmoke } from '../weapons/missileSmoke'
import { createFlares, type Flares } from '../weapons/flares'
import { FLARE_CAPACITY } from '../../sim/weapons/flare'
import { createExplosions, type Explosions } from '../weapons/explosions'
import { BULLET_POOL } from '../../sim/weapons/gun'
import { MISSILE_COUNT } from '../../sim/combat'
import { ENEMY_MISSILE_COUNT } from '../../sim/ai/fighter'
import { EXPLOSION_POOL } from '../../sim/effects'
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
import { createAircraftTrails, type AircraftTrails } from '../aircraft/trails'
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
  MAX_TARGETS,
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

/** 同時に描けるミサイルの数。自機ぶん + 敵 8 機ぶん */
const MISSILE_CAPACITY = MISSILE_COUNT + MAX_TARGETS * ENEMY_MISSILE_COUNT

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
  const noise: CloudNoise = generateCloudNoise(backend)

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

  // glb を読むのはここ 1 回だけ。自機と標的機が同じモデルを共有する。
  // 2 回読むとパースとテクスチャの復号が 2 度走り、実体が複製される
  const aircraftModel: AircraftModel = await loadAircraftModel(options.aircraftUrl)
  const aircraft: AircraftView = createAircraftView(aircraftModel)
  aircraft.object.visible = options.showAircraft ?? true
  scene.add(aircraft.object)

  // 標的機。複製は必要になった時点で作る。Phase 6 のミッションが敵 8 機なので
  // 器はそこまで用意しておく
  const targetViews: TargetViews = createTargetViews(aircraftModel, MAX_TARGETS)
  targetViews.object.visible = options.showTargets ?? true
  scene.add(targetViews.object)

  // 敵機。自機とは別の機体（F-16）なので glb も別。**敵味方が別の形になる
  // ので、ロックボックスが出ていなくても見分けられる**
  const enemyModel: AircraftModel = await loadAircraftModel(options.enemyUrl)
  const enemyViews: EnemyViews = createEnemyViews(enemyModel, MAX_TARGETS)
  enemyViews.object.visible = options.showEnemies ?? true
  scene.add(enemyViews.object)

  /**
   * 空母。**台本が要求したときだけ読む。**
   *
   * 実測で 2,644 三角形（シーン予算 1.5M の 0.18%）、glb 189 KB。
   * 動かないので視錐台の判定は残す
   */
  const carrier: Carrier | null =
    options.carrierUrl !== undefined ? await loadCarrier(options.carrierUrl) : null
  if (carrier !== null) {
    const at = options.carrier ?? { x: 0, z: 0, heading: 0 }
    placeCarrier(carrier, at.x, at.z, at.heading)
    scene.add(carrier.object)
  }

  // 曳光弾。5 発に 1 発なので線分は 55 本ぶん確保すれば足りるが、
  // プールと同じ大きさにしておけば割合を変えても壊れない
  const tracers: Tracers = createTracers(BULLET_POOL)
  tracers.object.visible = options.showTracers ?? true
  scene.add(tracers.object)

  // ミサイルの本体と煙
  // **敵のミサイルぶんも要る。**容量が足りないと、飛んでいるのに描かれない
  const missileViews: MissileViews = createMissileViews(MISSILE_CAPACITY)
  missileViews.object.visible = options.showMissiles ?? true
  scene.add(missileViews.object)
  const missileSmoke: MissileSmoke = createMissileSmoke(MISSILE_CAPACITY, quality)
  missileSmoke.object.visible = options.showSmoke ?? true
  scene.add(missileSmoke.object)

  // ダメージの煙。敵機ごとに 1 本
  const damageSmoke: DamageSmokeView = createDamageSmoke(MAX_TARGETS, quality)
  damageSmoke.object.visible = options.showDamageSmoke ?? true
  scene.add(damageSmoke.object)

  // 爆発。同時に生きるのは撃墜が重なったときくらいなので 8 個
  const explosions: Explosions = createExplosions(EXPLOSION_POOL, quality)
  explosions.object.visible = options.showExplosions ?? true
  scene.add(explosions.object)

  // フレア。積んでいる数ぶんの器を作る。同時に燃えるのはもっと少ないが、
  // 器を増やさないので使い回しで足りる
  // 自機ぶん + 敵 8 機ぶん。同時に燃えるのはずっと少ないが、器を使い回す
  const flares: Flares = createFlares(FLARE_CAPACITY * (1 + MAX_TARGETS), quality)
  flares.object.visible = options.showFlares ?? true
  scene.add(flares.object)

  // 機体の影。影マップ 1 枚で自己遮蔽と対地影の両方をまかなう
  // コントレイルと翼端渦。履歴は sim が持つので、ここは読んで張るだけ
  const trails: AircraftTrails = createAircraftTrails(quality)
  trails.object.visible = options.showTrails ?? true
  scene.add(trails.object)

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
    backend,
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
  let measureClouds = false
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
    cloudsPass.setTimingEnabled(false)
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
    renderer,
    scene,
    camera,
    chase,

    terrain,
    terrainUniforms,
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

    get cloudHdrTarget() {
      return cloudsPass.isHdrTarget
    },

    readCloudProbe() {
      return cloudsPass.readProbe(renderer)
    },

    readShadowHistogram() {
      return cloudsPass.readShadowHistogram(renderer)
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

    get gpuCloudMs() {
      return cloudsPass.gpuMs
    },

    get gpuCloudMaxMs() {
      return cloudsPass.gpuMaxMs
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
      explosions.dispose()
      missileSmoke.dispose()
      damageSmoke.dispose()
      missileViews.dispose()
      tracers.dispose()
      targetViews.dispose()
      enemyViews.dispose()
      aircraft.dispose()
      // ジオメトリとマテリアルの実体はモデルが持つ。自機と標的で共有して
      // いるので、破棄はここで 1 回だけ
      aircraftModel.dispose()
      enemyModel.dispose()
      cloudsPass.dispose()
      noise.dispose()
      atmosphere.dispose()
      composer.dispose()
      terrainMesh.dispose()
      water.dispose()
      trails.dispose()
      environment.dispose()
      heightTexture.dispose()
      normalTexture.dispose()
      renderer.dispose()
    },
  }
}
