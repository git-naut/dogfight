import type { Renderer } from 'three/webgpu'
import {
  DETAIL_SIZE,
  NOISE_SLICE_SIDE,
  SHAPE_SIZE,
  WEATHER_SIZE,
  type NoiseStats,
} from './noise'
import { noiseFragmentNode, weatherFragmentNode } from './noiseNodes'
import {
  bakePlane,
  bakeVolume,
  createBakeQuad,
  readPlaneSlice,
  readVolumeSlice,
  type BakeQuad,
} from './volume'
import type { CloudsNodeTextures } from './cloudsNodePass'

/**
 * node 経路の雲ノイズを焼く。GLSL 経路の `generateCloudNoise` と対になる。
 *
 * **周波数の上限は GLSL 版の式を写す。**1 セルに 4 テクセル確保できる
 * ところまでで、超えると白色ノイズになる（`noise.ts` の `bakeVolume`）。
 * 式を 2 か所に持つと、片方だけ直したときに気づけない。
 *
 * **気象マップだけ折り返す。**世界座標で引き回すので `RepeatWrapping` が
 * 要る。体積の側に無条件で付けると、近傍を舐める足し込みで縁の 432
 * バイトがずれる（段 12 の実測）。
 *
 * v の打ち消しは `noiseNodes.ts` の `bakeUv` が持つ。node 経路は
 * レンダーターゲットのテクスチャを v 反転して引くので、焼く側で戻す。
 */
export interface NodeCloudNoise extends CloudsNodeTextures {
  /** 焼くのにかかったミリ秒 */
  ms: number
  /**
   * 形状ノイズの中央スライスから出した統計。
   *
   * **空でないことの確認用。**`smoke.spec.ts` が `max > min` と
   * 平均が 0.1〜0.95 の内側であることを見る（画素に依存しない検査の 1 件）
   */
  stats: NoiseStats
  /** 形状ノイズの中央スライスの左下 16x16。RGBA8 の生バイト 1,024 個 */
  slice: Uint8Array
  /** 気象マップの左下 16x16。**雲の配置を決めるのはこちら** */
  weatherSlice: Uint8Array
  dispose(): void
}

/** R チャンネル（Perlin-Worley）だけ見れば足りる。GLSL 版と同じ */
function sliceStats(bytes: ArrayLike<number>): NoiseStats {
  if (bytes.length === 0) return { min: 0, max: 0, mean: 0 }
  let min = 255
  let max = 0
  let sum = 0
  let count = 0
  for (let i = 0; i < bytes.length; i += 4) {
    const v = bytes[i]!
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    count++
  }
  return { min: min / 255, max: max / 255, mean: sum / count / 255 }
}

/** 1 セルに 4 テクセル。超えると白色ノイズになる */
function maxFrequency(size: number): number {
  return Math.max(1, Math.floor(size / 4))
}

/**
 * @param shared 焼きに使う全画面クアッド。**渡した側が破棄を持つ。**
 *   プローブは同じクアッドを読み戻しにも使い回すので、ここで捨てられない
 */
export async function bakeNodeCloudNoise(
  renderer: Renderer,
  shared?: BakeQuad,
): Promise<NodeCloudNoise> {
  const quad = shared ?? createBakeQuad()
  const started = performance.now()

  const shape = bakeVolume(renderer, quad, {
    side: SHAPE_SIZE,
    fragment: (layer) => noiseFragmentNode(0, maxFrequency(SHAPE_SIZE), layer),
  })
  const detail = bakeVolume(renderer, quad, {
    side: DETAIL_SIZE,
    fragment: (layer) => noiseFragmentNode(1, maxFrequency(DETAIL_SIZE), layer),
  })
  const weather = bakePlane(
    renderer,
    quad,
    WEATHER_SIZE,
    WEATHER_SIZE,
    weatherFragmentNode(),
    // 世界座標で引き回すので折り返す。GLSL 版と揃える
    { repeat: true },
  )

  const ms = performance.now() - started

  // GLSL 版（`noise.ts` の `sampleSlice`）が読むのと同じ層の同じ左下 16x16。
  // **統計だけでは 1 ビットのずれが埋もれる**ので生バイトも持ち帰る
  const isWebGPU = 'isWebGPUBackend' in renderer.backend
  const slice = await readVolumeSlice(
    renderer,
    quad,
    shape.texture,
    Math.floor(SHAPE_SIZE / 2),
    NOISE_SLICE_SIDE,
    isWebGPU,
  )
  const weatherSlice = await readPlaneSlice(
    renderer,
    quad,
    weather.texture,
    NOISE_SLICE_SIDE,
    isWebGPU,
  )

  return {
    shape: shape.texture,
    detail: detail.texture,
    weather: weather.texture,
    ms,
    stats: sliceStats(slice),
    slice: new Uint8Array(slice),
    weatherSlice: new Uint8Array(weatherSlice),
    dispose() {
      shape.dispose()
      detail.dispose()
      weather.dispose()
      if (shared === undefined) quad.dispose()
    },
  }
}
