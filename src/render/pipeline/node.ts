import * as THREE from 'three'
import { getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere'
import { Geodetic } from '@takram/three-geospatial'
import { loadAircraftModel } from '../aircraft/model'
import { NOISE_SLICE_SIDE, SHAPE_SIZE } from '../clouds/noise'
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
}

/**
 * 読み戻しの行の詰め物を外す。
 *
 * **WebGPU は行を 256 バイトへ揃える。**16 px 幅（64 バイト）を 16 行
 * 読むと 3,904 バイト戻った。15 行 x 256 + 64 で、最後の行だけ揃えられない。
 * WebGL2 バックエンドは詰まったまま 1,024 バイトを返す。
 *
 * 揃え幅を決め打ちにせず、戻ってきた長さから行の間隔を割り出す。
 * 詰まっていればそのまま返す
 */
function unpadRows(
  data: ArrayLike<number>,
  width: number,
  height: number,
  flipRows: boolean,
): number[] {
  const rowBytes = width * 4
  const total = data.length
  const stride =
    total === rowBytes * height
      ? rowBytes
      : height > 1
        ? (total - rowBytes) / (height - 1)
        : total

  if (!Number.isInteger(stride) || stride < rowBytes) {
    throw new Error(
      `読み戻しの行の間隔が読めない: 長さ ${total}、幅 ${width}、高さ ${height}`,
    )
  }

  const out: number[] = []
  for (let row = 0; row < height; row++) {
    const y = flipRows ? height - 1 - row : row
    const base = y * stride
    for (let i = 0; i < rowBytes; i++) out.push(data[base + i]!)
  }
  return out
}

/**
 * `NodeMaterial.fragmentNode` へ入れる。
 *
 * `@types/three` の `NodeMaterial` はこの枠を宣言していないので、逃げ口を
 * 1 か所へ寄せる。読む側は `NodeMaterial.setup()`
 */
function assignFragment(material: object, node: unknown): void {
  ;(material as { fragmentNode: unknown }).fragmentNode = node
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

  // ---- 雲ノイズを TSL で焼く ----
  //
  // **1 スライスで足りる。**64 層すべてを焼かなくても、GLSL 版が読み戻して
  // いるのと同じ中央スライスの同じ 16x16 を比べれば、式が一致しているかは
  // 分かる。1 ビットずれれば以降の雲はすべて別物になるので、ここで止める
  const tsl = await import('three/tsl')
  const noiseNodes = await import('../clouds/noiseNodes')

  const bake = async (
    fragmentNode: Parameters<typeof assignFragment>[1],
    side: number,
    readSide: number,
  ): Promise<number[]> => {
    const target = new webgpu.RenderTarget(side, side, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    })
    const material = new webgpu.NodeMaterial()
    assignFragment(material, fragmentNode)
    material.depthTest = false
    material.depthWrite = false

    const quad = new THREE.Scene()
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    quad.add(mesh)
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    renderer.setRenderTarget(target)
    renderer.render(quad, ortho)
    // **原点の上下がバックエンドで違う。**WebGL2 は左下、WebGPU は左上。
    // GLSL 版が読んでいるのは左下の `readSide` 角なので、WebGPU では
    // `side - readSide` から読む。行の並びは `unpadRows` が返す側で揃える
    const originY = isWebGPU ? side - readSide : 0
    const pixels = await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      originY,
      readSide,
      readSide,
    )
    renderer.setRenderTarget(null)
    mesh.geometry.dispose()
    material.dispose()
    target.dispose()
    // **行の向きがバックエンドで違う。**WebGL2 の読み戻しは下から、WebGPU は
    // 上から返る。実測で確かめた。ハッシュの検査用の格子で、WebGPU の先頭が
    // `hashTopByte(0, 15, 0)` に一致し、WebGL2 は `(0, 0, 0)` だった。
    // **算術は一致していて、違うのは並びだけ。**気づかなければ「WGSL の
    // ハッシュがずれている」と読み違える
    return unpadRows(
      pixels as unknown as ArrayLike<number>,
      readSide,
      readSide,
      isWebGPU,
    )
  }

  // GLSL 版と同じ層と同じ周波数の上限を使う。`bakeVolume` の式を写す
  const centerLayer = (Math.floor(SHAPE_SIZE / 2) + 0.5) / SHAPE_SIZE
  const maxFreq = Math.max(1, Math.floor(SHAPE_SIZE / 4))
  const noiseSlice = await bake(
    noiseNodes.noiseFragmentNode(0, maxFreq, tsl.float(centerLayer)),
    SHAPE_SIZE,
    NOISE_SLICE_SIDE,
  )
  const hashProbe = await bake(
    noiseNodes.hashProbeFragmentNode(HASH_PROBE_SIDE),
    HASH_PROBE_SIDE,
    HASH_PROBE_SIDE,
  )

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
    hashProbe,
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
