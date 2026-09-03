import {
  ClampToEdgeWrapping,
  type Data3DTexture,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  RenderTarget3D,
  RepeatWrapping,
  Scene,
  UnsignedByteType,
  type Texture,
} from 'three'
import { NodeMaterial, type Node, type Renderer } from 'three/webgpu'
import { int, ivec2, ivec3, texture3D, textureLoad, uniform, uv } from 'three/tsl'
import { unpadRows } from '../pipeline/readback'

/**
 * node 経路で 3D テクスチャを焼き、中身を読み戻す。
 *
 * GLSL 版の `noise.ts` と同じ手順を node 経路で踏む。層ごとに
 * `setRenderTarget(target, layer)` して全画面クアッドを 1 枚描く。
 *
 * **読み戻しだけは同じ手が使えない。**`readRenderTargetPixelsAsync` の
 * `faceIndex` は、node 経路の WebGL2 バックエンドでは効かない。
 * `WebGLTextureUtils.copyTextureToBuffer`（`node_modules/three/src/renderers/
 * webgl-fallback/utils/WebGLTextureUtils.js:1201`）がキューブテクスチャ以外を
 * `gl.TEXTURE_2D` 決め打ちで `framebufferTexture2D` へ渡すため、3D テクスチャの
 * アタッチが `GL_INVALID_OPERATION` で失敗し、framebuffer が incomplete のまま
 * `readPixels` が **全部 0 を返す。**例外は飛ばず GL の警告が出るだけなので、
 * 気づかないと「焼き込みが効いていない」と読み違える。実測でそう読み違えた。
 *
 * WebGPU バックエンドでは効く（`WebGPUTextureUtils.js:663` が
 * `origin.z` を組む）。**片方だけ効く道は使わない。**両方で効く道は
 * 「シェーダから引いて 2D のレンダーターゲットへ落とし、それを読む」で、
 * `readVolumeSlice` がそれを行う。実測で 64³ の層 0・32・63 が
 * 両バックエンドとも一致した。
 */

/** 全画面クアッド。材質を差し替えて使い回す */
export interface BakeQuad {
  readonly scene: Scene
  readonly camera: OrthographicCamera
  readonly mesh: Mesh
  dispose(): void
}

export function createBakeQuad(): BakeQuad {
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const geometry = new PlaneGeometry(2, 2)
  const mesh = new Mesh(geometry, new NodeMaterial())
  scene.add(mesh)
  return {
    scene,
    camera,
    mesh,
    dispose() {
      geometry.dispose()
      ;(mesh.material as NodeMaterial).dispose()
    },
  }
}

/**
 * `NodeMaterial.fragmentNode` へ入れる。
 *
 * `@types/three` の `NodeMaterial` はこの枠を宣言していないので、逃げ口を
 * 1 か所へ寄せる。読む側は `NodeMaterial.setup()`
 */
function fragmentMaterial(node: unknown): NodeMaterial {
  const material = new NodeMaterial()
  ;(material as unknown as { fragmentNode: unknown }).fragmentNode = node
  material.depthTest = false
  material.depthWrite = false
  return material
}

/** 焼いたあと材質を捨てる。クアッドは呼び出し側が持ち続ける */
function drawWith(
  quad: BakeQuad,
  material: NodeMaterial,
  draw: () => void,
): void {
  const previous = quad.mesh.material
  quad.mesh.material = material
  draw()
  quad.mesh.material = previous
  material.dispose()
}

export interface VolumeOptions {
  /** 一辺のテクセル数。深さも同じ */
  side: number
  /**
   * 層の中心 `(layer + 0.5) / side` を受け取って色を返す。
   *
   * **uniform で受け取る。**層ごとに材質を作るとシェーダの生成が層の数だけ
   * 走る。64 層をソフトウェアレンダラで焼くと現実的な時間に収まらない。
   * uniform の書き換えが `render()` ごとに反映されることは実測で確かめた
   */
  fragment: (layerCenter: Node<'float'>) => Node<'vec4'>
}

