import * as THREE from 'three'
import { vec3, Fn, vec4, uniform } from 'three/tsl'
import * as webgpu from 'three/webgpu'
import { createChaseCamera } from '../camera'
import { createNodeBackend } from './nodeBackend'
import { advanceNodeFrame, buildNodePipeline } from './nodeBuild'
import { configureNodeAircraftShadow, followAircraftShadow } from './nodeShadow'
import { createNodeOutputNode, createOverlayPass, createScenePass, type BloomFactory } from './nodeOutput'
import { createSceneViews } from './views'
import { bakeAircraftSpace, toNodeAircraftMaterial } from './nodeAircraftMaterial'
import { toNodeFlameMaterial } from './nodeFlameMaterial'
import { createNodeFireballSprite } from '../weapons/fireballNodes'
import { createNodeRadialSprite } from '../weapons/spriteNodes'
import { sceneOcclusion } from '../weapons/sceneOcclusion'
import { createNodeTrailMaterial } from '../weapons/trailNodes'
import { createNodeVaporMaterial } from '../aircraft/vaporNodes'
import { bakePlane, createBakeQuad, readPlane } from './bake'
import { DEFAULT_HOUR, sunFrameForHour } from '../geoFrame'
import { createGpuTimer, type GpuTimer } from '../gpuTimer'
import {
  getQuality,
  type PresetName,
  type QualitySettings,
} from '../quality'
import {
  BLOOM_THRESHOLD_AFTER_EXPOSURE,
  EMISSIVE_BLOOM_GAIN,
  DEFAULT_COVERAGE,
  DEFAULT_EXPOSURE,
  type ScenePipeline,
  type SceneOptions,
} from './types'
import { WebGPUUnavailable } from './webgpuRequired'
import { FIXED_DT } from '../../sim/loop'
import { createHillaireSky, type SkyLighting } from '../sky/hillaireSky'
import { CLOUD_SHADOW_OCTAVE_DROP, cloudLayerTexture, createCloudLayers } from '../sky/cloudLayerNodes'
import { layerSunTransmittance } from '../sky/cloudLayersReference'

/**
 * 場面を node 経路（`WebGPURenderer`）で組む。
 *
 * 帳簿（`scene.ts`）は `ScenePipeline` の面しか見ない。段 S1 で GLSL 経路
 * （`createWebGLPipeline`）を捨て、組み手はここだけになった。
 *
 * **経路に依らない部分は共有側にある。**場面に置く物は `views.ts`、
 * 組み立ての順序は `nodeBuild.ts`、出力ノードは `nodeOutput.ts`、空と霞と光は
 * `sky/hillaireSky.ts`、層の雲は `sky/cloudLayerNodes.ts`、海は `ocean/`、バックエンドの
 * facade は `nodeBackend.ts`。ここはそれらを繋ぐだけにする。
 *
 * **WebGPU が要る。**段 S1 で GLSL 退避路を捨てた。WebGPU が無いときは
 * `WebGPUUnavailable`（`webgpuRequired.ts`）で止める。
 */
const RADIANCE_SIDE = 2

/**
 * 露出から、鎖へ渡すブルームの閾値を出す。
 *
 * **鎖の中は露出前。**`createNodeOutputNode` の戻り値を
 * `RenderPipeline._updateContext` が `renderOutput()` で包み、その中の
 * `ToneMappingNode` が AgX へ露出を渡す。AgX は
 * `colortone.mulAssign(exposure)` を最初に走らせる。
 *
 * だから「露出後で 1.2 から光らせたい」なら、渡す値は 1.2 / 6 = 0.20。
 * 空の線形値の最大は 0.1844（`weapons/explosions.ts`）なので、この値なら
 * 空は光らず、それより明るいものだけが立つ。
 *
 * `BLOOM_THRESHOLD_AFTER_EXPOSURE` の値は掃引で決めた（`docs/measuring.md`）。
 */
function bloomThresholdFor(exposure: number, afterExposure: number): number {
  return afterExposure / Math.max(exposure, 1e-6)
}

