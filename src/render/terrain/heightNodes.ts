import {
  Fn,
  clamp,
  float,
  floor,
  ivec2,
  textureLoad,
  vec2,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Texture } from 'three'

/**
 * 高さ場のサンプルを TSL で書く。
 *
 * `shaders/heightfield.glsl` の写し。**双三次の式は `src/sim/terrain.ts` の
 * `catmullRom` と同じにする。**ここがずれると「見えている山と当たる山が違う」
 * 状態になり、高さ場を sim に持たせた意味がなくなる。
 *
 * `texelFetch` は `textureLoad` になる。高さ場は `DataTexture` なので
 * `isRenderTargetTexture` が false で、node 経路の v 反転は掛からない
 * （`TextureNode.setupUV()`）。焼いた絵を引くときとは事情が違う。
 */

export interface HeightFieldInputs {
  /** sim が焼いた高さ場。RedFormat / FloatType / NearestFilter */
  heightMap: Texture
  /** 高さ場が覆う world の一辺 m */
  extent: number
  /** 高さ場の一辺のテクセル数 */
  texels: number
}

/**
 * 格子の値。範囲外は縁で止める。島は縁から離してあるので海底が返る。
 *
 * **添字の丸めを浮動小数で通す。**`clamp` は整数のベクタに型が付かない
 * （`@types/three`）。格子は 0..1023 なので、float を経由しても値は厳密に
 * 保たれる（2^24 まで整数は浮動小数で表せる）
 */
function terrainTexelAt(
  inputs: HeightFieldInputs,
  coord: Node<'ivec2'>,
): Node<'float'> {
  const last = inputs.texels - 1
  const clamped = ivec2(clamp(vec2(coord), float(0), float(last)))
  return textureLoad(inputs.heightMap, clamped).r
}

/** t=0 で p1 を厳密に返す。格子点では焼いた値と一致する */
const terrainCatmullRom = Fn(
  ([p0, p1, p2, p3, t]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
  ]) => {
    const t2 = t.mul(t).toVar()
    const t3 = t2.mul(t).toVar()
    return p1
      .add(float(0.5).mul(t).mul(p2.sub(p0)))
      .add(
        float(0.5)
          .mul(t2)
          .mul(float(2).mul(p0).sub(float(5).mul(p1)).add(float(4).mul(p2)).sub(p3)),
      )
      .add(
        float(0.5)
          .mul(t3)
          .mul(p0.negate().add(float(3).mul(p1)).sub(float(3).mul(p2)).add(p3)),
      )
  },
).setLayout({
  name: 'dogfightTerrainCatmullRom',
  type: 'float',
  inputs: [
    { name: 'p0', type: 'float' },
    { name: 'p1', type: 'float' },
    { name: 'p2', type: 'float' },
    { name: 'p3', type: 'float' },
    { name: 't', type: 'float' },
  ],
})

/**
 * 双三次で引いた高さ m。
 *
 * GLSL は `float rows[4]` を使っている。TSL に配列の添字がないので 4 個の
 * `.toVar()` へ展開する。ループの回数も添字も定数なので、展開しても同じ
 * 算術になる
 */
export function terrainHeightNode(
  inputs: HeightFieldInputs,
  world: Node<'vec2'>,
): Node<'float'> {
  return Fn(() => {
    const halfExtent = inputs.extent * 0.5
    const texel = inputs.extent / inputs.texels
    const grid = world.add(halfExtent).div(texel).sub(0.5).toVar()
    const base = floor(grid).toVar()
    const origin = ivec2(base).toVar()
    const t = grid.sub(base).toVar()

    const row = (r: number): Node<'float'> =>
      terrainCatmullRom(
        terrainTexelAt(inputs, origin.add(ivec2(-1, r))),
        terrainTexelAt(inputs, origin.add(ivec2(0, r))),
        terrainTexelAt(inputs, origin.add(ivec2(1, r))),
        terrainTexelAt(inputs, origin.add(ivec2(2, r))),
        t.x,
      )

    const row0 = row(-1).toVar()
    const row1 = row(0).toVar()
    const row2 = row(1).toVar()
    const row3 = row(2).toVar()

    return terrainCatmullRom(row0, row1, row2, row3, t.y)
  })()
}

/**
 * いちばん近いテクセルの高さ m。1 タップ。
 *
 * 海面が浅瀬かどうかを判定するためだけに使う。48 m の粗さで足りる用途に
 * 16 タップの双三次を掛けると、水平線まで覆う板の全画素でそれを払うことになる
 */
export function terrainHeightNearestNode(
  inputs: HeightFieldInputs,
  world: Node<'vec2'>,
): Node<'float'> {
  return Fn(() => {
    const halfExtent = inputs.extent * 0.5
    const texel = inputs.extent / inputs.texels
    const grid = world.add(halfExtent).div(texel).sub(0.5).toVar()
    return terrainTexelAt(inputs, ivec2(floor(grid.add(0.5))))
  })()
}

/** 格子の値を直に引く。突き合わせの土台が働いていることの確認に使う */
export function terrainTexelAtNode(
  inputs: HeightFieldInputs,
  x: Node<'int'>,
  z: Node<'int'>,
): Node<'float'> {
  return terrainTexelAt(inputs, ivec2(x, z))
}
