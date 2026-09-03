import * as THREE from 'three'
import { getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere'
import { Geodetic } from '@takram/three-geospatial'
import { loadAircraftModel } from '../aircraft/model'
import {
  DETAIL_SIZE,
  NOISE_SLICE_SIDE,
  SHAPE_SIZE,
  WEATHER_SIZE,
} from '../clouds/noise'
import {
  SHADOW_SIZE,
  shadowHistogram,
  shadowTileMeans,
  tileMeans,
} from '../clouds/geometry'
import { SHADOW_EXTENT } from '../clouds/cloudsPass'
import type { ShadowInputs } from '../clouds/shadowInputs'
import {
  MARCH_PROBE_AMBIENT,
  MARCH_PROBE_ASPECT,
  MARCH_PROBE_CAMERA,
  MARCH_PROBE_CLOUD_TIME,
  MARCH_PROBE_COVERAGE,
  MARCH_PROBE_HEIGHT,
  MARCH_PROBE_LIGHT_GROWTH,
  MARCH_PROBE_LIGHT_STEPS,
  MARCH_PROBE_MAX_DISTANCE,
  MARCH_PROBE_MAX_STEPS,
  MARCH_PROBE_PIXEL_JITTER,
  MARCH_PROBE_START_JITTER,
  MARCH_PROBE_STEP_GROWTH,
  MARCH_PROBE_SUN,
  MARCH_PROBE_SUN_COLOR,
  MARCH_PROBE_USE_DETAIL,
  MARCH_PROBE_WIDTH,
  RESOLVE_PROBE_BLEND_WEIGHT,
  RESOLVE_PROBE_CLAMP_SCALE,
  RESOLVE_PROBE_JITTER_B,
  RESOLVE_PROBE_PREVIOUS_CAMERA,
  marchExhaustedCount,
  marchSampleStats,
} from '../clouds/marchProbe'
import { HASH_PROBE_SIDE } from '../hashReference'
import { loadCarrier, placeCarrier, DECK_HEIGHT } from '../carrier'
import {
  createLocalFrame,
  dateForHour,
  REFERENCE_LATITUDE,
  REFERENCE_LONGITUDE,
} from '../atmosphere'
import type { NodeProbeResult } from './types'

/**
 * node 経路を立てて glb を 1 枚描く。
 *
 * 段 9 の目的は移行の前提を測ることであって、絵を作ることではない。
 * 確かめるのは 3 つ。`WebGPURenderer` が `await renderer.init()` を経て
 * 立つこと。`three` と `three/webgpu` がコアクラスを共有すること。
 * glb の材質（`MeshStandardMaterial`）が無変換で描けること。
 *
 * **雲も地形も海面も入れない。**それらは `ShaderMaterial` で書いてあり、
 * `StandardNodeLibrary` に登録がない。移すのは段 11 以降で、この段では
 * 「入れていないから出ない」を確かめるところまで。
 *
 * **入れても落ちない。**実測すると `THREE.NodeBuilder: Material
 * "ShaderMaterial" is not compatible.` をコンソールへ出したまま描画は進み、
 * `initError` も立たない。例外で止まると思っていると、エラーを 1 行見落と
 * した時点で「動いている」と読んでしまう。だから `shaderMaterials` を
 * 数えて構造でも見張る。
 */
export interface NodeProbeOptions {
  /** 1 = `forceWebGL: true`、2 = WebGPU */
  gpu: number
  aircraftUrl: string
  carrierUrl: string
  width: number
  height: number
  /** 定常状態で測る枚数。既定 8 */
  frames?: number
  /** 時刻 0〜24。WebGL 経路と同じ太陽が出ることを確かめるのに使う */
  hour: number
  /** 大気の LUT の解像度の倍率。プリセットの `atmosphereLutScale` */
  lutScale: number
  /** 空から焼く環境反射の一辺。0 で焼かない */
  skyEnvironmentSize: number
  /** 遠景の霞を光線行進で解くか */
  raymarchScattering: boolean
  /**
   * 雲影を焼くときの入力。null なら焼かない。
   *
   * **GLSL 側が実際に焼いた値をそのまま受け取る。**`?shadowinputs=` で渡す。
   * ここで導き直すと、導き方が食い違ったときにヒストグラムの不一致が
   * 移植の欠陥に見える
   */
  shadowInputs: ShadowInputs | null
  /**
   * 高さ場を TSL で引いて出すか。`?heightprobe=1`。
   *
   * 標本点は `terrain/heightProbe.ts` が唯一の定義で、CPU 側も同じ式で引く
   */
  heightProbe: boolean
  /**
   * 雲のマーチを固定の入力で焼くか。`?marchprobe=1`。
   *
   * 入力は `clouds/marchProbe.ts` が唯一の定義で、GLSL 側も同じものを読む
   */
  marchProbe: boolean
}

export async function runNodeProbe(
  canvas: HTMLCanvasElement,
  options: NodeProbeOptions,
): Promise<NodeProbeResult> {
  // **動的に読む。**`three/webgpu` は 2.2 MB あり、既定の経路には要らない。
  // コアは `three.core.js` から来るので `three` 側と実体を共有する
  const webgpu = await import('three/webgpu')
  const sharedCore = (webgpu as unknown as { Mesh: unknown }).Mesh === THREE.Mesh

  const initStarted = performance.now()
  const renderer = new webgpu.WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: options.gpu === 1,
  })
  // **これを忘れると描けない。**`WebGLRenderer` と違ってバックエンドの
  // 取得が非同期なので、起動列へ入れる必要がある
  await renderer.init()
  const initMs = performance.now() - initStarted

  const isWebGPU = 'isWebGPUBackend' in renderer.backend

  // ---- 雲ノイズと気象マップを TSL で焼く ----
  //
  // **体積をそのまま焼く。**段 11 は 1 スライスを 2D のレンダーターゲットへ
  // 焼いて比べていた。式の一致は見られるが、**層への焼き込みは見張られない。**
  // 64³ を焼いて中央スライスを引き出せば、式と層の両方が 1 つの検査に乗る。
  // 密度と雲影を走らせるにも体積そのものが要る
  const tsl = await import('three/tsl')
  const noiseNodes = await import('../clouds/noiseNodes')
  const volume = await import('../clouds/volume')

  const quad = volume.createBakeQuad()
  const bakeStarted = performance.now()

  // GLSL 版と同じ周波数の上限を使う。`noise.ts` の `bakeVolume` の式を写す。
  // 1 セルに 4 テクセル確保できるところまで。超えると白色ノイズになる
  const maxFreq = (size: number): number => Math.max(1, Math.floor(size / 4))

  const shapeVolume = volume.bakeVolume(renderer, quad, {
    side: SHAPE_SIZE,
    fragment: (layer) =>
      noiseNodes.noiseFragmentNode(0, maxFreq(SHAPE_SIZE), layer),
  })
  const detailVolume = volume.bakeVolume(renderer, quad, {
    side: DETAIL_SIZE,
    fragment: (layer) =>
      noiseNodes.noiseFragmentNode(1, maxFreq(DETAIL_SIZE), layer),
  })
  const weatherPlane = volume.bakePlane(
    renderer,
    quad,
    WEATHER_SIZE,
    WEATHER_SIZE,
    noiseNodes.weatherFragmentNode(),
    // 世界座標で引き回すので折り返す。GLSL 版と揃える
    { repeat: true },
  )
  const volumeMs = performance.now() - bakeStarted

  // GLSL 版（`noise.ts` の `sampleSlice`）が読むのと同じ層の同じ左下 16x16
  const noiseSlice = await volume.readVolumeSlice(
    renderer,
    quad,
    shapeVolume.texture,
    Math.floor(SHAPE_SIZE / 2),
    NOISE_SLICE_SIDE,
    isWebGPU,
  )

  // 気象マップも突き合わせる。**雲の配置を決めるのはこちら。**ずれると
  // 雲の湧く場所が変わるが、雲影の分布では捕まらない
  const weatherSlice = await volume.readPlaneSlice(
    renderer,
    quad,
    weatherPlane.texture,
    NOISE_SLICE_SIDE,
    isWebGPU,
  )

  const hashTarget = volume.bakePlane(
    renderer,
    quad,
    HASH_PROBE_SIDE,
    HASH_PROBE_SIDE,
    noiseNodes.hashProbeFragmentNode(HASH_PROBE_SIDE),
  )
  const hashProbe = await volume.readPlane(
    renderer,
    hashTarget,
    HASH_PROBE_SIDE,
    HASH_PROBE_SIDE,
    isWebGPU,
  )
  hashTarget.dispose()

  // ---- 雲影マップ ----
  //
  // **段 12 の合格条件。**GLSL 版が焼いた 256² と 16 ビンのヒストグラムで
  // 比べ、L1 距離 0.01 未満を求める。入力は GLSL 側が実際に使った値をもらう
  // ので、食い違えば移植の欠陥だと言い切れる
  let shadowBins: number[] | null = null
  let shadowTiles: number[] | null = null
  if (options.shadowInputs !== null) {
    const densityNodes = await import('../clouds/densityNodes')
    const shadow = options.shadowInputs
    const shadowTarget = volume.bakePlane(
      renderer,
      quad,
      SHADOW_SIZE,
      SHADOW_SIZE,
      densityNodes.cloudShadowFragmentNode(
        {
          shapeNoise: shapeVolume.texture,
          detailNoise: detailVolume.texture,
          weatherMap: weatherPlane.texture,
          cloudTime: tsl.float(shadow.cloudTime),
          coverage: tsl.float(shadow.coverage),
        },
        tsl.uv(),
        tsl.vec2(shadow.centerX, shadow.centerZ),
        tsl.float(SHADOW_EXTENT),
        tsl.vec3(shadow.sunX, shadow.sunY, shadow.sunZ),
      ),
    )
    // ヒストグラムは並びを問わないが、読み戻しの道は 1 本にしておく
    const bytes = await volume.readPlane(
      renderer,
      shadowTarget,
      SHADOW_SIZE,
      SHADOW_SIZE,
      isWebGPU,
    )
    shadowBins = shadowHistogram(bytes)
    // **配置も出す。**分布だけでは影が同じ場所にあることを言えない
    shadowTiles = shadowTileMeans(bytes, SHADOW_SIZE)
    shadowTarget.dispose()
  }

  // ---- 雲のマーチ ----
  //
  // **段 13 の合格条件。**固定のカメラと固定の入力で 3 枚焼き、GLSL 版と
  // 突き合わせる。密度サンプル数と打ち切りの数は整数なので、歩き方が
  // 同じなら完全に一致するはず。絵は演算順序で動くので区画平均で見る
  let march: NodeProbeResult['march'] = null
  if (options.marchProbe) {
    const marchNodes = await import('../clouds/marchNodes')

    const marchCamera = new THREE.PerspectiveCamera(
      MARCH_PROBE_CAMERA.fov,
      MARCH_PROBE_ASPECT,
      MARCH_PROBE_CAMERA.near,
      MARCH_PROBE_CAMERA.far,
    )
    marchCamera.position.set(
      MARCH_PROBE_CAMERA.positionX,
      MARCH_PROBE_CAMERA.positionY,
      MARCH_PROBE_CAMERA.positionZ,
    )
    marchCamera.lookAt(
      MARCH_PROBE_CAMERA.targetX,
      MARCH_PROBE_CAMERA.targetY,
      MARCH_PROBE_CAMERA.targetZ,
    )
    marchCamera.updateMatrixWorld()
    marchCamera.updateProjectionMatrix()

    // `@types/three` は `uniform()` の戻りを TSL のノード型へ絞らないので、
    // 逃げ口を 1 か所へ寄せる
    const node = <T>(value: unknown): T => tsl.uniform(value as never) as unknown as T

    const marchInputs = {
      shapeNoise: shapeVolume.texture,
      detailNoise: detailVolume.texture,
      weatherMap: weatherPlane.texture,
      cloudTime: tsl.float(MARCH_PROBE_CLOUD_TIME),
      coverage: tsl.float(MARCH_PROBE_COVERAGE),
      // 遮蔽物を置かないので深度は 1.0（空）で固定
      sceneDepth: tsl.float(1),
      inverseProjectionMatrix: node<Parameters<
        typeof marchNodes.cloudMarchFragmentNode
      >[0]['inverseProjectionMatrix']>(marchCamera.projectionMatrixInverse),
      inverseViewMatrix: node<Parameters<
        typeof marchNodes.cloudMarchFragmentNode
      >[0]['inverseViewMatrix']>(marchCamera.matrixWorld),
      cameraPositionWorld: tsl.vec3(
        MARCH_PROBE_CAMERA.positionX,
        MARCH_PROBE_CAMERA.positionY,
        MARCH_PROBE_CAMERA.positionZ,
      ),
      cameraNear: tsl.float(MARCH_PROBE_CAMERA.near),
      cameraFar: tsl.float(MARCH_PROBE_CAMERA.far),
      sunDirection: tsl.vec3(MARCH_PROBE_SUN.x, MARCH_PROBE_SUN.y, MARCH_PROBE_SUN.z),
      sunColor: tsl.vec3(
        MARCH_PROBE_SUN_COLOR.x,
        MARCH_PROBE_SUN_COLOR.y,
        MARCH_PROBE_SUN_COLOR.z,
      ),
      ambientColor: tsl.vec3(
        MARCH_PROBE_AMBIENT.x,
        MARCH_PROBE_AMBIENT.y,
        MARCH_PROBE_AMBIENT.z,
      ),
      maxSteps: tsl.int(MARCH_PROBE_MAX_STEPS),
      lightSteps: tsl.int(MARCH_PROBE_LIGHT_STEPS),
      lightGrowth: tsl.float(MARCH_PROBE_LIGHT_GROWTH),
      maxMarchDistance: tsl.float(MARCH_PROBE_MAX_DISTANCE),
      stepGrowthScale: tsl.float(MARCH_PROBE_STEP_GROWTH),
      startJitter: tsl.float(MARCH_PROBE_START_JITTER),
      pixelJitter: tsl.vec2(MARCH_PROBE_PIXEL_JITTER.x, MARCH_PROBE_PIXEL_JITTER.y),
      useDetail: MARCH_PROBE_USE_DETAIL,
    }

    const bakeMarch = async (mode: 0 | 1 | 2): Promise<number[]> => {
      const target = volume.bakePlane(
        renderer,
        quad,
        MARCH_PROBE_WIDTH,
        MARCH_PROBE_HEIGHT,
        marchNodes.cloudMarchFragmentNode(marchInputs, mode),
      )
      const bytes = await volume.readPlane(
        renderer,
        target,
        MARCH_PROBE_WIDTH,
        MARCH_PROBE_HEIGHT,
        isWebGPU,
      )
      target.dispose()
      return bytes
    }

    // ---- 時間方向の足し込み ----
    //
    // 現フレームと履歴には、**ずらしだけを変えたマーチの出力そのもの**を
    // 使う。マーチが両側でバイトまで一致することは前半で確かめてあるので、
    // 入力が同じであることは言い切れる
    const resolveNodes = await import('../clouds/resolveNodes')
    const bakeMarchTarget = (startJitter: number) =>
      volume.bakePlane(
        renderer,
        quad,
        MARCH_PROBE_WIDTH,
        MARCH_PROBE_HEIGHT,
        marchNodes.cloudMarchFragmentNode({ ...marchInputs, startJitter: tsl.float(startJitter) }, 0),
      )

    const currentTarget = bakeMarchTarget(MARCH_PROBE_START_JITTER)
    const historyTarget = bakeMarchTarget(RESOLVE_PROBE_JITTER_B)

    const previousCamera = new THREE.PerspectiveCamera(
      RESOLVE_PROBE_PREVIOUS_CAMERA.fov,
      MARCH_PROBE_ASPECT,
      RESOLVE_PROBE_PREVIOUS_CAMERA.near,
      RESOLVE_PROBE_PREVIOUS_CAMERA.far,
    )
    previousCamera.position.set(
      RESOLVE_PROBE_PREVIOUS_CAMERA.positionX,
      RESOLVE_PROBE_PREVIOUS_CAMERA.positionY,
      RESOLVE_PROBE_PREVIOUS_CAMERA.positionZ,
    )
    previousCamera.lookAt(
      RESOLVE_PROBE_PREVIOUS_CAMERA.targetX,
      RESOLVE_PROBE_PREVIOUS_CAMERA.targetY,
      RESOLVE_PROBE_PREVIOUS_CAMERA.targetZ,
    )
    previousCamera.updateMatrixWorld()
    previousCamera.updateProjectionMatrix()
    const previousViewProjection = new THREE.Matrix4().multiplyMatrices(
      previousCamera.projectionMatrix,
      previousCamera.matrixWorldInverse,
    )

    const resolveTarget = volume.bakePlane(
      renderer,
      quad,
      MARCH_PROBE_WIDTH,
      MARCH_PROBE_HEIGHT,
      resolveNodes.cloudResolveFragmentNode({
        currentFrame: currentTarget.texture,
        historyFrame: historyTarget.texture,
        inverseProjectionMatrix: marchInputs.inverseProjectionMatrix,
        inverseViewMatrix: marchInputs.inverseViewMatrix,
        previousViewProjection: node<
          typeof marchInputs.inverseViewMatrix
        >(previousViewProjection),
        cameraPositionWorld: marchInputs.cameraPositionWorld,
        blendWeight: tsl.float(RESOLVE_PROBE_BLEND_WEIGHT),
        texelSize: tsl.vec2(1 / MARCH_PROBE_WIDTH, 1 / MARCH_PROBE_HEIGHT),
        clampScale: RESOLVE_PROBE_CLAMP_SCALE,
      }),
    )
    const resolveBytes = await volume.readPlane(
      renderer,
      resolveTarget,
      MARCH_PROBE_WIDTH,
      MARCH_PROBE_HEIGHT,
      isWebGPU,
    )
    currentTarget.dispose()
    historyTarget.dispose()
    resolveTarget.dispose()

    march = {
      samples: marchSampleStats(await bakeMarch(1)),
      exhausted: marchExhaustedCount(await bakeMarch(2)),
      tiles: tileMeans(await bakeMarch(0), MARCH_PROBE_WIDTH, MARCH_PROBE_HEIGHT),
      resolve: resolveBytes,
    }
  }

  // ---- 高さ場 ----
  //
  // **段 14 の合格条件。**64 点を焼いて読み戻し、`src/sim/terrain.ts` の
  // `heightAt` と 1e-3 m 以内で一致することを見る。ずれると「見えている山と
  // 当たる山が違う」状態になり、高さ場を sim に持たせた意味がなくなる
  let heightProbe: number[] | null = null
  if (options.heightProbe) {
    const heightNodes = await import('../terrain/heightNodes')
    const { defaultTerrain } = await import('../../sim/terrain')
    const { createHeightTexture } = await import('../terrain/heightTexture')
    const probe = await import('../terrain/heightProbe')

    const terrain = defaultTerrain()
    const heightMap = createHeightTexture(terrain)
    const fieldInputs = {
      heightMap,
      extent: terrain.extent,
      texels: terrain.size,
    }

    const side = probe.HEIGHT_PROBE_SIDE
    heightProbe = []
    for (const region of probe.HEIGHT_PROBE_REGIONS) {
      // 画素の位置から標本点を導く。`heightProbePoint` と同じ式
      const col = tsl.int(tsl.uv().x.mul(side))
      const row = tsl.int(tsl.uv().y.mul(side))
      const world = tsl.vec2(
        tsl.float(col).mul(region.step.x).add(region.origin.x),
        tsl.float(row).mul(region.step.z).add(region.origin.z),
      )
      const heightTarget = volume.bakePlane(
        renderer,
        quad,
        side,
        side,
        tsl.vec4(heightNodes.terrainHeightNode(fieldInputs, world), 0, 0, 1),
        // **8bit では mm の精度が出ない。**32bit 浮動小数で受ける
        { float: true },
      )
      heightProbe.push(
        ...probe.heightProbeValues(
          await volume.readPlane(renderer, heightTarget, side, side, isWebGPU),
        ),
      )
      heightTarget.dispose()
    }
    heightMap.dispose()
  }

  quad.dispose()
  shapeVolume.dispose()
  detailVolume.dispose()
  weatherPlane.dispose()

  renderer.setPixelRatio(1)
  renderer.setSize(options.width, options.height, false)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a1c26)
  const camera = new THREE.PerspectiveCamera(
    60,
    options.width / options.height,
    1,
    5_000,
  )
  camera.position.set(0, DECK_HEIGHT + 45, 190)
  camera.lookAt(0, DECK_HEIGHT, 0)

  const model = await loadAircraftModel(options.aircraftUrl)
  model.object.position.set(0, DECK_HEIGHT + 8, 0)
  scene.add(model.object)

  const carrier = await loadCarrier(options.carrierUrl)
  placeCarrier(carrier, 0, 0, 0)
  scene.add(carrier.object)

  // ---- 大気 ----
  //
  // **WebGPU バックエンドのときだけ組む。**node 経路の WebGL2
  // フォールバックでは、大気の構造体が GLSL のコンパイルで落ちる
  // （`ERROR: 0:76: 'AtmosphereParameters' : syntax error`。実測）。
  // 計画は `forceWebGL: true` を移行中の退避路として当てにしていたが、
  // **大気には効かない。**
  let atmosphereContext: InstanceType<
    typeof import('@takram/three-atmosphere/webgpu').AtmosphereContext
  > | null = null
  let sunElevationDeg = 0

  if (isWebGPU) {
    // ---- 大気を node 経路で組む ----
    //
    // WebGL 経路は 4.1 MB の EXR を読んで `SkyMaterial` へ流し込んでいた。
    // node 経路は LUT を実行時に GPU で計算する。**その費用を測るのが
    // この段の主目的。**
    const atmos = await import('@takram/three-atmosphere/webgpu')

    // 原点も時刻も WebGL 経路と同じものを使う。**別々に持つと、絵を見比べても
    // 分からないずれ方をする**
    const referenceEcef = new Geodetic(
      REFERENCE_LONGITUDE,
      REFERENCE_LATITUDE,
      0,
    ).toECEF()
    const worldToECEF = createLocalFrame(referenceEcef)
    const date = dateForHour(options.hour)
    const sunDirectionECEF = getSunDirectionECEF(date, new THREE.Vector3())
    const moonDirectionECEF = getMoonDirectionECEF(date, new THREE.Vector3())
    const localUpECEF = new THREE.Vector3(0, 1, 0).transformDirection(worldToECEF)
    sunElevationDeg =
      (Math.asin(Math.max(-1, Math.min(1, sunDirectionECEF.dot(localUpECEF)))) * 180) /
      Math.PI

    atmosphereContext = new atmos.AtmosphereContext()
    atmosphereContext.camera = camera
    atmosphereContext.raymarchScattering = options.raymarchScattering
    // `matrixECEFToWorld` と `cameraPositionECEF` は `onRenderUpdate` で
    // ここから導かれる。入れるのは元になる 3 つだけでよい
    atmosphereContext.matrixWorldToECEF.value.copy(worldToECEF)
    atmosphereContext.sunDirectionECEF.value.copy(sunDirectionECEF)
    atmosphereContext.moonDirectionECEF.value.copy(moonDirectionECEF)

    if (options.lutScale !== 1) {
      // **面積で効く。**倍率を半分にすると計算量は 4 分の 1 になる
      const p = atmosphereContext.parameters
      const one2 = new THREE.Vector2(1, 1)
      const one3 = new THREE.Vector3(1, 1, 1)
      p.transmittanceTextureSize.multiplyScalar(options.lutScale).round().max(one2)
      p.irradianceTextureSize.multiplyScalar(options.lutScale).round().max(one2)
      p.multipleScatteringTextureSize.multiplyScalar(options.lutScale).round().max(one2)
      p.scatteringTextureSize.multiplyScalar(options.lutScale).round().max(one3)
    }

    // **既存の `contextNode.value` を潰さない。**`renderer.highPrecision = true`
    // にすると `Renderer` の setter が `modelViewMatrix` をここへ入れる
    // （`Renderer.js` の `set highPrecision`）。潰すと高精度の行列が消える
    renderer.contextNode = tsl.context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext,
    })

    // `NodeLibrary.addLight` は実装にあるのに `@types/three` は空の宣言しか
    // 持たない（`renderers/common/nodes/NodeLibrary.d.ts` が `declare class
    // NodeLibrary {}`）。名前と引数は `NodeLibrary.js:142` で確かめた
    const library = renderer.library as unknown as {
      addLight(nodeClass: unknown, lightClass: unknown): void
    }
    library.addLight(atmos.AtmosphereLightNode, atmos.AtmosphereLight)

    const sunLight = new atmos.AtmosphereLight()
    scene.add(sunLight)
    scene.add(sunLight.target)

    // `Scene.backgroundNode` と `environmentNode` も `@types/three` に無い。
    // 読む側は `NodeManager.getBackgroundNode()` と `NodeManager.js:513`
    const sceneNodes = scene as unknown as {
      backgroundNode: unknown
      environmentNode: unknown
    }
    sceneNodes.backgroundNode = atmos.skyBackground()
    if (options.skyEnvironmentSize > 0) {
      sceneNodes.environmentNode = atmos.skyEnvironment(options.skyEnvironmentSize)
    }

  } else {
    // 大気を組まないときの光。glb の材質が描けることだけを見る
    scene.add(new THREE.AmbientLight(0xffffff, 1.5))
    const sun = new THREE.DirectionalLight(0xffffff, 3)
    sun.position.set(120, 200, 80)
    scene.add(sun)
  }

  let meshes = 0
  let shaderMaterials = 0
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    meshes++
    const material = node.material as THREE.Material | THREE.Material[]
    for (const one of Array.isArray(material) ? material : [material]) {
      if ((one as { isShaderMaterial?: boolean }).isShaderMaterial === true) {
        shaderMaterials++
      }
    }
  })

  // **`renderAsync()` は使わない。**r183 で非推奨になっていて、
  // 「`render()` を使い、レンダラを作るときに `await renderer.init()` を
  // すること」と警告が出る。`init()` は済ませてあるので `render()` でよい。
  // `info` の集計は `render()` の中で同期に進むので、直後に読める
  // **順序を外せない。**`compileAsync` が `AtmosphereLUTNode.setup()` を
  // 走らせ、そこで `textures` ができる。その前に `updateTextures()` を呼ぶと
  // `invariant(this.textures != null)` で落ちる（`webgpu.js:1530`）
  const buildStarted = performance.now()
  await renderer.compileAsync(scene, camera)
  const buildMs = performance.now() - buildStarted

  // **暗黙の起動に任せない。**`updateBefore` から呼ばれる経路は
  // `requestIdleCallback` で 4 分割される（`shared2.js:29`）。何枚目で
  // 完成するかが機械の負荷で変わるので、キャプチャの決定論が壊れる。
  // ここで待ち切る
  let lutMs = 0
  if (atmosphereContext !== null) {
    const lutStarted = performance.now()
    await atmosphereContext.lutNode.updateTextures(renderer)
    lutMs = performance.now() - lutStarted
  }

  const firstStarted = performance.now()
  renderer.render(scene, camera)
  const firstFrameMs = performance.now() - firstStarted

  // **1 枚目は捨てる。**シェーダの生成とテクスチャの常駐化が乗る。
  //
  // **排出まで含めて測る。**`render()` は投入で戻るので、そのまま測ると
  // 投入時間しか出ない（`bench.ts` が記録している罠。実測で 0.7 ms が出た）。
  // node 経路に `gl.finish()` は無いので、レンダーターゲットへ描いて
  // 1 画素読み戻す。代表値は最小値で、これも `bench.ts` と同じ作法
  const target = new webgpu.RenderTarget(options.width, options.height)
  const frames = options.frames ?? 8
  let renderMs = Infinity
  for (let i = 0; i < frames; i++) {
    const started = performance.now()
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)
    renderMs = Math.min(renderMs, performance.now() - started)
  }
  renderer.setRenderTarget(null)
  target.dispose()

  // **`info` は自分で 0 に戻す。**node 経路は `setAnimationLoop` を使った
  // ときだけ `Animation.js:75` が `info.reset()` を呼ぶ。自分で `render()` を
  // 回すと `autoReset` が true のままでも積算され続ける。`WebGLRenderer` は
  // `render()` の中で戻すので、ここが振る舞いの違いになる
  renderer.info.reset()
  renderer.render(scene, camera)

  return {
    requested: options.gpu,
    noiseSlice,
    weatherSlice,
    hashProbe,
    shadowHistogram: shadowBins,
    shadowTiles,
    march,
    heightProbe,
    volumeMs,
    backend: isWebGPU ? 'node-webgpu' : 'node-webgl',
    fellBack: options.gpu === 2 && !isWebGPU,
    sharedCore,
    meshes,
    shaderMaterials,
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.memory.programs,
    atmosphere: atmosphereContext !== null,
    lutMs,
    lutScale: options.lutScale,
    buildMs,
    sunElevationDeg,
    initMs,
    firstFrameMs,
    renderMs,
    frames,
  }
}
