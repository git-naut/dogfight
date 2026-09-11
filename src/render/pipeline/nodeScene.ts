import * as THREE from 'three'
import { vec3, Fn, vec4 } from 'three/tsl'
import * as webgpu from 'three/webgpu'
import { createChaseCamera } from '../camera'
import { createNodeBackend } from './nodeBackend'
import { advanceNodeFrame, buildNodePipeline } from './nodeBuild'
import { configureNodeAircraftShadow, followAircraftShadow } from './nodeShadow'
import { createNodeOutputNode, createScenePass } from './nodeOutput'
import { createSceneViews } from './views'
import { createNodeRadialSprite } from '../weapons/spriteNodes'
import { bakeNodeCloudNoise } from '../clouds/nodeNoise'
import { createCloudsNodePass, type CloudsNodePass } from '../clouds/cloudsNodePass'
import { SHADOW_EXTENT } from '../clouds/cloudsPass'
import { bakePlane, createBakeQuad, readPlane } from '../clouds/volume'
import {
  createNodeSurfaceState,
  createTerrainNodeMaterial,
  createWaterNodeMaterial,
} from '../terrain/nodeMaterials'
import { createTerrainMesh, createTerrainUniforms, type TerrainMesh } from '../terrain/terrainMesh'
import { createWater, type Water } from '../terrain/water'
import { createHeightTexture, createNormalTexture } from '../terrain/heightTexture'
import { defaultTerrain, type Terrain } from '../../sim/terrain'
import { DEFAULT_HOUR } from '../atmosphere'
import {
  setupAtmosphereNodes,
  solarFrameForHour,
  type AtmosphereNodes,
} from '../atmosphereNodes'
import { createGpuTimer, type GpuTimer } from '../gpuTimer'
import {
  applyQualityOverride,
  getQuality,
  type PresetName,
} from '../quality'
import {
  DEFAULT_COVERAGE,
  DEFAULT_EXPOSURE,
  type ScenePipeline,
  type SceneOptions,
} from './types'

/**
 * 場面を node 経路（`WebGPURenderer`）で組む。
 *
 * `createWebGLPipeline` と同じ `ScenePipeline` を返すので、帳簿
 * （`scene.ts`）はどちらが立っているかを知らない。
 *
 * **経路に依らない部分は共有側にある。**場面に置く物は `views.ts`、
 * 組み立ての順序は `nodeBuild.ts`、出力ノードは `nodeOutput.ts`、大気は
 * `atmosphereNodes.ts`、雲ノイズは `clouds/nodeNoise.ts`、バックエンドの
 * facade は `nodeBackend.ts`。ここはそれらを繋ぐだけにする。
 *
 * **WebGPU が要る。**node 経路の WebGL2 フォールバックでは大気の構造体が
 * GLSL のコンパイルで落ちる（`'AtmosphereParameters' : syntax error`。
 * 実測）。計画は `forceWebGL: true` を退避路に当てていたが効かない。
 */
const RADIANCE_SIDE = 2

/**
 * WebGPU が無いので node 経路の場面を立てられない。
 *
 * **node 経路の WebGL2 フォールバックでは大気の構造体が GLSL の
 * コンパイルで落ちる**（`'AtmosphereParameters' : syntax error`。ADR 0010 の
 * 段 10）。計画は `forceWebGL: true` を退避路に当てていたが効かない。
 *
 * 既定が node になった段 20b 以降、**WebGPU の無いブラウザではこれが投げ
 * られる。**`createScene` が受けて GLSL 経路へ落とす
 */
export class WebGPUUnavailable extends Error {
  override readonly name = 'WebGPUUnavailable'
  constructor() {
    super('WebGPU が無いので node 経路の場面を立てられない（ADR 0010 の段 10）')
  }
}

