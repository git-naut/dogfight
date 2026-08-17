/**
 * 地形パッチの選び方（CDLOD）。
 *
 * three を import しない。GLSL と three に写す前に、境界条件をここで確定して
 * node のテストで固める。雲で `clouds/geometry.ts` に同じことをして、
 * シェーダ側で疑う範囲がだいぶ狭まった。
 *
 * カメラ中心の同心リングではなく、**定義域を覆う静的な四分木**にしてある。
 * 理由は入れ子の厳密さ。リング方式はレベルごとに格子へスナップする必要が
 * あり、親の穴と子の範囲が半パッチずれて隙間ができる。四分木なら親子の
 * 境界が構造的に一致する。
 *
 * 地形の定義域は 48 km しかないので、その外まで敷く必要もない。外は平らな
 * 海なので海面の板が覆う。
 */

/** 選ばれたパッチ 1 枚 */
export interface TerrainPatch {
  /** ノードの -X, -Z 側の角のワールド座標 */
  x: number
  z: number
  /** ノードの一辺 m */
  size: number
  /** 四分木の深さ。0 が根（定義域全体）で、深いほど細かい */
  depth: number
  /**
   * 親の格子へ寄せ始める距離 m と、寄せ終わる距離 m。
   *
   * 隣り合うパッチの深さが 1 違うと、辺の頂点数が半分になって T 字の
   * 裂け目が出る。深い側の頂点を親の格子位置へ寄せれば繋がる。
   * カメラが離れるほど寄せる量を増やして、切り替わりを目に見せない。
   */
  morphStart: number
  morphEnd: number
}

export interface SelectOptions {
  /** 定義域の一辺 m */
  extent: number
  /** 四分木の最大の深さ。プリセットの terrainLodLevels - 1 */
  maxDepth: number
  /** LOD の切り替え距離の倍率。プリセットの lodDistanceScale */
  distanceScale: number
}

/**
 * 深さ d のノードを分割する距離 m。ノードの一辺に対する倍率。
 *
 * 画面上のセルの大きさは 距離 / (この値 × セル数) で決まり、三角形数は
 * その二乗で増える。品質と費用が同じ量で釣り合っているので、ここに
 * 自由な選択はない。実測（1080p, fov 60 換算）。
 *
 * | 倍率 × セル数 | 枚数 | 三角形 | 3 km でのセル |
 * | 2.2 × 32 | 292 | 598k | 28 px |
 * | 1.8 × 32 | 220 | 451k | 35 px |
 * | 1.8 × 24 | 220 | 253k | 46 px |
 *
 * 1.8 を採った。28 px と 35 px の差は稜線の見え方に出ないのに、三角形は
 * 3 割違う。ポリゴン予算はシーン合計 1.5M で、Phase 4 の機体 9 機が
 * 550k 前後を使う見込みなので、地形は 500k 以内に収めたい。
 */
const RANGE_FACTOR = 1.8

/** 寄せ始める位置。分割距離に対する比 */
const MORPH_START_RATIO = 0.62

export function lodRange(nodeSize: number, distanceScale: number): number {
  return nodeSize * RANGE_FACTOR * distanceScale
}

/** 点から軸並行の矩形までの距離。矩形の内側なら 0 */
export function distanceToBox(
  px: number,
  pz: number,
  x: number,
  z: number,
  size: number,
): number {
  const dx = Math.max(x - px, 0, px - (x + size))
  const dz = Math.max(z - pz, 0, pz - (z + size))
  return Math.sqrt(dx * dx + dz * dz)
}

/**
 * カメラ位置からパッチの一覧を選ぶ。
 *
 * 同じカメラ位置からは常に同じ並びが出る。実時間にも乱数にも依存しない。
 *
 * @param out 使い回す配列。毎フレーム呼ぶのでゴミを増やさない
 */
export function selectPatches(
  cameraX: number,
  cameraZ: number,
  options: SelectOptions,
  out: TerrainPatch[] = [],
): TerrainPatch[] {
  out.length = 0
  const half = options.extent / 2
  visit(-half, -half, options.extent, 0, cameraX, cameraZ, options, out)
  return out
}

function visit(
  x: number,
  z: number,
  size: number,
  depth: number,
  cameraX: number,
  cameraZ: number,
  options: SelectOptions,
  out: TerrainPatch[],
): void {
  const range = lodRange(size, options.distanceScale)

  // これ以上細かくできない、またはカメラが遠いならここで描く
  if (depth >= options.maxDepth || distanceToBox(cameraX, cameraZ, x, z, size) > range) {
    out.push({
      x,
      z,
      size,
      depth,
      morphStart: range * MORPH_START_RATIO,
      morphEnd: range,
    })
    return
  }

  const child = size / 2
  visit(x, z, child, depth + 1, cameraX, cameraZ, options, out)
  visit(x + child, z, child, depth + 1, cameraX, cameraZ, options, out)
  visit(x, z + child, child, depth + 1, cameraX, cameraZ, options, out)
  visit(x + child, z + child, child, depth + 1, cameraX, cameraZ, options, out)
}

/**
 * 親の格子へ寄せる量 0..1。
 *
 * 0 なら自分の格子のまま、1 なら親の格子に完全に一致する。
 */
export function morphFactor(distance: number, start: number, end: number): number {
  if (end <= start) return 0
  const t = (distance - start) / (end - start)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** パッチ 1 枚のセルの大きさ m。頂点シェーダの刻みと揃える */
export function patchCellSize(patch: TerrainPatch, patchCells: number): number {
  return patch.size / patchCells
}

/**
 * 三角形の総数。予算の確認に使う。
 *
 * パッチ 1 枚あたり セル数² × 2。
 */
export function triangleCount(patches: readonly TerrainPatch[], patchCells: number): number {
  return patches.length * patchCells * patchCells * 2
}
