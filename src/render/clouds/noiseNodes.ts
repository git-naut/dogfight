import {
  Fn,
  clamp,
  dot,
  float,
  floor,
  int,
  ivec2,
  ivec3,
  max,
  min,
  mix,
  normalize,
  select,
  sqrt,
  uint,
  uv,
  uvec2,
  uvec3,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import {
  HASH_CELL_OFFSET,
  PCG_INCREMENT,
  PCG_MULTIPLIER,
} from '../hashReference'

/**
 * 雲のノイズを TSL で焼く。
 *
 * `shaders/noise3d.frag` の写し。**式を 1 つずつ写す。**ここが 1 ビット
 * ずれると、以降の雲の絵はすべて別物になる。GLSL と WGSL と CPU 参照の
 * 3 つが同じ値を出すことを `tests/e2e/node-path.spec.ts` が数値で確かめる。
 *
 * `uint` の乗算は GLSL でも WGSL でも 2^32 で巻くので、PCG は仕様上
 * ビット一致する。`sin` を使うハッシュを避けた元の判断がそのまま効く。
 */

/**
 * 剰余をビット積で書く。
 *
 * 元は `((cell % period) + period) % period`。**周波数はすべて 2 のべき乗**
 * （2, 4, 8, 16）なので、`cell & (period - 1)` が同じ結果を返す。負の格子
 * 座標でも 2 の補数のまま正しく巻く。`%` の整数での挙動が TSL でどう出るかを
 * 当てにせずに済む。同値であることは `tests/render/noiseWrap.test.ts` が
 * 実際の範囲で確かめる。
 */

const pcg3d = Fn(([source]: [Node<'uvec3'>]) => {
  const v = uvec3(source).toVar()
  const m = uint(PCG_MULTIPLIER)
  const a = uint(PCG_INCREMENT)

  // **成分ごとに書く。**`@types/three` の整数ビット演算は
  // `IntegerType = 'int' | 'uint'` に限られていて、`uvec3` には型が付かない
  // （`OperatorNode.d.ts:507`）。実装は通るが、型を通すためにスカラで書く。
  // 計画が案じていた `uvec3 >> uint` のスカラ渡しの問題も、これで消える
  const vx = v.x.mul(m).add(a).toVar()
  const vy = v.y.mul(m).add(a).toVar()
  const vz = v.z.mul(m).add(a).toVar()

  // 順に代入していく。**2 行目は新しい x を、3 行目は新しい x と y を使う**
  const x1 = vx.add(vy.mul(vz)).toVar()
  const y1 = vy.add(vz.mul(x1)).toVar()
  const z1 = vz.add(x1.mul(y1)).toVar()

  const x1s = x1.bitXor(x1.shiftRight(uint(16))).toVar()
  const y1s = y1.bitXor(y1.shiftRight(uint(16))).toVar()
  const z1s = z1.bitXor(z1.shiftRight(uint(16))).toVar()

  const x2 = x1s.add(y1s.mul(z1s)).toVar()
  const y2 = y1s.add(z1s.mul(x2)).toVar()
  const z2 = z1s.add(x2.mul(y2)).toVar()

  return uvec3(x2, y2, z2)
}).setLayout({
  name: 'dogfightPcg3d',
  type: 'uvec3',
  inputs: [{ name: 'v', type: 'uvec3' }],
})

/** 整数の格子座標から 0..1 の 3 成分を返す */
const hash33 = Fn(([cell]: [Node<'ivec3'>]) => {
  // 負の値をそのまま uint へ渡すと実装依存になるのでオフセットで正へ寄せる
  const o = int(HASH_CELL_OFFSET)
  // GLSL の `uvec3(cell + 4096)` と同じ明示変換
  const u = uvec3(uint(cell.x.add(o)), uint(cell.y.add(o)), uint(cell.z.add(o)))
  return vec3(pcg3d(u)).mul(2 ** -32)
}).setLayout({
  name: 'dogfightHash33',
  type: 'vec3',
  inputs: [{ name: 'cell', type: 'ivec3' }],
})

/**
 * 格子座標を周期で巻く。`period` は 2 のべき乗なのでビット積で書ける。
 *
 * 元は `((cell % period) + period) % period`。負の格子座標でも 2 の補数の
 * まま正しく巻く。同値であることは `tests/render/noiseWrap.test.ts` が
 * 実際の範囲で確かめる
 */
function wrapCell(cell: Node<'ivec3'>, period: number): Node<'ivec3'> {
  const mask = period - 1
  return ivec3(cell.x.bitAnd(mask), cell.y.bitAnd(mask), cell.z.bitAnd(mask))
}

/**
 * Worley（セルラー）ノイズ。
 *
 * `freq` は JS の定数。**27 近傍は JS で展開する。**ハッシュは `setLayout` を
 * 付けた関数なので、展開されるのは呼び出しだけで本体は 1 つに収まる
 */
function worley(point: Node<'vec3'>, freq: number): Node<'float'> {
  // **`Fn` で包む。**`toVar()` と `assign()` は `Fn` の中にしか置けない
  // （`THREE.TSL: No stack defined for assign operation.`。実測で踏んだ）。
  // `setLayout` は付けないので呼び出しごとに展開されるが、ハッシュ本体は
  // `setLayout` 付きの関数のままなので、増えるのは呼び出しだけ
  return Fn(() => {
  const scaled = point.mul(freq).toVar()
  const id = ivec3(floor(scaled)).toVar()
  const f = scaled.sub(vec3(id)).toVar()

  const minDistSq = float(1e9).toVar()
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const offset = ivec3(x, y, z)
        const p = vec3(offset).add(hash33(wrapCell(id.add(offset), freq)))
        const diff = p.sub(f)
        minDistSq.assign(min(minDistSq, dot(diff, diff)))
      }
    }
  }
  // 反転して「セルの中心が濃い」向きにする
  return float(1).sub(clamp(sqrt(minDistSq), 0, 1))
  })()
}

