import { Vec3 } from './vec3'

/**
 * 地形の高さ場。
 *
 * three に依存しない。理由は墜落判定と描画で地形の形が食い違ってはいけない
 * から。GLSL と TypeScript に同じ式を二重に書くと、いつか片方だけ直して
 * 「見えている山と当たる山がずれる」状態になる。ここを正本にして、render は
 * この配列をテクスチャへ上げ、頂点シェーダで同じ双三次補間で引く。
 *
 * 生成時間の計測はここではしない。sim 層は performance.now() を使えないので、
 * 呼び出し側で挟む。
 */

/** 高さ場が覆う world の一辺 m。1024 で割ると 48 m ちょうどになる値 */
export const TERRAIN_EXTENT = 49_152

/** 高さ場の一辺のテクセル数 */
export const TERRAIN_SIZE = 1024

/** テクセルの大きさ m */
export const TERRAIN_TEXEL = TERRAIN_EXTENT / TERRAIN_SIZE

/**
 * 海底の高さ m。
 *
 * 高さ場は負の値も返し、それが海底になる。海面は高度 0 なので、この値が
 * 外洋の深さそのもの。浅瀬の色を出すのに使うので、深すぎない値にする。
 */
export const SEABED_HEIGHT = -320

/**
 * 地形のシード。ワールドのシードとは分けて固定する。
 *
 * スクリプトごとに地形が変わると、スクリーンショット回帰で「同じ入力から
 * 同じピクセル」を見ている意味が薄れる。
 */
export const TERRAIN_SEED = 20_260_817

/**
 * 島の配置。
 *
 * 原点は必ず外洋にする。全スクリプトが原点にスポーンする（replay.ts の
 * spawnFromSpec がそう返す）ので、島の上に湧くと低空飛行のスクリプトが
 * その場で墜落する。
 *
 * 主峰だけ雲底（1,200 m）を突き抜ける高さにして、他は雲の下に収める。
 * 山頂が雲に隠れる絵と、山と雲が分離した絵の両方が撮れる。
 *
 * どの島も海岸が高さ場の縁から 2 km 以上内側に入るようにしてある。縁に
 * 掛かると、定義域の外で海底へクランプする処理が崖として見えてしまう。
 * 海岸線はノイズで崩すので、半径の 1.4 倍を見て余裕を取る。
 */
export interface Island {
  x: number
  z: number
  /** 海岸線までの目安の半径 m */
  radius: number
  /** 中心付近の高さ m */
  peak: number
  /** 尾根のノイズの位相。島ごとに変えて同じ形にしない */
  seed: number
}

/**
 * peak は「尾根が最大のときに届く高さ」で、実際の山頂はそこまで届かない。
 * 尾根の刻みが掛かるので、実測では peak の 84% 前後に落ち着く。主峰を
 * 2,200 m に見せたいので peak は 2,700 m にしてある（実測 2,2xx m）。
 */
const ISLANDS: readonly Island[] = [
  // 主峰の島。機首方向（-Z）の 11 km 先に置くので、離陸直後から見える
  { x: 1_500, z: -11_000, radius: 7_000, peak: 2_700, seed: 11 },
  { x: -11_000, z: -14_000, radius: 5_200, peak: 1_150, seed: 23 },
  { x: 12_000, z: -14_500, radius: 5_600, peak: 1_050, seed: 37 },
  // 振り返ると見える島。旋回の目印になる
  { x: -9_000, z: 6_000, radius: 4_000, peak: 850, seed: 53 },
]

/**
 * 座標から引ける整数ハッシュ。
 *
 * 既存の Rng（rng.ts）は状態を持つ列生成器なので座標からは引けない。
 * ここは同じ座標から常に同じ値が要るので別に持つ。
 *
 * 雲のノイズで学んだとおり、fract(sin(x) * 43758.5) 系は使わない。実装ごとに
 * 結果が変わる。整数の乗算とシフトなら常に同じ値になる。
 */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), h | 1)
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296
}

/** 格子の四隅を 5 次のスムーズステップで混ぜる値ノイズ */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  // 2 次だと格子の向きが見えるので 3 次で滑らかにする
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)

  const n00 = hash2(ix, iz, seed)
  const n10 = hash2(ix + 1, iz, seed)
  const n01 = hash2(ix, iz + 1, seed)
  const n11 = hash2(ix + 1, iz + 1, seed)

  return (
    (n00 * (1 - ux) + n10 * ux) * (1 - uz) + (n01 * (1 - ux) + n11 * ux) * uz
  )
}