export async function createNodePipeline(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<ScenePipeline> {
  const qualityOverride = options.qualityOverride ?? {}
  let quality = applyQualityOverride(getQuality(options.preset), qualityOverride)

  const renderer = new webgpu.WebGPURenderer({
    canvas,
    // SMAA を鎖の中で掛けるので、ここでは無効にする
    antialias: false,
    // **`timestamp-query` が無いと静かに false になる。**例外は出ず、
    // `resolveTimestampsAsync()` が `undefined` を返すだけ（段 18）
    trackTimestamp: true,
  })
  // **これを忘れると描けない。**バックエンドの取得が非同期なので起動列へ入る
  await renderer.init()

  if (!('isWebGPUBackend' in renderer.backend)) {
    // **呼ぶ側が退避できるように、専用の型で投げる。**メッセージの文字列で
    // 判定させると、文言を直した瞬間に退避路が黙って死ぬ（段 20b）
    renderer.dispose()
    throw new WebGPUUnavailable()
  }

  const backend = createNodeBackend(renderer)

  // 露出とトーンマッピングはレンダラへ置く。`RenderPipeline._update` が
  // `renderOutput` を足し、`ToneMappingNode` の露出は
  // `rendererReference('toneMappingExposure')` を読む。GLSL 経路と同じ形
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.toneMappingExposure = options.exposure ?? DEFAULT_EXPOSURE

  const scene = new THREE.Scene()
  // near / far の根拠は GLSL 経路と同じ（比を 4 万に抑えて z ファイティングを
  // 避ける）。対数深度バッファは雲が標準の射影式を前提にするので使えない
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 5, 200_000)
  const chase = createChaseCamera(camera)

  let hour = options.hour ?? DEFAULT_HOUR
  let solar = solarFrameForHour(hour)

  const atmos = await import('@takram/three-atmosphere/webgpu')
  const { smaa } = await import('three/examples/jsm/tsl/display/SMAANode.js')

  const atmosphere = setupAtmosphereNodes(atmos, {
    renderer,
    camera,
    scene,
    quality,
    worldToECEF: solar.worldToECEF,
    sunDirectionECEF: solar.sunDirectionECEF,
    moonDirectionECEF: solar.moonDirectionECEF,
    // **鎖を組むので背景に空クアッドを置かない。**`AerialPerspectiveNode`
    // が `depth >= 1` の画素で `skyNode` を評価する
    skyBackground: false,
  })
  const atmosphereNodes: AtmosphereNodes = atmosphere.nodes

  const noise = await bakeNodeCloudNoise(renderer)

  // 高さ場は sim が持つ。生成時間は sim 層で測れない（`performance.now()` が
  // 使えない）のでここで挟む
  const terrainStart = performance.now()
  const terrain: Terrain = defaultTerrain()
  const terrainMs = performance.now() - terrainStart

  const heightTexture = createHeightTexture(terrain)
  const normalTexture = createNormalTexture(terrain)

  // 場面のパスを先に作る。雲は深度テクスチャを要るので順が決まる
  const { scenePass, depthTexture } = createScenePass(scene, camera)

  // 雲の太陽光と天空光は LUT から取る。**CPU 側に値が無い**ので、
  // 原点の海面高度で 1 度だけ引く（GLSL 経路もフレームに 1 つの値を使う）
  const cloudOrigin = vec3(0, 0, 0)
  const cloudUp = vec3(0, 1, 0)
  const cloudSunColor = atmosphereNodes.scalarIlluminance(cloudOrigin).get('direct')
  const cloudAmbientColor = atmosphereNodes
    .illuminance(cloudOrigin, cloudUp)
    .indirect.mul(1 / Math.PI)

  let coverage = options.coverage ?? DEFAULT_COVERAGE
  const clouds: CloudsNodePass = createCloudsNodePass({
    camera,
    noise: { shape: noise.shape, detail: noise.detail, weather: noise.weather },
    quality,
    coverage,
    sceneDepth: depthTexture,
    captureMode: options.cloudCaptureMode ?? false,
    temporal: options.cloudTemporal ?? true,
    clampScale: 1,
    sunColorNode: cloudSunColor,
    ambientColorNode: cloudAmbientColor,
  })

  const surfaceState = createNodeSurfaceState(
    {
      heightMap: heightTexture,
      terrainNormalMap: normalTexture,
      cloudShadowMap: clouds.shadowTexture,
      extent: terrain.extent,
      texels: terrain.size,
      cloudShadowExtent: SHADOW_EXTENT,
    },
    quality,
  )
  surfaceState.setSunDirection(
    solar.sunDirectionWorld.x,
    solar.sunDirectionWorld.y,
    solar.sunDirectionWorld.z,
  )

  // **環境反射は `?env=0` で外せる。**`setupAtmosphereNodes` は
  // `skyEnvironmentSize` だけを見るので、ここで台本の指定を重ねる
  // （GLSL 経路の `scene.environment = showEnvironment ? ... : null` と同じ）
  if (options.showEnvironment === false) {
    ;(scene as unknown as { environmentNode: unknown }).environmentNode = null
  }

  // 場面に置く物。**円形スプライトは TSL 版を差す。**`ShaderMaterial` は
  // node 経路で黙って描かれない（例外は出ず、コンソールに 1 行出るだけ）
  const views = await createSceneViews({
    scene,
    quality,
    options,
    sprite: createNodeRadialSprite,
  })

  // 機体の影。**投げ手の側で `castShadow` を立てる。**光の側は
  // `buildNodePipeline` が組み立てのあとで立てる。
  // `renderer.shadowMap.enabled` を先に立てる必要があり、忘れると
  // ノードが本体を生成しないまま最初の描画で落ちる（`nodeShadow.ts`）
  const shadowLight = atmosphere.sunLight
  views.aircraft.object.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true
  })
  const shadowInfo = configureNodeAircraftShadow({
    renderer,
    light: shadowLight,
    quality,
    center: new THREE.Vector3(0, 0, 0),
    sunDirectionWorld: solar.sunDirectionWorld,
  })
  const aircraftShade = shadowInfo.shade

  // 地形と海面。**格子もパッチの選び方も GLSL 経路と同じものを使う。**
  // 差し替わるのは材質だけで、工場を受け取る口が両方にある
  // **`?illum=0` で段 17b の形へ戻せる。**大気の LUT から引くのをやめると
  // `surfaceState` の放射輝度（照度の読み戻しが入れた値）を使う。
  // 差分の帰属を測るための口（段 20a-4）
  const useLutIlluminance = options.illuminance ?? true
  const sharedUniforms = createTerrainUniforms(terrain, SHADOW_EXTENT)
  const terrainMesh: TerrainMesh = createTerrainMesh(terrain, quality, sharedUniforms, () =>
    useLutIlluminance
      ? createTerrainNodeMaterial(surfaceState, aircraftShade, atmosphereNodes.illuminance)
      : createTerrainNodeMaterial(surfaceState, aircraftShade),
  )
  terrainMesh.mesh.visible = options.showTerrain ?? true
  scene.add(terrainMesh.mesh)

  /**
   * 海面が読む放射輝度。
   *
   * **太陽は余弦を含まない側を使う。**スペキュラは太陽の見かけの明るさで
   * 決まるので、面の傾きで暗くしてはいけない。天空は半球の重みが要るので
   * 間接を pi で割る
   */
  const water: Water = createWater(quality, sharedUniforms, () =>
    useLutIlluminance
      ? createWaterNodeMaterial(surfaceState, aircraftShade, (world, normal) => ({
          sun: atmosphereNodes.scalarIlluminance(world).get('direct'),
          sky: atmosphereNodes.illuminance(world, normal).indirect.mul(1 / Math.PI),
        }))
      : createWaterNodeMaterial(surfaceState, aircraftShade),
  )
  water.mesh.visible = options.showWater ?? true
  scene.add(water.mesh)

  const output = createNodeOutputNode({
    atmos,
    smaa: smaa as unknown as (node: webgpu.Node) => webgpu.Node,
    scenePass,
    cloudNode: clouds.node,
  })
  // **`?smaa=0` で外せる。**42 枚は全画素が動くので、原因ごとの寄与は
  // 1 つずつ振って測るしかない（段 20a-4 の差分の台帳）
  const outputNode = (options.smaa ?? true) ? output.outputNode : output.composite

  const built = await buildNodePipeline({
    renderer,
    scene,
    camera,
    outputNode,
    // **立てていないときは渡さない。**渡すと `castShadow` が立ち、
    // low プリセットで「影が切れている」の検査が通らない
    shadowLight: shadowInfo.enabled ? shadowLight : null,
    clouds,
    lutNode: atmosphere.context.lutNode,
  })
  const pipeline = built.pipeline

  const gpuTimer: GpuTimer = createGpuTimer(backend)

  // ---- 放射輝度を LUT から読み戻す ----
  //
  // **node 経路に CPU 側の値が無い。**`AtmosphereLight` の `direct` と
  // `indirect` は `UniformNode<boolean>` の on/off で色ではなく、`.color` は
  // `DirectionalLight` の既定の白のまま残る。実際の放射輝度はシェーダが
  // 決める。何もしないと計器と `太陽光の色が時刻で変わる` が 0 を読む。
  //
  // 照度を 1 点で焼いて読み戻す。**毎フレームは焼かない。**太陽が動いた
  // ときだけで、読み戻しは非同期なので値は数枚遅れる。プローブの実測で
  // 直達は GLSL 経路と 2.6% 違い（1.705 対 1.751）
  const radianceQuad = createBakeQuad()
  const sunRadiance = new THREE.Vector3()
  const skyRadiance = new THREE.Vector3()
  const anchor = new THREE.Vector3(0, 0, 0)

  const radianceFragment = (sky: boolean) =>
    Fn(() => {
      const world = vec3(anchor.x, anchor.y, anchor.z)
      const up = vec3(0, 1, 0)
      const value = sky
        ? atmosphereNodes.illuminance(world, up).indirect.mul(1 / Math.PI)
        : atmosphereNodes.scalarIlluminance(world).get('direct')
      return vec4(value, 1)
    })() as unknown as webgpu.Node<'vec4'>

  async function refreshRadiance(): Promise<void> {
    for (const sky of [false, true]) {
      const target = bakePlane(
        renderer,
        radianceQuad,
        RADIANCE_SIDE,
        RADIANCE_SIDE,
        radianceFragment(sky),
        { float: true },
      )
      const values = await readPlane(renderer, target, RADIANCE_SIDE, RADIANCE_SIDE, true)
      target.dispose()
      if (values.length >= 3) {
        const out = sky ? skyRadiance : sunRadiance
        out.set(values[0]!, values[1]!, values[2]!)
      }
    }
  }
  await refreshRadiance()

  let cssWidth = canvas.clientWidth || 1920
  let cssHeight = canvas.clientHeight || 1080
  let dpr = 1

  function applySize(): void {
    const ratio = Math.min(dpr, quality.maxPixelRatio) * quality.renderScale
    renderer.setPixelRatio(ratio)
    renderer.setSize(cssWidth, cssHeight, false)
    clouds.setSize(cssWidth, cssHeight)
    camera.aspect = cssWidth / cssHeight
    camera.updateProjectionMatrix()
  }
  applySize()

  /** 雲のパスを描いているか。計測で切ったときは影の焼き込みも止める */
  let cloudsEnabled = true
  const cameraWorld = new THREE.Vector3()

  function renderPlainImpl(): void {
    backend.resetInfo()
    // **番号を進めないと場面のパスが 1 枚目しか走らない。**理由は
    // `nodeBuild.ts` の `advanceNodeFrame` の注記
    advanceNodeFrame(renderer)
    // 雲影は地面を描く前に焼く。**鎖の中では手遅れになる**
    if (cloudsEnabled) clouds.renderShadow(renderer)
    pipeline.render()
  }

  // いま `environmentNode` に入っている大きさ。0 は切っている状態
  let environmentSize = options.showEnvironment === false ? 0 : quality.skyEnvironmentSize

  function applyPreset(preset: PresetName): void {
    quality = applyQualityOverride(getQuality(preset), qualityOverride)
    clouds.setQuality(quality)
    terrainMesh.setQuality(quality)
    water.setQuality(quality)
    views.trails.setQuality(quality)
    views.missileSmoke.setQuality(quality)
    views.damageSmoke.setQuality(quality)
    views.explosions.setQuality(quality)
    // **影は `nodeShadow` に任せる。**ここで `mapSize` を直に書くと `low` の
    // 0 がそのまま渡り、0×0 のテクスチャで描画ループごと止まる（段 20c）
    shadowInfo.setQuality(quality)
    // 環境反射は**大きさが変わったときだけ**作り直す。
    //
    // 毎回作り直すと、降格のたびにキューブの的が増える。`?env=0` の指定も
    // 踏み潰していた（起動で null にしても最初の降格で戻る。段 20c で実測）
    const wantedEnv = options.showEnvironment === false ? 0 : quality.skyEnvironmentSize
    if (wantedEnv !== environmentSize) {
      environmentSize = wantedEnv
      const sceneNodes = scene as unknown as { environmentNode: unknown }
      sceneNodes.environmentNode = wantedEnv > 0 ? atmos.skyEnvironment(wantedEnv) : null
      pipeline.needsUpdate = true
    }
    applySize()
  }

  /** node 経路に無い口。**黙って空を返さない** */
  function unsupported(name: string): never {
    throw new Error(
      `${name} は node 経路にない。GLSL 側が TSL との突き合わせの参照値を` +
        '作るための口で、node 経路では相手がいない。空を返すと「一致した」と' +
        '読める結果が出てしまう',
    )
  }

  return {
    backend,
    scene,
    camera,
    chase,

    terrain,
    terrainMesh,
    water,
    aircraft: views.aircraft,
    targetViews: views.targetViews,
    enemyViews: views.enemyViews,
    tracers: views.tracers,
    missileViews: views.missileViews,
    missileSmoke: views.missileSmoke,
    damageSmoke: views.damageSmoke,
    explosions: views.explosions,
    flares: views.flares,
    trails: views.trails,

    get sunElevation() {
      return (solar.sunElevationDeg * Math.PI) / 180
    },
    get sunRadiance() {
      return sunRadiance
    },
    get skyRadiance() {
      return skyRadiance
    },
    get sunDirectionWorld() {
      return solar.sunDirectionWorld
    },

    setLightAnchor(x, y, z) {
      // 高度で透過率が変わるので、照度を引く点を機体に合わせる。
      // 光の位置は `AtmosphereLight` が向きから決めるので触らない
      anchor.set(x, y, z)
      shadowLight.target.position.set(x, y, z)
    },

    updateAtmosphere() {
      // 大気の値は GPU が決めるので、ここでやることは無い。放射輝度の
      // 読み戻しは `setHour` のときだけ（毎フレーム焼くと計測を壊す）
    },

    setHour(next) {
      if (next === hour) return
      hour = next
      solar = solarFrameForHour(hour)
      atmosphere.context.matrixWorldToECEF.value.copy(solar.worldToECEF)
      atmosphere.context.sunDirectionECEF.value.copy(solar.sunDirectionECEF)
      atmosphere.context.moonDirectionECEF.value.copy(solar.moonDirectionECEF)
      surfaceState.setSunDirection(
        solar.sunDirectionWorld.x,
        solar.sunDirectionWorld.y,
        solar.sunDirectionWorld.z,
      )
      void refreshRadiance()
    },

    setSurfaceFrame(frame) {
      surfaceState.setCloudShadowCenter(frame.cloudShadowCenter.x, frame.cloudShadowCenter.y)
      surfaceState.setCloudShadowEnabled(frame.cloudShadowEnabled)
      surfaceState.setSunDirection(
        frame.sunDirectionWorld.x,
        frame.sunDirectionWorld.y,
        frame.sunDirectionWorld.z,
      )
      surfaceState.setSunRadiance(frame.sunRadiance.x, frame.sunRadiance.y, frame.sunRadiance.z)
      surfaceState.setSkyRadiance(frame.skyRadiance.x, frame.skyRadiance.y, frame.skyRadiance.z)
      surfaceState.setMorphOrigin(frame.morphOrigin.x, frame.morphOrigin.y, frame.morphOrigin.z)
    },

    updateClouds(update) {
      coverage = update.coverage
      clouds.update(update)
      surfaceState.setWaveTime(update.cloudTime)
    },

    get noiseMs() {
      return noise.ms
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
      return clouds.isHdrTarget
    },

    readCloudProbe() {
      return unsupported('readCloudProbe')
    },
    readShadowHistogram() {
      return unsupported('readShadowHistogram')
    },
    readMarchProbe() {
      return unsupported('readMarchProbe')
    },
    readResolveProbe() {
      return unsupported('readResolveProbe')
    },
    readSpriteProbe() {
      return unsupported('readSpriteProbe')
    },
    readToneProbe() {
      return unsupported('readToneProbe')
    },
    readOverlayProbe() {
      return unsupported('readOverlayProbe')
    },
    readSurfaceProbe() {
      return unsupported('readSurfaceProbe')
    },

    updateAircraftShadow(position) {
      if (!shadowInfo.enabled) return
      followAircraftShadow(shadowLight, position, solar.sunDirectionWorld)
    },
    get aircraftShadowReady() {
      return shadowInfo.enabled && shadowLight.castShadow && shadowLight.shadow.map !== null
    },
    get environmentReady() {
      // **`!== null` では足りない。**設定していなければ `undefined` になる
      return Boolean((scene as unknown as { environmentNode: unknown }).environmentNode)
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

    render() {
      backend.resetInfo()
      advanceNodeFrame(renderer)
      gpuTimer.begin()
      if (cloudsEnabled) clouds.renderShadow(renderer)
      pipeline.render()
      gpuTimer.end()
    },
    renderPlain: renderPlainImpl,

    setSize(width, height, devicePixelRatio) {
      cssWidth = width
      cssHeight = height
      dpr = devicePixelRatio
      applySize()
    },
    get cssHeight() {
      return cssHeight
    },
    get quality() {
      return quality
    },
    setQuality: applyPreset,
    setExposure(value) {
      renderer.toneMappingExposure = value
    },

    async compile() {
      await renderer.compileAsync(scene, camera)
    },

    async compileAllPresets(current, onProgress) {
      // **段ごとに組まない。起動時間と降格の滑らかさを交換している。**
      //
      // 実測（段 20b、SwiftShader の WebGPU、`?script=mission-01`）。
      //
      // | | 起動 programs | compileMs | 降格で増える数 |
      // |---|---|---|---|
      // | 4 段ぶん | 67 | **37,649 ms** | 8 |
      // | 1 段ぶん（これ） | 61 | 3,456〜4,721 ms | **12** |
      //
      // 4 段ぶん回すと降格時の作成が 12 から 8 へ減る。**そのために起動で
      // 34 秒払う。**降格は環境しだいで起きたり起きなかったりするのに対し、
      // 起動は毎回必ず payer がいるので 1 段を採った。34 秒は SwiftShader の
      // 値で、実機の GPU では測っていない。
      //
      // 旧経路（GLSL）は `#define` が変わるとシェーダの変種が増えるので、
      // 4 段ぶん組む意味がある（`?precompile=0` で 25、既定で 119）。
      // `compileAllPresets` の口そのものは旧経路のために要る。
      //
      // **プリセットを変えても作り直しが大量に起きないこと**は
      // `品質が落ちても作り直しがほぼ起きない` が両経路で見ている
      onProgress?.(0, 1)
      applyPreset(current)
      await renderer.compileAsync(scene, camera)
      // **実際に 1 枚描く。**`compileAsync` は場面の物しか組まないので、
      // 鎖と雲のクアッドは描かないと組まれない（段 19 の実測）
      renderPlainImpl()
      onProgress?.(1, 1)
    },

    setMeasureConfig(config) {
      if (config.sky === false) {
        // **黙って無視しない。**`skyNode` を null にすれば空は消えるが、
        // 読まれるのは `setup()` の中なので鎖の組み直しが要る。掃引は
        // 条件を周回ごとに切り替えるので、組み直しを挟むと計測そのものを
        // 壊す。uniform で 0 にする手は評価が走るぶん費用が下がらず、
        // 「空なし」の行が意味のない 0 になる
        throw new Error(
          '空の切り替えは node 経路にない。`AerialPerspectiveNode.skyNode` は' +
            '`setup()` の中で読まれるので、切り替えるには鎖の組み直しが要る',
        )
      }
      if (config.terrain !== undefined) terrainMesh.mesh.visible = config.terrain
      if (config.water !== undefined) water.mesh.visible = config.water
      if (config.aircraft !== undefined) views.aircraft.object.visible = config.aircraft
      if (config.targets !== undefined) views.targetViews.object.visible = config.targets
      if (config.enemies !== undefined) views.enemyViews.object.visible = config.enemies
      if (config.tracers !== undefined) views.tracers.object.visible = config.tracers
      if (config.missiles !== undefined) views.missileViews.object.visible = config.missiles
      if (config.smoke !== undefined) views.missileSmoke.object.visible = config.smoke
      if (config.damageSmoke !== undefined) views.damageSmoke.object.visible = config.damageSmoke
      if (config.explosions !== undefined) views.explosions.object.visible = config.explosions
      if (config.flares !== undefined) views.flares.object.visible = config.flares
      if (config.trails !== undefined) views.trails.object.visible = config.trails
      if (config.detailNormals !== undefined) {
        surfaceState.setDetailNormals(config.detailNormals)
      }
      if (config.aircraftShadow !== undefined) {
        // **投げ手の側で切る。**光の `castShadow` は触らない（立て直すと
        // three の光の系が影のノードをもう 1 つ作る）
        views.aircraft.object.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = config.aircraftShadow!
        })
      }
      if (config.environment !== undefined) {
        const sceneNodes = scene as unknown as { environmentNode: unknown }
        sceneNodes.environmentNode = config.environment
          ? atmos.skyEnvironment(quality.skyEnvironmentSize)
          : null
        pipeline.needsUpdate = true
      }
      if (config.clouds !== undefined) cloudsEnabled = config.clouds
      if (config.terrainPatchCells !== undefined) {
        terrainMesh.setQuality({ ...quality, terrainPatchCells: config.terrainPatchCells })
      }
      if (config.lodDistanceScale !== undefined) {
        terrainMesh.setQuality({ ...quality, lodDistanceScale: config.lodDistanceScale })
      }
    },

    dispose() {
      gpuTimer.dispose()
      views.dispose()
      noise.dispose()
      radianceQuad.dispose()
      terrainMesh.dispose()
      water.dispose()
      heightTexture.dispose()
      normalTexture.dispose()
      renderer.dispose()
    },
  }
}