function gradientDot(
  cell: Node<'ivec3'>,
  delta: Node<'vec3'>,
  freq: number,
): Node<'float'> {
  const g = hash33(wrapCell(cell, freq)).mul(2).sub(1)
  return dot(normalize(g), delta)
}

/** Perlin（勾配）ノイズ */
function perlin(point: Node<'vec3'>, freq: number): Node<'float'> {
  return Fn(() => {
  const scaled = point.mul(freq).toVar()
  const id = ivec3(floor(scaled)).toVar()
  const f = scaled.sub(vec3(id)).toVar()
  // 5 次のスムーズステップ。2 次だと格子の向きが見える
  const w = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)).toVar()

  const at = (dx: number, dy: number, dz: number): Node<'float'> =>
    gradientDot(id.add(ivec3(dx, dy, dz)), f.sub(vec3(dx, dy, dz)), freq)

  const n000 = at(0, 0, 0)
  const n100 = at(1, 0, 0)
  const n010 = at(0, 1, 0)
  const n110 = at(1, 1, 0)
  const n001 = at(0, 0, 1)
  const n101 = at(1, 0, 1)
  const n011 = at(0, 1, 1)
  const n111 = at(1, 1, 1)

  const x00 = mix(n000, n100, w.x)
  const x10 = mix(n010, n110, w.x)
  const x01 = mix(n001, n101, w.x)
  const x11 = mix(n011, n111, w.x)
  const y0 = mix(x00, x10, w.y)
  const y1 = mix(x01, x11, w.y)
  return mix(y0, y1, w.z).mul(0.5).add(0.5)
  })()
}

/**
 * 値域を張り直す。
 *
 * GLSL の `remap` と同じ。`max(inMax - inMin, 1e-6)` の下限も写す
 */
function remapNode(
  value: Node<'float'>,
  inMin: Node<'float'>,
  inMax: number,
  outMin: number,
  outMax: number,
): Node<'float'> {
  const span = float(inMax).sub(inMin)
  return float(outMin).add(
    value.sub(inMin).div(max(span, 1e-6)).mul(outMax - outMin),
  )
}

function worleyFbm(
  point: Node<'vec3'>,
  freq: number,
  maxFreq: number,
): Node<'float'> {
  let sum = worley(point, freq).mul(0.625)
  if (freq * 2 <= maxFreq) sum = sum.add(worley(point, freq * 2).mul(0.25))
  if (freq * 4 <= maxFreq) sum = sum.add(worley(point, freq * 4).mul(0.125))
  return sum
}

function perlinFbm(
  point: Node<'vec3'>,
  freq: number,
  maxFreq: number,
): Node<'float'> {
  let sum = perlin(point, freq).mul(0.5)
  if (freq * 2 <= maxFreq) sum = sum.add(perlin(point, freq * 2).mul(0.3))
  if (freq * 4 <= maxFreq) sum = sum.add(perlin(point, freq * 4).mul(0.2))
  return sum
}