/** 3D テクスチャを層ごとに焼く。GLSL 版の `bakeVolume` と同じ手順 */
export function bakeVolume(
  renderer: Renderer,
  quad: BakeQuad,
  options: VolumeOptions,
): RenderTarget3D {
  const { side } = options
  const target = new RenderTarget3D(side, side, side, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  // **`@types/three` の `RenderTarget3D` は `texture` を絞っていない。**
  // 実装は `Data3DTexture` を入れる（`core/RenderTarget3D.js:39`）のに、
  // 型は `Texture` のままなので `wrapR` が見えない。`WebGL3DRenderTarget` の
  // 型だけが `Data3DTexture` に絞ってある
  const texture = target.texture as unknown as Data3DTexture
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  // ワールド座標で繰り返し参照するので全軸で折り返す。GLSL 版と揃える
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.generateMipmaps = false

  const layerCenter = uniform(0)
  const material = fragmentMaterial(
    options.fragment(layerCenter as unknown as Node<'float'>),
  )

  drawWith(quad, material, () => {
    for (let layer = 0; layer < side; layer++) {
      // テクセルの中心を狙う。端に寄せると隣のスライスと同じ値になる
      layerCenter.value = (layer + 0.5) / side
      renderer.setRenderTarget(target, layer)
      renderer.render(quad.scene, quad.camera)
    }
    renderer.setRenderTarget(null)
  })

  return target
}

/**
 * 2D のテクスチャを 1 枚焼く。気象マップと雲影とマーチに使う。
 *
 * @param repeat 端で折り返すか。**既定は折り返さない。**世界座標で引き回す
 * 気象マップだけが折り返す。マーチの結果を近傍で舐めるときは、端の外を
 * どう読むかが既定の経路（`WebGLRenderTarget` の既定は端で止める）と揃って
 * いないと縁の画素だけ値が変わる。**実測で 36,864 バイト中 432 個が動いた**
 */
export function bakePlane(
  renderer: Renderer,
  quad: BakeQuad,
  width: number,
  height: number,
  fragment: Node<'vec4'>,
  repeat = false,
): RenderTarget {
  const target = new RenderTarget(width, height, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  const texture = target.texture
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = repeat ? RepeatWrapping : ClampToEdgeWrapping
  texture.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping
  texture.generateMipmaps = false

  drawWith(quad, fragmentMaterial(fragment), () => {
    renderer.setRenderTarget(target)
    renderer.render(quad.scene, quad.camera)
    renderer.setRenderTarget(null)
  })

  return target
}

/**
 * 2D のレンダーターゲットを丸ごと読み戻す。
 *
 * 2D の読み戻しは両バックエンドで効く。違うのは行の間隔と向きだけなので、
 * `unpadRows` が揃える
 */
export async function readPlane(
  renderer: Renderer,
  target: RenderTarget,
  width: number,
  height: number,
  flipRows: boolean,
): Promise<number[]> {
  const pixels = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    width,
    height,
  )) as unknown as ArrayLike<number>
  return unpadRows(pixels, width, height, flipRows)
}

/**
 * 2D テクスチャの左下 `readSide` 角を整数フェッチで読み戻す。
 *
 * `readPlane` と違って**シェーダを通す。**node 経路はレンダーターゲットの
 * テクスチャを引くとき v を裏返すので（`noiseNodes.ts` の `bakeUv` を見よ）、
 * 焼くときに裏返したものは、引くときも同じ約束で読まないと元へ戻らない。
 * 気象マップの突き合わせに使う
 */
export async function readPlaneSlice(
  renderer: Renderer,
  quad: BakeQuad,
  source: Texture,
  readSide: number,
  flipRows: boolean,
): Promise<number[]> {
  const target = new RenderTarget(readSide, readSide, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  const coordinate = ivec2(int(uv().x.mul(readSide)), int(uv().y.mul(readSide)))
  const material = fragmentMaterial(textureLoad(source, coordinate))

  const previous = quad.mesh.material
  quad.mesh.material = material
  renderer.setRenderTarget(target)
  renderer.render(quad.scene, quad.camera)
  renderer.setRenderTarget(null)
  const pixels = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    readSide,
    readSide,
  )) as unknown as ArrayLike<number>
  quad.mesh.material = previous
  material.dispose()
  target.dispose()

  return unpadRows(pixels, readSide, readSide, flipRows)
}

/**
 * 3D テクスチャの 1 層から左下 `readSide` 角を読み戻す。
 *
 * **整数フェッチで引く。**`textureLoad` なら補間を跨がないので、GLSL 版の
 * 読み戻しとビットで比べられる。線形補間でテクセル中心を狙う手もあるが、
 * 重みがちょうど 1 になることを浮動小数の丸めに委ねることになる。
 *
 * 3D のレンダーターゲットから直に読まない理由はこのファイルの冒頭にある。
 */
export async function readVolumeSlice(
  renderer: Renderer,
  quad: BakeQuad,
  volume: Texture,
  layer: number,
  readSide: number,
  flipRows: boolean,
): Promise<number[]> {
  const target = new RenderTarget(readSide, readSide, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const coordinate = ivec3(
    int(uv().x.mul(readSide)),
    int(uv().y.mul(readSide)),
    int(layer),
  )
  const material = fragmentMaterial(texture3D(volume).load(coordinate))

  let pixels: ArrayLike<number> = []
  const previous = quad.mesh.material
  quad.mesh.material = material
  renderer.setRenderTarget(target)
  renderer.render(quad.scene, quad.camera)
  renderer.setRenderTarget(null)
  pixels = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    readSide,
    readSide,
  )) as unknown as ArrayLike<number>
  quad.mesh.material = previous
  material.dispose()
  target.dispose()

  return unpadRows(pixels, readSide, readSide, flipRows)
}
