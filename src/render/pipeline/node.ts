import * as THREE from 'three'
import { loadAircraftModel } from '../aircraft/model'
import { loadCarrier, placeCarrier, DECK_HEIGHT } from '../carrier'
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

  // 大気は入れない。glb の材質が描けることだけを見るので、光は素の 2 灯で足りる
  scene.add(new THREE.AmbientLight(0xffffff, 1.5))
  const sun = new THREE.DirectionalLight(0xffffff, 3)
  sun.position.set(120, 200, 80)
  scene.add(sun)

  const model = await loadAircraftModel(options.aircraftUrl)
  model.object.position.set(0, DECK_HEIGHT + 8, 0)
  scene.add(model.object)

  const carrier = await loadCarrier(options.carrierUrl)
  placeCarrier(carrier, 0, 0, 0)
  scene.add(carrier.object)

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
    backend: isWebGPU ? 'node-webgpu' : 'node-webgl',
    fellBack: options.gpu === 2 && !isWebGPU,
    sharedCore,
    meshes,
    shaderMaterials,
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.memory.programs,
    initMs,
    firstFrameMs,
    renderMs,
    frames,
  }
}