/**
 * 焼くときの uv。**v を反転する。**
 *
 * node 経路はレンダーターゲットのテクスチャを引くとき v を裏返す。
 * `TextureNode.setupUV()` が `builder.isFlipY()` のときに
 * `texture.isRenderTargetTexture` を見て入れる補正で、GLSL 側は
 * `GLSLNodeBuilder.isFlipY()` が `true`、WGSL 側は `false`。**両方合わせると
 * 「v = 0 は描いたときの NDC の上」**という同じ約束になり、バックエンドに
 * よらず一貫している。
 *
 * 一方 `WebGLRenderer` の既定の経路は「v = 0 は NDC の下」で引く。だから
 * 同じ式を同じ uv で焼くと、**node 経路の密度は GLSL 版と上下が逆のノイズを
 * 引く。**絵は変わるが、分布（ヒストグラム）はほとんど動かないので
 * 段 12 の合格条件だけでは捕まらない。実測でそうだった。
 *
 * 焼く側で v を裏返して打ち消す。`(j + 0.5) / size` は 1/128 の倍数なので
 * `1 - v` は浮動小数でも正確に出る。ビット一致は保たれる。
 *
 * **読み戻しの検査には使わない。**`hashProbeFragmentNode` は
 * `readRenderTargetPixelsAsync` で生バイトを取る先なので、素の `uv()` のまま
 */
function bakeUv(): Node<'vec2'> {
  return vec2(uv().x, float(1).sub(uv().y))
}

/**
 * ノイズ 1 スライスの色を返すノード。
 *
 * `channelSet` と `maxFreq` は焼く前に決まるので JS の定数として畳む。
 * 動くのは `layer` だけで、これは uniform で渡す
 */
export function noiseFragmentNode(
  channelSet: 0 | 1,
  maxFreq: number,
  layer: Node<'float'>,
): Node<'vec4'> {
  const p = vec3(bakeUv(), layer)

  if (channelSet === 0) {
    // 形状ノイズ。R に Perlin と Worley を混ぜた基本形、GBA に細かさの階段
    const lowWorley = worleyFbm(p, 4, maxFreq)
    const perlinBase = perlinFbm(p, 4, maxFreq)
    // Perlin の谷を Worley で削る。塊の輪郭に不規則さが出る
    const perlinWorley = remapNode(perlinBase, lowWorley.sub(1), 1, 0, 1)

    return vec4(
      clamp(perlinWorley, 0, 1),
      worley(p, Math.min(4, maxFreq)),
      worley(p, Math.min(8, maxFreq)),
      worley(p, Math.min(16, maxFreq)),
    )
  }

  // ディテールノイズ。輪郭を削る用途なので Worley だけでよい
  return vec4(
    worley(p, Math.min(2, maxFreq)),
    worley(p, Math.min(4, maxFreq)),
    worley(p, Math.min(8, maxFreq)),
    float(1),
  )
}

/**
 * ハッシュの検査用。格子 `(x, y, 0)` の上位 8 ビットを書き出す。
 *
 * 32 ビットのまま読み戻せないので上位 8 ビットだけを `k / 255` で出す。
 * UNORM8 の丸めで k がそのまま戻るため、**量子化の丸めを跨がずにビット一致を
 * 検査できる。**CPU 側は `hashReference.ts` の `hashProbeExpected`
 */
export function hashProbeFragmentNode(side: number): Node<'vec4'> {
  const grid = uv().mul(side).floor()
  const o = int(HASH_CELL_OFFSET)
  const u = uvec3(
    uint(int(grid.x).add(o)),
    uint(int(grid.y).add(o)),
    uint(o),
  )
  const h = pcg3d(u)
  // 上位 8 ビット。`k / 255` で書けば UNORM8 の丸めで k がそのまま戻る
  const top = vec3(
    float(h.x.shiftRight(uint(24))),
    float(h.y.shiftRight(uint(24))),
    float(h.z.shiftRight(uint(24))),
  )
  return vec4(top.div(255), float(1))
}

/**
 * PCG の 2D 版。気象マップが使う。
 *
 * `shaders/weather.frag` の写し。3D 版と乗数の入り方が違う。**`v.y` の行は
 * 更新後の `v.x` を読む。**順序を入れ替えると別のハッシュになる。CPU 参照は
 * `hashReference.ts` の `pcg2d`
 */