/**
 * 尾根を立てた FBM。
 *
 * 素の値ノイズを重ねると丸い丘しかできない。谷を折り返して二乗すると、
 * 稜線が細く尖って山らしくなる。
 *
 * 減衰は 0.55。0.5 だと最初のオクターブが支配して、島 1 つに大きな瘤が
 * 1 つ乗るだけになった（実測で断面が単調な釣鐘型になった）。
 *
 * オクターブごとに座標を回す。同じ格子に重ねると、値ノイズの格子が軸に
 * 沿った縞として見える。回転は固定値なので決定論は保たれる。
 */
const RIDGE_ROT_COS = 0.8
const RIDGE_ROT_SIN = 0.6

function ridgeFbm(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0
  let norm = 0
  let amplitude = 1
  let frequency = 1
  let px = x
  let pz = z

  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(px * frequency, pz * frequency, seed + i * 101)
    const ridge = 1 - Math.abs(n * 2 - 1)
    sum += ridge * ridge * amplitude
    norm += amplitude
    amplitude *= 0.55
    frequency *= 2

    const rx = px * RIDGE_ROT_COS - pz * RIDGE_ROT_SIN
    pz = px * RIDGE_ROT_SIN + pz * RIDGE_ROT_COS
    px = rx
  }

  return sum / norm
}

/** 0..1 の滑らかな補間。edge0 > edge1 でも成立させる（減る向きに使う） */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * 尾根のノイズが 1 周する world の大きさ m。山の背骨の間隔を決める。
 *
 * 9,000 では直径 14 km の島に大きな尾根が 1 本しか乗らず、5,500 でも断面が
 * 単調な釣鐘型だった（実測。x=-4000 から山頂まで一度も下がらなかった）。
 * 3,600 なら基本オクターブが島の直径に 4 本入る。最も細かい 5 段目は
 * 3,600 / 16 = 225 m で、48 m テクセルで解像できる範囲に収まる。
 */
const RIDGE_SCALE = 3_600
/** 海岸線を崩すノイズの周期 m。円い島に見せないため */
const COAST_SCALE = 3_400
/** 海岸線を崩す二段目。入り江と岬の細かさを出す */
const COAST_SCALE_FINE = 1_250
/** 尾根の重ね数。多くしても 48 m のテクセルでは解像できない */
const RIDGE_OCTAVES = 5

/**
 * 連続な高さを返す元の式。
 *
 * 高さ場を焼くときにだけ使い、実行中はこれを直接呼ばない。実行中は焼いた
 * 配列を双三次で引く。両者がずれないよう、テストで格子点の一致を見る。
 */
function elevationAt(x: number, z: number, seed: number): number {
  let height = SEABED_HEIGHT

  for (const island of ISLANDS) {
    const dx = x - island.x
    const dz = z - island.z
    const normalized = Math.sqrt(dx * dx + dz * dz) / island.radius
    // 島から遠ければノイズを評価しない。定義域の大半は海なので、これで
    // 生成の費用が大きく下がる
    if (normalized >= 1.6) continue

    // 海岸線を崩す。二段重ねて入り江と岬を作る。中心付近では効かせない。
    // 効かせると主峰の高さがノイズ次第で下がり、雲底を超える保証が崩れる
    const coarse = valueNoise(x / COAST_SCALE, z / COAST_SCALE, seed + island.seed + 7) - 0.5
    const fine =
      valueNoise(x / COAST_SCALE_FINE, z / COAST_SCALE_FINE, seed + island.seed + 19) - 0.5
    const wobble = coarse * 0.42 + fine * 0.16
    const shaped = normalized + wobble * Math.min(1, normalized * 1.5)

    // 縁で 0、中心で 1。海岸線はこの値が 0 を跨ぐところにできる
    const mass = smoothstep(1, 0.12, shaped)
    if (mass <= 0) continue

    const ridge = ridgeFbm(x / RIDGE_SCALE, z / RIDGE_SCALE, seed + island.seed, RIDGE_OCTAVES)

    // 形は「削られる土台」と「削られない円錐」の 2 項で組む。
    //
    // 尾根を足し算で混ぜる形（土台 0.4 + 尾根 0.35 + 円錐 0.25）を先に
    // 試したが、島の断面が単調な釣鐘型になった。足し算だと土台と円錐の
    // 65% が半径だけで決まる滑らかな丘なので、尾根が何をしても丘が勝つ。
    //
    // 掛け算にすると尾根が谷を刻む。carve が 0.45 のところは土台の 45% まで
    // 落ちるので、山頂の近くにも谷ができて稜線が立つ。
    const dome = mass ** 1.5
    const carve = 0.45 + 0.55 * ridge
    // 中心付近で急に立つ項。ここは削らないので高さの下限になる
    const cone = mass ** 3

    // 主峰の保証。carve が最小 0.45 でも 0.68 × 0.45 + 0.32 = 0.626 なので
    // 中心の高さは 1,258 m。雲底 1,200 m を必ず超える
    const shapeSum = dome * carve * 0.68 + cone * 0.32
    const lifted = SEABED_HEIGHT + (island.peak - SEABED_HEIGHT) * shapeSum
    if (lifted > height) height = lifted
  }

  return height
}