export async function createNodePipeline(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<ScenePipeline> {
  let quality = getQuality(options.preset)

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
    // **専用の型で投げる。**`createScene` が先にアダプタを訊いているので
    // 普通はここへ来ない。来るのは、アダプタは取れたのに three が WebGL2 へ
    // 落ちた場合（段 S1 で GLSL 退避路を捨てたので、立てずに止める）
    renderer.dispose()
    throw new WebGPUUnavailable('not-webgpu-backend')
  }

  const backend = createNodeBackend(renderer)

  // 露出とトーンマッピングはレンダラへ置く。`RenderPipeline._update` が
  // `renderOutput` を足し、`ToneMappingNode` の露出は
  // `rendererReference('toneMappingExposure')` を読む。GLSL 経路と同じ形
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.toneMappingExposure = options.exposure ?? DEFAULT_EXPOSURE

  const scene = new THREE.Scene()
  // GPU のパスごとの所要で見分ける名前（`passTimes.ts` の群の表、段 S0a）
  scene.name = 'Scene'
  // near / far の根拠は GLSL 経路と同じ（比を 4 万に抑えて z ファイティングを
  // 避ける）。対数深度バッファは雲が標準の射影式を前提にするので使えない
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 5, 200_000)
  const chase = createChaseCamera(camera)

  let hour = options.hour ?? DEFAULT_HOUR
  let solar = sunFrameFor(hour)

  const { smaa } = await import('three/examples/jsm/tsl/display/SMAANode.js')
  // **ブルームも別チャンクにする。**SMAA と同じ方針（`nodeOutput.ts` の注記）
  const { bloom } = await import('three/examples/jsm/tsl/display/BloomNode.js')
  // 風圧。`renderOutput` は three 本体にあるので `three/tsl` から。
  // **色収差は入れない。**`ChromaticAberrationNode` は `convertToTexture` を
  // もう 1 回通すので、実機で GPU が 9.7 から 14.0 ms へ上がった
  const [{ radialBlur }, tslDisplay] = await Promise.all([
    import('three/examples/jsm/tsl/display/radialBlur.js'),
    import('three/tsl'),
  ])

  // ---- 空・霞・光（段 S2b-2 で takram から置き換えた。ADR 0045）----
  //
  // **空は場面のパスの背景として描く**（段 29 の前提の修正、2026-09-28）。深度を
  // 書かない半透明の物（爆発、飛行機雲、煙）が、空の手前で場面のパスの中に重なる
  const sky = createHillaireSky(renderer)
  sky.setSun(solar.sunDirectionWorld)
  /** 照度の口。海・雲・照度の読み戻しが同じものを読む */
  const atmosphereNodes: SkyLighting = sky.lighting
  /** 環境反射。入れないときも明示的に null を入れる（`undefined` が残ると判定を誤る） */
  const environmentFor = (on: boolean): unknown => (on ? sky.environmentNode : null)
  const sceneNodes = scene as unknown as { backgroundNode: unknown; environmentNode: unknown }
  sceneNodes.backgroundNode = sky.backgroundNode
  sceneNodes.environmentNode = environmentFor(quality.skyEnvironment)
  scene.add(sky.sunLight, sky.sunLight.target, sky.skyLight)
  /** 光の色を決める点（機体の位置）。`setLightAnchor` が書き換える */
  const anchor = new THREE.Vector3(0, 0, 0)
  /** 空と霞の LUT を焼き直し、機体の光を入れ直す。場面を描く前に呼ぶ */
  const updateSky = () => sky.update(renderer, camera, solar.sunDirectionWorld, anchor)

  // ---- FFT の海を目で見る画面（段 S3、`?ocean=debug`）----
  //
  // 場面には繋がない。出力を海の画面に差し替え、毎フレーム海を解く。時刻は sim の
  // フレーム番号（`updateClouds` の `cloudTime`）から
  const oceanDebug = options.oceanDebug === true ? await createOceanDebug(options) : null
  oceanDebug?.sim.init(renderer)
  let oceanTicks = 0

  // 場面のパスを先に作る。雲は深度テクスチャを要るので順が決まる
  // **発光体のブルームは組み立ての時点で決める。**MRT の面は場面のパスを
  // 作るときにしか足せない。実行中にプリセットが下がっても面は残るが、
  // ブルームを掛けない段では誰も読まない
  const bloomEmissive = options.bloomEmissive ?? quality.bloomEmissive
  const { scenePass, depthTexture, emissiveNode } = createScenePass(scene, camera, {
    normals: options.sceneNormals === true,
    emissive: bloomEmissive,
  })

  let coverage = options.coverage ?? DEFAULT_COVERAGE

  // ---- 層の雲（段 S4c で作り、段 S4b で既定にした。ADR 0050）----
  //
  // 合成へ前乗算の色を渡す。海と機体の光は、層を横切る太陽の線の透過率で遮る
  const cloudLayers = createCloudLayers({
    view: sky.view,
    skyRadiance: (dir, spread) => sky.radiance(dir, spread),
    sunIlluminance: (world) => atmosphereNodes.scalarIlluminance(world).get('direct'),
    octaves: quality.cloudLayerOctaves,
  })
  let cloudTimeSeconds = 0
  const layerCamera = new THREE.Vector3()
  const drawingSize = new THREE.Vector2()
  /** 層の雲の uniform と、機体の光の雲の透過率を入れる。空を焼く前に呼ぶ */
  const updateCloudLayers = () => {
    camera.getWorldPosition(layerCamera)
    renderer.getDrawingBufferSize(drawingSize)
    const pixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(drawingSize.y, 1)
    cloudLayers.update(coverage, cloudTimeSeconds, layerCamera, pixelAngle)
    const octaves = Math.max(quality.cloudLayerOctaves - CLOUD_SHADOW_OCTAVE_DROP, 1)
    const sun = solar.sunDirectionWorld
    sky.setSunCloudTransmittance(layerSunTransmittance(anchor.x, anchor.y, anchor.z, sun, coverage, cloudTimeSeconds, octaves))
  }

  // 海面が読む太陽の向きと、寄せの基準（主カメラのワールド位置）。帳簿が `setSurfaceFrame` で入れる。
  // **組み込みの `cameraPosition` を使わない。**影を焼くパスでは光源のカメラが入る
  const surfaceSun = uniform(solar.sunDirectionWorld.clone())
  const surfaceCamera = uniform(new THREE.Vector3())

  // **環境反射は `?env=0` で外せる。**品質表の `skyEnvironment` に台本の指定を重ねる
  // （GLSL 経路の `scene.environment = showEnvironment ? ... : null` と同じ）
  if (options.showEnvironment === false) {
    ;(scene as unknown as { environmentNode: unknown }).environmentNode = null
  }

  // 場面に置く物。**円形スプライトは TSL 版を差す。**`ShaderMaterial` は
  // node 経路で黙って描かれない（例外は出ず、コンソールに 1 行出るだけ）
  //
  // **外板の細部は判定道具の上書きが勝つ**（`?materialdetail=`）。細部を
  // 入れるときだけ座標を焼く。入れなければ頂点属性も増えない
  const materialDetail = options.materialDetail ?? quality.materialDetail
  const canopyClearcoat = options.canopyClearcoat ?? quality.canopyClearcoat
  const explosionOcclusion = sceneOcclusion(depthTexture)
  const views = await createSceneViews({
    scene,
    quality,
    options,
    sprite: createNodeRadialSprite,
    // 爆発は場面のパスの外で描く（段 29c）。場面の物に隠される判定を材質に持たせる
    explosionSprite: (o) => createNodeRadialSprite(o, explosionOcclusion),
    trailMaterial: () => createNodeTrailMaterial(explosionOcclusion),
    material: toNodeAircraftMaterial(renderer, materialDetail, canopyClearcoat),
    ...(materialDetail !== 'none' ? { prepareModel: bakeAircraftSpace } : {}),
    ...(bloomEmissive ? { flameMaterial: toNodeFlameMaterial(renderer) } : {}),
    // ベイパーコーンはノイズで雲や靄のように揺らす（段 30f の手直し）
    vaporMaterial: createNodeVaporMaterial,
    // 爆発の火の玉。ノイズで輪郭が揺らぎ、橙から煤へ冷める（段 29b）
    fireball: () => createNodeFireballSprite(explosionOcclusion),
  })

  // **爆発は霞の後ろに重ねる**（段 29c）。場面のパスで描くと、深度を書かない
  // 爆発の画素に下の物の深度で霞が掛かり、水平線より下の煙が海面の霞に埋もれて
  // 水平線でまっすぐ切れた。爆発だけを別の場面へ移し、別のパスで描いて合成の最後に
  // 重ねる（段 S1 で捨てた GLSL 経路は場面のパスで描いていた）
  const overlayScene = new webgpu.Scene()
  overlayScene.name = 'Overlay'
  overlayScene.add(views.explosions.object)
  const { node: overlay, drawOnce: drawOverlayOnce } = createOverlayPass(overlayScene, camera)

  /**
   * 爆発の材質を先に組む（段 29 の締め）。**全部の板を不透明度 0 で、爆発のパスの
   * 描画先へ 1 度描く。**材質は初めて描くときに組まれるので、何もしないと最初の撃墜で
   * 組む待ちが出る。実機（Intel Xe-2LPG）で撃墜の 0.55 秒後に 0.4〜0.55 秒止まった。
   *
   * 描画先は毎フレーム消されるので絵に残らない。場面のパスと雲の履歴には触らないので、
   * キャプチャの絵も動かない。**本番と同じパスの `updateBefore` を通して描く**ので、
   * 同じ命令が組まれる
   */
  function prewarmExplosions(): void {
    const forward = camera.getWorldDirection(new THREE.Vector3())
    views.explosions.prewarm(camera.position, forward)
    views.explosionTrails.prewarm(camera.position, forward)
    // 発射炎と炎の尾も同じパスで描くので、最初の発射で組む待ちが出ないよう先に組む（段 B9）
    views.missileFlames.prewarm(camera.position, forward)
    views.flares.prewarm(camera.position, forward)
    // 本番と同じくパスの `updateBefore` を通して描く（`createOverlayPass` の注記）
    drawOverlayOnce(renderer)
    // 元に戻す。空の源で更新すれば、全部の枠が隠れる
    const none = { length: 0, explosionAt: () => { throw new Error('爆発は無い') } }
    views.explosions.update(none, 0, camera.position, forward)
    views.explosionTrails.update(none, 0, camera.position, forward)
    views.missileFlames.update([], camera.position, forward)
    views.flares.update([], camera.position, forward)
  }

  // 機体の影。**投げ手の側で `castShadow` を立てる。**光の側は
  // `buildNodePipeline` が組み立てのあとで立てる。
  // `renderer.shadowMap.enabled` を先に立てる必要があり、忘れると
  // ノードが本体を生成しないまま最初の描画で落ちる（`nodeShadow.ts`）
  const shadowLight = sky.sunLight
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
  // `?shadow=0`（画素の逆テストと切り分け）。段 S1b で GLSL の組み手と一緒に読み手が消え、
  // 段 S4b まで何もしていなかった。計測の切り替え（`setMeasureConfig` の `aircraftShadow`）と
  // 同じく投げ手の側で切る。光の `castShadow` は触らない（その注記）
  if (options.showAircraftShadow === false) {
    views.aircraft.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = false
    })
  }

  // ---- FFT の海（段 S3〜S4a で作り、段 S4b で既定にした。ADR 0046〜0049）----
  //
  // `?ocean=debug` のときは海の画面だけを出すので、海面は作らない
  const ocean = oceanDebug === null ? await createOceanSurfaceFor(options) : null
  if (ocean !== null) {
    ocean.setVisible(options.showWater ?? true)
    scene.add(ocean.mesh, ocean.plate)
  }
  const oceanCamera = new THREE.Vector3()
  /** 海を解いてテクスチャへ写し、パッチを選ぶ。場面を描く前に呼ぶ */
  const updateOcean = () => {
    if (ocean === null) return
    camera.getWorldPosition(oceanCamera)
    ocean.update(renderer, oceanCamera, oceanTicks)
  }

  async function createOceanSurfaceFor(o: SceneOptions) {
    const { createOceanSurface } = await import('../ocean/oceanSurface')
    return createOceanSurface(renderer, {
      quality,
      precision: o.oceanTexturePrecision ?? 16,
      ...(o.oceanAnisotropy !== undefined ? { anisotropy: o.oceanAnisotropy } : {}),
      ...(o.oceanFoamLevels !== undefined ? { foamLevels: o.oceanFoamLevels } : {}),
      ...(o.oceanFoamResolution !== undefined ? { foamResolution: o.oceanFoamResolution } : {}),
      ...(o.oceanSkipFar !== undefined ? { skipFar: o.oceanSkipFar } : {}),
      ...(o.oceanSkyLookups !== undefined ? { skyLookups: o.oceanSkyLookups } : {}),
      ...(o.oceanTurbidity !== undefined ? { turbidity: o.oceanTurbidity } : {}),
      // 空母は台本が要求したときだけ居る（`views.ts` と同じ判定と既定の置き方）
      carrier: o.carrierUrl !== undefined ? (o.carrier ?? { x: 0, z: 0, heading: 0 }) : null,
      lighting: {
        skyRadiance: (dir) => sky.radiance(dir),
        sunIlluminance: (world) => atmosphereNodes.scalarIlluminance(world).get('direct'),
        skyIlluminance: (world) => atmosphereNodes.scalarIlluminance(world).get('indirect'),
        sunDirection: surfaceSun as unknown as webgpu.Node<'vec3'>,
        // 太陽の遮りは層の雲 × 機体の影
        sunShade: (world) => cloudLayers.sunTransmittance(world).mul(aircraftShade) as unknown as webgpu.Node<'float'>,
        camera: surfaceCamera as unknown as webgpu.Node<'vec3'>,
      },
    })
  }

  /**
   * 雲を合成へ出すか。`setMeasureConfig({ clouds: false })` で 0 にする。
   *
   * **旧経路はパスごと止めて差し込み口も外す**（`webgl.ts`）。node 経路は
   * 鎖の組み直しになるので uniform で掛ける。**費用は下がらない。**
   * 見た目を消すためのもので、計測で「雲なしの費用」を測る用途には使えない
   * （`sky` の切り替えと同じ制約。この注記の上にある）。
   *
   * **切れないままだと計測と切り分けの手段が失われる。**実際、雲の追従を
   * 追う診断が「雲あり/なしの差」で雲の領域を求めていて、切れないせいで
   * 差が出ず、雲が 1/9 しかないという誤った読みを出した（2026-09-14）
   */
  const cloudVisibility = uniform(options.showClouds === false ? 0 : 1)

  /**
   * ブルームの強さと閾値。**露出が変わったら閾値も動かす。**
   *
   * 閾値は露出前の値で渡す（`quality.ts` の `bloomStrength` の注記）。
   * `?exposure=` と `setExposure` で露出が実行時に変わるので、定数で焼くと
   * 露出を振った瞬間に「どの明るさから光るか」の意味がずれる。
   */
  // 発光体をブルームの入力へ足す倍率。**掃引の上書きが勝つ**（`?emissivegain=`）
  const emissiveGain = uniform(options.emissiveGain ?? EMISSIVE_BLOOM_GAIN)
  const bloomStrength = uniform(options.bloomStrength ?? quality.bloomStrength)

  /**
   * 荷重倍数。風圧の演出がここから強さを決める。
   *
   * **uniform で持つ。**毎フレーム変わるので鎖を組み直せない。1 G では
   * 演出が 0 になるので、水平飛行の 42 枚は動かない（動くのは高 G の
   * カットだけ）。
   */
  const loadFactor = uniform(1)
  // 陽炎の範囲と強さ（ADR 0041）。風圧と同じく毎フレーム書き換える
  const hazeStart = uniform(new THREE.Vector2())
  const hazeEnd = uniform(new THREE.Vector2())
  const hazeRadius = uniform(new THREE.Vector2())
  const hazeStrength = uniform(0)
  const hazeTime = uniform(0)
  const hazeAspect = uniform(1)
  const bloomAfterExposure = options.bloomThreshold ?? BLOOM_THRESHOLD_AFTER_EXPOSURE
  const bloomThreshold = uniform(
    bloomThresholdFor(renderer.toneMappingExposure, bloomAfterExposure),
  )

  /**
   * ポストの鎖を組む。**プリセットが変わったら組み直す。**
   *
   * 切り出したのは、品質でポストの段を出し入れするため。`applyPreset` は
   * これまで鎖に触らなかったので、プリセットに載せた設定を鎖が読めなかった。
   * GLSL 側は `composer.ts` の `buildEffectPass(quality)` が既にこの形。
   *
   * **`RenderPipeline` は `outputNode` の差し替えを正式に受ける。**
   * `needsUpdate` を立てると `_updateContext` が組み直す（`RenderPipeline.js`）。
   * 同じ形の前例が環境反射（`applyPreset` の中）と `?env=0` の切り替えにある。
   */
  function buildOutput(q: QualitySettings): webgpu.Node {
    if (oceanDebug !== null) {
      // 色をそのまま出す（トーンマッピングを通さない）
      ownsOutputTransform = true
      return oceanDebug.node as unknown as webgpu.Node
    }
    // **強さは鎖の外で持つ。**プリセットが変わっても組み直さずに済む値は
    // uniform にして、組み直しは段の出し入れだけに絞る
    // **掃引の上書きが勝つ。**プリセットの値は表の側の既定で、`?bloomstrength=`
    // は「その値を振って決めるため」の口
    bloomStrength.value = options.bloomStrength ?? q.bloomStrength
    const built = createNodeOutputNode({
      aerial: sky.aerial,
      smaa: smaa as unknown as (node: webgpu.Node) => webgpu.Node,
      scenePass,
      cloudNode: cloudLayerTexture(
        cloudLayers,
        (scenePass.getTextureNode('depth') as unknown as { x: webgpu.Node<'float'> }).x,
        q.cloudLayerResolutionScale,
      ).mul(cloudVisibility) as unknown as webgpu.Node<'vec4'>,
      overlay,
      quality: q,
      bloom: bloom as unknown as BloomFactory,
      bloomStrength: bloomStrength as unknown as webgpu.Node<'float'>,
      bloomThreshold: bloomThreshold as unknown as webgpu.Node<'float'>,
      showBloom: options.bloom ?? true,
      bloomActive: (options.bloomStrength ?? q.bloomStrength) > 0,
      emissiveNode,
      emissiveGain: emissiveGain as unknown as webgpu.Node<'float'>,
      lens: {
        radialBlur: radialBlur as unknown as never,
        renderOutput: tslDisplay.renderOutput as unknown as never,
      },
      loadFactor: loadFactor as unknown as webgpu.Node<'float'>,
      showLens: options.lens ?? true,
      lensStage: options.lensStage ?? 'full',
      heatHaze: {
        start: hazeStart as unknown as webgpu.Node<'vec2'>,
        end: hazeEnd as unknown as webgpu.Node<'vec2'>,
        radius: hazeRadius as unknown as webgpu.Node<'vec2'>,
        strength: hazeStrength as unknown as webgpu.Node<'float'>,
        time: hazeTime as unknown as webgpu.Node<'float'>,
        aspect: hazeAspect as unknown as webgpu.Node<'float'>,
      },
      showHeatHaze: options.heatHaze ?? true,
    })
    // **`?smaa=0` で外せる。**42 枚は全画素が動くので、原因ごとの寄与は
    // 1 つずつ振って測るしかない（段 20a-4 の差分の台帳）
    // **`ownsOutputTransform` を持ち出す。**鎖が `renderOutput` を挟んだ
    // かどうかを `buildNodePipeline` が知る必要がある
    ownsOutputTransform = built.ownsOutputTransform
    return (options.smaa ?? true) ? built.outputNode : built.composite
  }

  let ownsOutputTransform = false
  const outputNode = buildOutput(quality)

  const built = await buildNodePipeline({
    renderer,
    scene,
    camera,
    outputNode,
    ownsOutputTransform,
    // **立てていないときは渡さない。**渡すと `castShadow` が立ち、
    // low プリセットで「影が切れている」の検査が通らない
    shadowLight: shadowInfo.enabled ? shadowLight : null,
  })
  const pipeline = built.pipeline
  prewarmExplosions()

  const gpuTimer: GpuTimer = createGpuTimer(backend)

  // ---- 放射輝度を LUT から読み戻す ----
  //
  // **海・雲が実際に使う値を、GPU から読み戻す。**機体の光の色は CPU が
  // 同じ式で出す（`sky/hillaireSky.ts`）が、計器と `太陽光の色が時刻で変わる` は
  // 場面の照度そのものを見る。段 S2b-2 までは takram の `AtmosphereLight` が色を
  // 持たず、これが CPU で読める唯一の値だった。
  //
  // 照度を 1 点で焼いて読み戻す。**毎フレームは焼かない。**太陽が動いた
  // ときだけで、読み戻しは非同期なので値は数枚遅れる
  const radianceQuad = createBakeQuad()
  const sunRadiance = new THREE.Vector3()
  const skyRadiance = new THREE.Vector3()

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
    camera.aspect = cssWidth / cssHeight
    camera.updateProjectionMatrix()
  }
  applySize()

  /** 最後の `render()` のフレーム番号（`info.frame`）。段 S0e */
  let renderFrameId = 0
  const cameraWorld = new THREE.Vector3()

  function renderPlainImpl(): void {
    backend.resetInfo()
    // **番号を進めないと場面のパスが 1 枚目しか走らない。**理由は
    // `nodeBuild.ts` の `advanceNodeFrame` の注記
    advanceNodeFrame(renderer)
    updateCloudLayers()
    updateSky()
    oceanDebug?.sim.update(renderer, oceanTicks, 0)
    updateOcean()
    pipeline.render()
  }

  // いま `environmentNode` に入っている大きさ。0 は切っている状態
  let environmentOn = options.showEnvironment !== false && quality.skyEnvironment

  function applyPreset(preset: PresetName): void {
    quality = getQuality(preset)
    cloudLayers.setOctaves(quality.cloudLayerOctaves)
    ocean?.setQuality(quality)
    views.trails.setQuality(quality)
    views.missileSmoke.setQuality(quality)
    views.damageSmoke.setQuality(quality)
    views.explosions.setQuality(quality)
    views.explosionTrails.setQuality(quality)
    // **影は `nodeShadow` に任せる。**ここで `mapSize` を直に書くと `low` の
    // 0 がそのまま渡り、0×0 のテクスチャで描画ループごと止まる（段 20c）
    shadowInfo.setQuality(quality)
    // 環境反射は**大きさが変わったときだけ**作り直す。
    //
    // 毎回作り直すと、降格のたびにキューブの的が増える。`?env=0` の指定も
    // 踏み潰していた（起動で null にしても最初の降格で戻る。段 20c で実測）
    const wantedEnv = options.showEnvironment !== false && quality.skyEnvironment
    if (wantedEnv !== environmentOn) {
      environmentOn = wantedEnv
      const sceneNodes = scene as unknown as { environmentNode: unknown }
      sceneNodes.environmentNode = environmentFor(wantedEnv)
      pipeline.needsUpdate = true
    }
    // **ポストの鎖もプリセットで変わる。**組み直さないと、表に載せた設定を
    // 鎖が読まないまま降格する。実測で `品質を 4 段切り替えても描画が続く` と
    // `1,200 フレーム飛んでも描画が止まらない` の 2 本がここを通る
    pipeline.outputNode = buildOutput(quality)
    // **プリセットで風圧が出入りすると、色変換の持ち主も変わる。**
    // low は `lensEffects: false` なので鎖が `renderOutput` を挟まない。
    // 戻し忘れると**トーンマッピングが掛からないまま**リニアの絵が出る
    // （逆に切り忘れると 2 度掛かる）
    pipeline.outputColorTransform = !ownsOutputTransform
    pipeline.needsUpdate = true
    applySize()
  }

  return {
    backend,
    scene,
    camera,
    chase,

    ocean:
      ocean === null
        ? null
        : {
            get patchCount() {
              return ocean.patchCount
            },
            get triangleCount() {
              return ocean.triangleCount
            },
            precision: ocean.textures.precision,
          },
    aircraft: views.aircraft,
    targetViews: views.targetViews,
    enemyViews: views.enemyViews,
    tracers: views.tracers,
    missileViews: views.missileViews,
    missileSmoke: views.missileSmoke,
    damageSmoke: views.damageSmoke,
    explosions: views.explosions,
    explosionTrails: views.explosionTrails,
    flares: views.flares,
    missileFlames: views.missileFlames,
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
      // 光の向きは `sky.update` が太陽の向きから入れ直す
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
      solar = sunFrameFor(hour)
      ;(surfaceSun.value as THREE.Vector3).copy(solar.sunDirectionWorld)
      sky.setSun(solar.sunDirectionWorld)
      void refreshRadiance()
    },

    setSurfaceFrame(frame) {
      ;(surfaceSun.value as THREE.Vector3).copy(frame.sunDirectionWorld)
      ;(surfaceCamera.value as THREE.Vector3).copy(frame.morphOrigin)
    },

    updateClouds(update) {
      oceanTicks = Math.round(update.cloudTime / FIXED_DT)
      coverage = update.coverage
      cloudTimeSeconds = update.cloudTime
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
    get gpuPasses() {
      return gpuTimer.lastPasses
    },
    get gpuPassMismatches() {
      return gpuTimer.passMismatches
    },
    get gpuPassHistory() {
      return gpuTimer.passHistory
    },
    get renderFrameId() {
      return renderFrameId
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
      // GPU の timestamp の鍵に入る番号。CPU の内訳を同じ番号で残すために控える（段 S0e）
      renderFrameId = renderer.info.frame
      gpuTimer.begin()
      updateCloudLayers()
      updateSky()
      oceanDebug?.sim.update(renderer, oceanTicks, 0)
      updateOcean()
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
      // **閾値も動かす。**鎖の中は露出前なので、露出を変えると「露出後で
      // どの明るさから光るか」がずれる（`quality.ts` の注記）
      bloomThreshold.value = bloomThresholdFor(value, bloomAfterExposure)
    },

    setHeatHaze(state) {
      hazeStart.value.set(state.startX, state.startY)
      hazeEnd.value.set(state.endX, state.endY)
      hazeRadius.value.set(state.startRadius, state.endRadius)
      hazeStrength.value = state.strength
      hazeTime.value = state.time
      hazeAspect.value = camera.aspect
    },

    setLoadFactor(value) {
      loadFactor.value = value
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
        // **黙って無視しない。**背景のノードを外せば空は消えるが、
        // 読まれるのは組み立ての中なので鎖の組み直しが要る。掃引は
        // 条件を周回ごとに切り替えるので、組み直しを挟むと計測そのものを
        // 壊す。uniform で 0 にする手は評価が走るぶん費用が下がらず、
        // 「空なし」の行が意味のない 0 になる
        throw new Error(
          '空の切り替えは node 経路にない。`Scene.backgroundNode` は' +
            '組み立ての中で読まれるので、切り替えるには鎖の組み直しが要る',
        )
      }
      if (config.water !== undefined) ocean?.setVisible(config.water)
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
          ? environmentFor(quality.skyEnvironment)
          : null
        pipeline.needsUpdate = true
      }
      if (config.clouds !== undefined) {
        // 合成から外す（費用は下がらない。下の注記）
        cloudVisibility.value = config.clouds ? 1 : 0
      }
      if (config.lodDistanceScale !== undefined) {
        ocean?.setQuality({ ...quality, lodDistanceScale: config.lodDistanceScale })
      }
    },

    dispose() {
      gpuTimer.dispose()
      views.dispose()
      radianceQuad.dispose()
      sky.dispose()
      oceanDebug?.sim.dispose()
      ocean?.dispose()
      renderer.dispose()
    },
  }
}