const pcg2d = Fn(([source]: [Node<'uvec2'>]) => {
  const v = uvec2(source).toVar()
  const m = uint(PCG_MULTIPLIER)
  const a = uint(PCG_INCREMENT)

  const vx = v.x.mul(m).add(a).toVar()
  const vy = v.y.mul(m).add(a).toVar()

  const x1 = vx.add(vy.mul(m)).toVar()
  const y1 = vy.add(x1.mul(m)).toVar()

  const x1s = x1.bitXor(x1.shiftRight(uint(16))).toVar()
  const y1s = y1.bitXor(y1.shiftRight(uint(16))).toVar()

  const x2 = x1s.add(y1s.mul(m)).toVar()
  const y2 = y1s.add(x2.mul(m)).toVar()

  return uvec2(x2, y2)
}).setLayout({
  name: 'dogfightPcg2d',
  type: 'uvec2',
  inputs: [{ name: 'v', type: 'uvec2' }],
})

/** 整数の格子座標から 0..1 の 2 成分を返す */
const hash22 = Fn(([cell]: [Node<'ivec2'>]) => {
  const o = int(HASH_CELL_OFFSET)
  const u = uvec2(uint(cell.x.add(o)), uint(cell.y.add(o)))
  return vec2(pcg2d(u)).mul(2 ** -32)
}).setLayout({
  name: 'dogfightHash22',
  type: 'vec2',
  inputs: [{ name: 'cell', type: 'ivec2' }],
})

/**
 * 気象マップの格子を巻く。
 *
 * **周波数が 3・5・7 系なのでビット積は使えない。**ただし
 * `id = floor(uv * freq)` は 0..freq-1 に収まり、足す近傍は 0 か +1 だけ
 * なので、格子は 0..freq の範囲にしかならない。上端の 1 つを折り返すだけで
 * `((cell % period) + period) % period` と同値になる。同値であることは
 * `tests/render/noiseWrap.test.ts` が実際の範囲で確かめる
 */
function wrapCell2Node(cell: Node<'ivec2'>, period: number): Node<'ivec2'> {
  const p = int(period)
  const fold = (c: Node<'int'>): Node<'int'> =>
    select(c.greaterThanEqual(p), c.sub(p), c)
  return ivec2(fold(cell.x), fold(cell.y))
}

/** タイル化した 2D 勾配ノイズ。`weather.frag` の `perlin2` */
function perlin2(point: Node<'vec2'>, freq: number): Node<'float'> {
  // `toVar()` と `assign()` は `Fn` の中にしか置けない
  return Fn(() => {
    const scaled = point.mul(freq).toVar()
    const id = ivec2(floor(scaled)).toVar()
    const f = scaled.sub(vec2(id)).toVar()
    const w = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)).toVar()

    const at = (dx: number, dy: number): Node<'float'> => {
      const g = hash22(wrapCell2Node(id.add(ivec2(dx, dy)), freq)).mul(2).sub(1)
      return dot(normalize(g), f.sub(vec2(dx, dy)))
    }

    const n00 = at(0, 0)
    const n10 = at(1, 0)
    const n01 = at(0, 1)
    const n11 = at(1, 1)

    return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y).mul(0.5).add(0.5)
  })()
}

/** `weather.frag` の `fbm2`。重みは 0.5 / 0.25 / 0.15 / 0.1 */
function fbm2(point: Node<'vec2'>, freq: number): Node<'float'> {
  return perlin2(point, freq)
    .mul(0.5)
    .add(perlin2(point, freq * 2).mul(0.25))
    .add(perlin2(point, freq * 4).mul(0.15))
    .add(perlin2(point, freq * 8).mul(0.1))
}

/**
 * 気象マップ 1 枚の色を返すノード。`shaders/weather.frag` の写し。
 *
 * R にカバレッジ、G に雲頂の高さ、B に雲底の持ち上がり。**しきい値はここで
 * 掛けない。**焼く時点と実行時の両方で雲量を掛けると応答が急峻になる
 */
export function weatherFragmentNode(): Node<'vec4'> {
  const p = bakeUv()
  // FBM の実際の値域は 0.25 から 0.75 あたりに寄るので 0..1 へ引き伸ばす
  const amount = clamp(fbm2(p, 3).sub(0.3).div(0.4), 0, 1)
  const top = float(0.45).add(fbm2(p, 5).mul(0.55))
  const bottom = fbm2(p, 7).mul(0.3)
  return vec4(amount, top, bottom, float(1))
}