/** Catmull-Rom。t=0 で p1 を厳密に返すので、格子点では焼いた値と一致する */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    p1 +
    0.5 * t * (p2 - p0) +
    0.5 * t2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) +
    0.5 * t3 * (-p0 + 3 * p1 - 3 * p2 + p3)
  )
}

export interface TerrainStats {
  min: number
  max: number
  mean: number
}

/**
 * 焼いた高さ場と、そこから引く操作。
 *
 * 起動時に一度作って使い回す。render は heights をそのままテクスチャへ上げる。
 */
export class Terrain {
  /** 行優先で size × size。render がテクスチャへ上げる */
  readonly heights: Float32Array
  readonly size = TERRAIN_SIZE
  readonly extent = TERRAIN_EXTENT
  readonly texel = TERRAIN_TEXEL
  readonly stats: TerrainStats

  constructor(readonly seed: number = TERRAIN_SEED) {
    const size = TERRAIN_SIZE
    const heights = new Float32Array(size * size)
    const half = TERRAIN_EXTENT / 2

    let min = Infinity
    let max = -Infinity
    let sum = 0

    for (let iz = 0; iz < size; iz++) {
      // テクセルの中心を評価する。端をずらすと双三次の対称性が崩れる
      const z = -half + (iz + 0.5) * TERRAIN_TEXEL
      for (let ix = 0; ix < size; ix++) {
        const x = -half + (ix + 0.5) * TERRAIN_TEXEL
        const h = elevationAt(x, z, seed)
        heights[iz * size + ix] = h
        if (h < min) min = h
        if (h > max) max = h
        sum += h
      }
    }

    this.heights = heights
    this.stats = { min, max, mean: sum / (size * size) }
  }

  /** 格子の値。範囲外は縁で止める。島は縁から離してあるので海底が返る */
  private at(ix: number, iz: number): number {
    const size = this.size
    const cx = ix < 0 ? 0 : ix >= size ? size - 1 : ix
    const cz = iz < 0 ? 0 : iz >= size ? size - 1 : iz
    return this.heights[cz * size + cx]!
  }

  /**
   * 双三次で引いた高さ m。
   *
   * 線形補間だと稜線が 48 m 刻みの折れ線になり、近距離で目に見える。
   * Catmull-Rom なら C1 連続になるので、格子より細かい滑らかさが出る。
   */
  heightAt(x: number, z: number): number {
    const half = TERRAIN_EXTENT / 2
    // テクセル中心を基準にした格子座標
    const gx = (x + half) / TERRAIN_TEXEL - 0.5
    const gz = (z + half) / TERRAIN_TEXEL - 0.5
    const ix = Math.floor(gx)
    const iz = Math.floor(gz)
    const tx = gx - ix
    const tz = gz - iz

    const rows: [number, number, number, number] = [0, 0, 0, 0]
    for (let r = -1; r <= 2; r++) {
      rows[r + 1] = catmullRom(
        this.at(ix - 1, iz + r),
        this.at(ix, iz + r),
        this.at(ix + 1, iz + r),
        this.at(ix + 2, iz + r),
        tx,
      )
    }
    return catmullRom(rows[0], rows[1], rows[2], rows[3], tz)
  }

  /**
   * 法線。中央差分で勾配を取る。
   *
   * 刻みはテクセル 1 つぶん。細かくすると双三次の高周波を拾って暴れる。
   */
  normalAt(x: number, z: number, out: Vec3 = new Vec3()): Vec3 {
    const d = TERRAIN_TEXEL
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z)
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d)
    // 勾配 (dh/dx, dh/dz) の面の法線は (-dh/dx, 1, -dh/dz)
    return out.set(-hx / (2 * d), 1, -hz / (2 * d)).normalize()
  }

  /** 海面より下か。海岸線の判定と、機体が海に落ちたかの区別に使う */
  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < 0
  }
}

/**
 * 共有の地形。
 *
 * 起動時に一度作って使い回す。テストからは new Terrain(seed) で別物を
 * 作れるようにしてある。
 */
let shared: Terrain | null = null

export function defaultTerrain(): Terrain {
  if (shared === null) shared = new Terrain(TERRAIN_SEED)
  return shared
}

/** テストが島の配置を検査できるように読み取り専用で出す */
export function terrainIslands(): readonly Island[] {
  return ISLANDS
}
