import type { Renderer } from 'three/webgpu'
import { DETAIL_SIZE, SHAPE_SIZE, WEATHER_SIZE } from './noise'
import { noiseFragmentNode, weatherFragmentNode } from './noiseNodes'
import { bakePlane, createBakeQuad, bakeVolume, type BakeQuad } from './volume'
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
  dispose(): void
}

/** 1 セルに 4 テクセル。超えると白色ノイズになる */
function maxFrequency(size: number): number {
  return Math.max(1, Math.floor(size / 4))
}

/**
 * @param shared 焼きに使う全画面クアッド。**渡した側が破棄を持つ。**
 *   プローブは同じクアッドを読み戻しにも使い回すので、ここで捨てられない
 */
export function bakeNodeCloudNoise(renderer: Renderer, shared?: BakeQuad): NodeCloudNoise {
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

  return {
    shape: shape.texture,
    detail: detail.texture,
    weather: weather.texture,
    ms: performance.now() - started,
    dispose() {
      shape.dispose()
      detail.dispose()
      weather.dispose()
      if (shared === undefined) quad.dispose()
    },
  }
}