/**
 * 海の画面を組む（`?ocean=debug`）。海のモジュールは画面を開いたときだけ読む。
 * 条件は web-ocean の既定（`WEB_OCEAN_DEFAULTS`）で、計測用の口でカスケード数と格子を振る
 */
async function createOceanDebug(options: SceneOptions) {
  const [{ createOceanSimulation }, { createOceanDebugNode }, { WEB_OCEAN_DEFAULTS }] = await Promise.all([
    import('../ocean/oceanNodes'),
    import('../ocean/oceanDebug'),
    import('../ocean/reference'),
  ])
  const params = {
    ...WEB_OCEAN_DEFAULTS,
    cascades: WEB_OCEAN_DEFAULTS.cascades.slice(0, options.oceanCascades ?? WEB_OCEAN_DEFAULTS.cascades.length),
    size: options.oceanFftSize ?? WEB_OCEAN_DEFAULTS.size,
  }
  const sim = createOceanSimulation(params)
  return { sim, params, node: createOceanDebugNode(sim, params) }
}

/** 時刻から太陽の向き（three の `Vector3` で持つ）と高度 */
function sunFrameFor(hour: number): { sunDirectionWorld: THREE.Vector3; sunElevationDeg: number } {
  const frame = sunFrameForHour(hour)
  const d = frame.sunDirectionWorld
  return { sunDirectionWorld: new THREE.Vector3(d.x, d.y, d.z), sunElevationDeg: frame.sunElevationDeg }
}
