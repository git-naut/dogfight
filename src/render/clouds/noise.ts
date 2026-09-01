import {
  Data3DTexture,
  GLSL3,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import noise3dFrag from './shaders/noise3d.frag?raw'
import weatherFrag from './shaders/weather.frag?raw'
import type { RenderBackend } from '../backend'

/**
 * 雲のノイズを GPU で焼く。
 *
 * ファイルとして配信せず起動時に生成する。形状ノイズは 128³ RGBA8 で
 * 8.4 MB あり、ダウンロードさせるには重い。ハッシュ関数だけで作るので
 * 生成結果は決定論的で、どの環境でも同じテクスチャになる。
 *
 * 3D テクスチャへはレイヤごとに描く。three の setRenderTarget は第2引数で
 * 3D レンダーターゲットのレイヤを選べる。
 */

/**
 * 形状ノイズの一辺。
 *
 * 128 も試したが、CI のソフトウェアレンダラでページ読み込みが 2.5 秒から
 * 9.0 秒へ伸びた。E2E は 20 回以上ページを開くので許容できない。64 なら
 * 追加は約 1 秒に収まり、ディテールノイズで輪郭を削れば見た目も足りる。
 * 実機の GPU には余裕があるが、CI と同じ値でないと基準画像が一致しない。
 */
export const SHAPE_SIZE = 64
/** ディテールノイズの一辺。輪郭の削り込みに使う */
export const DETAIL_SIZE = 32
/** 気象マップの一辺 */
export const WEATHER_SIZE = 512

/**
 * 突き合わせに使うスライスの一辺。
 *
 * 中央スライスの左下から 16x16 を読む。RGBA8 なので 1,024 個の値になる。
 * GLSL 版と TSL 版がここでビット一致しなければ、以降の雲はすべて別物
 */
export const NOISE_SLICE_SIDE = 16

/**
 * 焼き上がったテクスチャの中身の統計。
 *
 * 3D レンダーターゲットへの描画が黙って失敗すると、雲が出ないだけで
 * エラーも出ない。空でないことを起動時に確かめておく。
 */
export interface NoiseStats {
  min: number
  max: number
  mean: number
}

export interface CloudNoise {
  shape: Data3DTexture
  detail: Data3DTexture
  weather: Texture
  /** 生成にかかった実測ミリ秒。性能の記録用 */
  readonly elapsedMs: number
  /** 形状ノイズの一部を読み戻した統計 */
  readonly stats: NoiseStats
  /**
   * 形状ノイズの中央スライスの左下 16x16。RGBA8 の生バイト 1,024 個。
   *
   * **TSL 版との突き合わせに使う。**統計だけでは 1 ビットのずれが埋もれる。
   * 読めなかったときは長さ 0
   */
  readonly slice: Uint8Array
  dispose(): void
}

// GLSL ES 3.00 で書く。整数のビット演算はここでしか使えない
const VERTEX_SHADER = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/**
 * 全画面クアッドを1枚だけ用意して使い回す。
 * three の addons に頼らないのは import 経路を増やしたくないため。
 */
function createQuad(material: ShaderMaterial): { scene: Scene; camera: OrthographicCamera } {
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  scene.add(new Mesh(new PlaneGeometry(2, 2), material))
  return { scene, camera }
}

export function generateCloudNoise(backend: RenderBackend): CloudNoise {
  const renderer = backend.renderer
  const started = performance.now()

  const previousTarget = renderer.getRenderTarget()

  const shapeTarget = create3DTarget(SHAPE_SIZE)
  const detailTarget = create3DTarget(DETAIL_SIZE)

  const noiseMaterial = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VERTEX_SHADER,
    fragmentShader: noise3dFrag,
    uniforms: {
      layer: { value: 0 },
      channelSet: { value: 0 },
      maxFreq: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const noiseQuad = createQuad(noiseMaterial)

  bakeVolume(renderer, noiseQuad, noiseMaterial, shapeTarget, SHAPE_SIZE, 0)
  bakeVolume(renderer, noiseQuad, noiseMaterial, detailTarget, DETAIL_SIZE, 1)

  // 気象マップは 2D なので普通のレンダーターゲットで足りる
  const weatherTarget = new WebGLRenderTarget(WEATHER_SIZE, WEATHER_SIZE, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const weatherMaterial = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VERTEX_SHADER,
    fragmentShader: weatherFrag,
    uniforms: {},
    depthTest: false,
    depthWrite: false,
  })
  const weatherQuad = createQuad(weatherMaterial)

  renderer.setRenderTarget(weatherTarget)
  renderer.render(weatherQuad.scene, weatherQuad.camera)

  renderer.setRenderTarget(previousTarget)

  disposeQuad(noiseQuad, noiseMaterial)
  disposeQuad(weatherQuad, weatherMaterial)

  // render() は GPU への投入で戻るので、待たずに計ると投入時間しか出ない。
  // 起動時の一度きりなので同期しても支障はない。
  //
  // ただし ANGLE 経由だと finish() でも完全には待ち切れず、この値は実際の
  // 生成時間を下回る。信用できるのはページ読み込みからの実測のほうで、
  // 解像度の判断はそちらで行った（docs/decisions/0003 参照）
  backend.drain()
  const elapsedMs = performance.now() - started

  const sample = sampleSlice(renderer, shapeTarget, Math.floor(SHAPE_SIZE / 2))
  renderer.setRenderTarget(previousTarget)

  return {
    shape: shapeTarget.texture,
    detail: detailTarget.texture,
    weather: weatherTarget.texture,
    elapsedMs,
    stats: sample.stats,
    slice: sample.slice,
    dispose() {
      shapeTarget.dispose()
      detailTarget.dispose()
      weatherTarget.dispose()
    },
  }
}

/**
 * 3D テクスチャの中央スライスから 16x16 を読み戻して統計を取る。
 *
 * 全域を読むと重いので一部で足りる。min と max が同じなら塗り潰しか未描画で、
 * どちらにせよ雲は出ない。
 */
function sampleSlice(
  renderer: WebGLRenderer,
  target: WebGL3DRenderTarget,
  layer: number,
): { stats: NoiseStats; slice: Uint8Array } {
  const side = NOISE_SLICE_SIDE
  const buffer = new Uint8Array(side * side * 4)
  try {
    renderer.setRenderTarget(target, layer)
    renderer.readRenderTargetPixels(target, 0, 0, side, side, buffer)
  } catch {
    return { stats: { min: 0, max: 0, mean: 0 }, slice: new Uint8Array(0) }
  }

  let min = 255
  let max = 0
  let sum = 0
  // R チャンネル（Perlin-Worley）だけ見れば足りる
  for (let i = 0; i < buffer.length; i += 4) {
    const v = buffer[i]!
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  const count = buffer.length / 4
  return {
    stats: { min: min / 255, max: max / 255, mean: sum / count / 255 },
    slice: buffer,
  }
}

function create3DTarget(size: number): WebGL3DRenderTarget {
  const target = new WebGL3DRenderTarget(size, size, size, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  const texture = target.texture
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  // ワールド座標で繰り返し参照するので全軸で折り返す。
  // シェーダ側でタイル化してあるので継ぎ目は出ない
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.generateMipmaps = false
  return target
}

/** スライスを1枚ずつ描いて 3D テクスチャを埋める。 */
function bakeVolume(
  renderer: WebGLRenderer,
  quad: { scene: Scene; camera: OrthographicCamera },
  material: ShaderMaterial,
  target: WebGL3DRenderTarget,
  size: number,
  channelSet: number,
): void {
  material.uniforms['channelSet']!.value = channelSet
  // 1 セルに 4 テクセル確保できる周波数までに抑える。
  // これを超えると焼いた時点で白色ノイズになる
  material.uniforms['maxFreq']!.value = Math.max(1, Math.floor(size / 4))
  for (let layer = 0; layer < size; layer++) {
    // テクセルの中心を狙う。端に寄せると隣のスライスと同じ値になる
    material.uniforms['layer']!.value = (layer + 0.5) / size
    renderer.setRenderTarget(target, layer)
    renderer.render(quad.scene, quad.camera)
  }
}

function disposeQuad(
  quad: { scene: Scene; camera: OrthographicCamera },
  material: ShaderMaterial,
): void {
  for (const child of quad.scene.children) {
    if (child instanceof Mesh) child.geometry.dispose()
  }
  material.dispose()
}
