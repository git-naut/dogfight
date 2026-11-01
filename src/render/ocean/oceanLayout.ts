/**
 * 海面のパッチの選び方（CDLOD、段 S4a-1）。
 *
 * 段 S4b で消した地形の四分木（`terrain/layout.ts`）と同じく、静的な四分木から選ぶ。違いは 2 つ。
 *
 * - **カメラを中心に敷く。**地形は 48 km の定義域に固定だが、海は水平線まで続く。
 *   根（一辺 `oceanRootSize`）を、カメラを含む根の格子のまわりに 3 × 3 で並べる。
 *   根の格子へ寄せて動かすので、カメラが動いてもパッチの境目は世界に固定のまま
 * - **距離にカメラの高さを入れる。**地形は水平の距離で測るが、高度 1,000 m から真下の
 *   海を 0.5 m まで割る意味は無い。頂点のモーフも同じ 3 次元の距離で測る
 *
 * 根の外（変位のある範囲の外）は、平らな板が新しい海の材質で覆う。根の縁へ向けて変位を
 * 0 へ絞り（`oceanEdgeFade`）、継ぎ目を出さない。
 *
 * three を import しない。分割の距離（`lodRange`）とモーフ（`morphFactor`）と格子（`createUnitGrid`）は、
 * 段 S4b で地形を消したときに `terrain/layout.ts`・`terrain/terrainMesh.ts` から移した。
 */

/** 最も細かいパッチの一辺 m */
export const OCEAN_LEAF = 0.5
/**
 * パッチ 1 枚のセルの数（一辺）。web-ocean の `GRID` は 32 だが、32 では high の低空（2.5 m）で
 * 109 万三角形になり、地形（high 45 万）と合わせてシーンの 150 万を越える。16 で 27 万。
 * 1 セルは分割距離の先で見込み約 2 度。細かい波は頂点でなく法線（テクスチャ）で描く
 */
export const OCEAN_PATCH_CELLS = 16
/** 根の格子の並べ方。カメラを含む根のまわりに ±1 */
export const OCEAN_ROOT_SPAN = 1
/** 縁へ向けて変位を絞る幅。根の一辺に対する比 */
export const OCEAN_EDGE_FADE = 0.25

/**
 * 寄せ始める位置。寄せ終わる距離（親の分割距離）に対する比。web-ocean の `0.8 * R` と同じ。
 * 段 S4b まで、地形から引き継いだ 0.62 を自分の分割距離に掛けていた（下の `selectOceanPatches`）
 */
export const OCEAN_MORPH_START_RATIO = 0.8

/** 辺の印。その辺の向こうが 1 段粗いパッチ（`OceanPatch.edges` のビット） */
export const OCEAN_EDGE_MINUS_X = 1
export const OCEAN_EDGE_PLUS_X = 2
export const OCEAN_EDGE_MINUS_Z = 4
export const OCEAN_EDGE_PLUS_Z = 8

/**
 * 分割距離はノードの一辺のこの倍数。地形の四分木で決めた値（1.8 で、32 セルのパッチの
 * 頂点の間隔が画面で 35 px 前後。2.4 では三角形が 3 割増えて見え方は変わらなかった）
 */
const RANGE_FACTOR = 1.8

/** ノードを割る距離 m。一辺に比例させると、隣り合うノードの深さの差が 1 以内に収まる */
export function lodRange(nodeSize: number, distanceScale: number): number {
  return nodeSize * RANGE_FACTOR * distanceScale
}

/** 親の格子へ寄せる量 0..1。0 なら自分の格子のまま、1 なら親の格子に完全に一致する */
export function morphFactor(distance: number, start: number, end: number): number {
  if (end <= start) return 0
  const t = (distance - start) / (end - start)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** 0..1 の正方格子。position.xy が格子座標（z は 0）。頂点シェーダがパッチの原点と大きさを掛ける */
export function createUnitGrid(cells: number): { position: Float32Array; index: Uint32Array } {
  const side = cells + 1
  const position = new Float32Array(side * side * 3)
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const o = (j * side + i) * 3
      position[o] = i / cells
      position[o + 1] = j / cells
    }
  }
  const index = new Uint32Array(cells * cells * 6)
  let k = 0
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * side + i
      const b = a + 1
      const c = a + side
      const d = c + 1
      index[k++] = a
      index[k++] = c
      index[k++] = b
      index[k++] = b
      index[k++] = c
      index[k++] = d
    }
  }
  return { position, index }
}

export interface OceanPatch {
  /** -X, -Z 側の角のワールド座標 */
  x: number
  z: number
  size: number
  /** 根からの深さ。0 が根 */
  depth: number
  morphStart: number
  morphEnd: number
  /**
   * 1 段粗い隣と接する辺の印（`OCEAN_EDGE_*` の和）。その辺の頂点は粗い側の頂点と同じ式で
   * 置く（`oceanVertex`）。段 S4d で足した
   */
  edges: number
}

export interface OceanCamera {
  x: number
  /** 海面（高さ 0）からの高さ m。負なら 0 とみなす */
  y: number
  z: number
}

/** 根の一辺 m。段数（四分木の深さの数）から */
export function oceanRootSize(levels: number): number {
  return OCEAN_LEAF * 2 ** (levels - 1)
}

/** 点から、高さ 0 の軸並行の矩形までの 3 次元の距離 */
export function distanceToPatch(camera: OceanCamera, x: number, z: number, size: number): number {
  const dx = Math.max(x - camera.x, 0, camera.x - (x + size))
  const dz = Math.max(z - camera.z, 0, camera.z - (z + size))
  const dy = Math.max(camera.y, 0)
  return Math.sqrt(dx * dx + dz * dz + dy * dy)
}

/** 変位のある範囲（根の 3 × 3 の正方形）。カメラを含む根の格子に寄せる */
export function oceanCoverage(camera: OceanCamera, levels: number): { x0: number; z0: number; size: number } {
  const root = oceanRootSize(levels)
  const cx = Math.floor(camera.x / root) * root
  const cz = Math.floor(camera.z / root) * root
  return {
    x0: cx - OCEAN_ROOT_SPAN * root,
    z0: cz - OCEAN_ROOT_SPAN * root,
    size: (2 * OCEAN_ROOT_SPAN + 1) * root,
  }
}

/**
 * パッチの一覧を選ぶ。同じカメラからは常に同じ並び。
 *
 * @param out 使い回す配列。毎フレーム呼ぶのでゴミを増やさない
 */
export function selectOceanPatches(
  camera: OceanCamera,
  levels: number,
  distanceScale: number,
  out: OceanPatch[] = [],
): OceanPatch[] {
  out.length = 0
  const root = oceanRootSize(levels)
  const cover = oceanCoverage(camera, levels)
  const n = 2 * OCEAN_ROOT_SPAN + 1
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      visit(cover.x0 + i * root, cover.z0 + j * root, root, 0, camera, levels - 1, distanceScale, out)
    }
  }
  markCoarserEdges(out, cover)
  return out
}

/**
 * 1 段粗い隣と接する辺に印を付ける。パッチは四分木の節なので、深さと格子の番号で引ける。
 * 辺のすぐ外の点を、1 段粗い節が覆っていれば、その辺の向こうは粗い
 */
function markCoarserEdges(patches: OceanPatch[], cover: { x0: number; z0: number }): void {
  const key = (depth: number, ix: number, iz: number) => `${depth}:${ix}:${iz}`
  const nodes = new Set<string>()
  for (const p of patches) {
    nodes.add(key(p.depth, Math.round((p.x - cover.x0) / p.size), Math.round((p.z - cover.z0) / p.size)))
  }
  for (const p of patches) {
    p.edges = 0
    if (p.depth === 0) continue
    const cs = p.size * 2
    const coarser = (px: number, pz: number) =>
      nodes.has(key(p.depth - 1, Math.floor((px - cover.x0) / cs), Math.floor((pz - cover.z0) / cs)))
    const e = p.size * 0.25
    const mx = p.x + p.size / 2
    const mz = p.z + p.size / 2
    if (coarser(p.x - e, mz)) p.edges |= OCEAN_EDGE_MINUS_X
    if (coarser(p.x + p.size + e, mz)) p.edges |= OCEAN_EDGE_PLUS_X
    if (coarser(mx, p.z - e)) p.edges |= OCEAN_EDGE_MINUS_Z
    if (coarser(mx, p.z + p.size + e)) p.edges |= OCEAN_EDGE_PLUS_Z
  }
}

function visit(
  x: number,
  z: number,
  size: number,
  depth: number,
  camera: OceanCamera,
  maxDepth: number,
  distanceScale: number,
  out: OceanPatch[],
): void {
  const range = lodRange(size, distanceScale)
  if (depth >= maxDepth || distanceToPatch(camera, x, z, size) > range) {
    // **寄せは親の分割距離へ向けて。**この節は親が割れた所（親の分割距離の内側）でだけ選ばれる。
    // 段 S4b まで自分の分割距離で寄せ終えていて、選ばれた節は常に寄せ切り（半分の細かさ）、
    // 細かさの違う境目で頂点が食い違って海面が割れた（段 S4d で実機の黒い線から見つけた）
    const end = 2 * range
    out.push({ x, z, size, depth, morphStart: end * OCEAN_MORPH_START_RATIO, morphEnd: end, edges: 0 })
    return
  }
  const child = size / 2
  visit(x, z, child, depth + 1, camera, maxDepth, distanceScale, out)
  visit(x + child, z, child, depth + 1, camera, maxDepth, distanceScale, out)
  visit(x, z + child, child, depth + 1, camera, maxDepth, distanceScale, out)
  visit(x + child, z + child, child, depth + 1, camera, maxDepth, distanceScale, out)
}

/**
 * 頂点のモーフの量（頂点シェーダと同じ式）。点 (px, pz) とカメラの 3 次元の距離から。
 * `scale` は寄せの範囲の倍率で、1 段粗い隣の寄せを引くときは 2
 */
export function oceanMorph(camera: OceanCamera, px: number, pz: number, patch: OceanPatch, scale = 1): number {
  const dy = Math.max(camera.y, 0)
  const d = Math.hypot(px - camera.x, pz - camera.z, dy)
  return morphFactor(d, patch.morphStart * scale, patch.morphEnd * scale)
}

/**
 * 格子 (i, j)（0..OCEAN_PATCH_CELLS）の頂点の、寄せたあとの xz と、変位の段を決める頂点の間隔 m
 * （頂点シェーダと同じ式）。
 *
 * **粗い隣と接する辺の頂点は、粗い側の頂点として置く**（段 S4d）。辺に沿う番号を偶数（粗い側の
 * 頂点）へ寄せ、粗い側の寄せの量（範囲は 2 倍）で、粗い側の親の格子（4 の倍数）へ寄せる。
 * 間隔も粗い側のもの。これで細かさの違う境目で頂点がそろい、海面が割れない
 */
export function oceanVertex(
  patch: OceanPatch,
  i: number,
  j: number,
  camera: OceanCamera,
): { x: number; z: number; cell: number } {
  const n = OCEAN_PATCH_CELLS
  const w = patch.size / n
  const morphAt = (gi: number, gj: number, scale: number) =>
    oceanMorph(camera, patch.x + gi * w, patch.z + gj * w, patch, scale)
  const m = morphAt(i, j, 1)
  let gi = i + (Math.floor(i * 0.5) * 2 - i) * m
  let gj = j + (Math.floor(j * 0.5) * 2 - j) * m
  let cell = w * (1 + m)
  const coarse = (along: number, at: (a: number) => [number, number]) => {
    const a = Math.floor(along * 0.5) * 2
    const mc = morphAt(...at(a), 2)
    return { along: a + (Math.floor(a * 0.25) * 4 - a) * mc, cell: 2 * w * (1 + mc) }
  }
  const onX = (i === 0 && (patch.edges & OCEAN_EDGE_MINUS_X) !== 0) || (i === n && (patch.edges & OCEAN_EDGE_PLUS_X) !== 0)
  const onZ = (j === 0 && (patch.edges & OCEAN_EDGE_MINUS_Z) !== 0) || (j === n && (patch.edges & OCEAN_EDGE_PLUS_Z) !== 0)
  if (onX) {
    const c = coarse(j, (a) => [i, a])
    gi = i
    gj = c.along
    cell = c.cell
  }
  if (onZ) {
    const c = coarse(i, (a) => [a, j])
    gj = j
    gi = onX ? i : c.along
    cell = onX ? cell : c.cell
  }
  return { x: patch.x + gi * w, z: patch.z + gj * w, cell }
}

/**
 * 変位の強さ 0..1。変位のある範囲の縁へ向けて 0 へ絞る（外は平らな板）。
 * 縁から `OCEAN_EDGE_FADE × 根` の幅で 1 から 0 へ、なめらかに（smoothstep）
 */
export function oceanEdgeFade(px: number, pz: number, cover: { x0: number; z0: number; size: number }, root: number): number {
  const inset = Math.min(px - cover.x0, cover.x0 + cover.size - px, pz - cover.z0, cover.z0 + cover.size - pz)
  const t = Math.min(Math.max(inset / (OCEAN_EDGE_FADE * root), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * 頂点で変位を引くときのミップの段の足し（web-ocean の `+ 0.5`）。頂点の間隔より細かい波を
 * 半段ぼかして、モーフで間隔が変わるときのちらつきを抑える
 */
export const OCEAN_LOD_BIAS = 0.5

/** 頂点の間隔 cell m で、一辺 L m・格子 N のカスケードを引くミップの段（頂点シェーダと同じ式） */
export function oceanCascadeLod(cell: number, L: number, N: number): number {
  return Math.log2(Math.max(cell / (L / N), 1)) + OCEAN_LOD_BIAS
}

/** この段より粗く引くカスケードは足さない。最後の段（1 × 1）は場の平均で、直流を除いてあるので 0 */
export function oceanCascadeSkipped(lod: number, N: number): boolean {
  return lod >= Math.log2(N)
}

/**
 * カスケードの uv の起点の端数。uv は `(xz − 起点) / L + 端数 + 0.5 / N` で求める。
 * ワールドの xz をそのまま L で割ると、細かいカスケード（L 0.26 m）は 20 km 先で uv が 8 万を
 * 越え、32 ビットでは texel の位置が出ない。起点（覆う範囲の角）からの差にして、端数は CPU が
 * 倍精度で渡す。`0.5 / N` は格子点を texel の中心に合わせる分（CPU 参照の格子点と一致させる）
 */
export function oceanUvOffset(origin: number, L: number): number {
  const t = origin / L
  return t - Math.floor(t)
}

/** 三角形の総数 */
export function oceanTriangleCount(patches: readonly OceanPatch[]): number {
  return patches.length * OCEAN_PATCH_CELLS * OCEAN_PATCH_CELLS * 2
}

/**
 * くり返す模様を薄め始める・薄め終える画面の大きさ（1 周期が覆う画素の数）。段 S4d で足した。
 *
 * 海面の風の斑（web-ocean の cat's paws）は模様のテクスチャを約 91 m ごとにくり返して引く。遠くで
 * 1 周期が画面で十数画素まで縮むと、遠近の網目に見えた（実機の朝の海で約 15 画素）。値は推測で、
 * 実機の絵で網目が消えることを確かめた
 */
export const OCEAN_TILE_FADE_PX: readonly [number, number] = [16, 48]

/**
 * くり返す模様を効かせる重み 0..1（0 なら模様を使わない）。1 周期 L m が、画素が海面で覆う幅
 * footprint m の何画素ぶんかで決める（16 画素以下で 0、48 画素以上で 1、間は smoothstep）。
 * 海面の陰影（`oceanSurface.ts` の風の斑）が同じ式を TSL で持つ
 */
export function oceanTileFade(L: number, footprint: number): number {
  const px = L / Math.max(footprint, 1e-6)
  const [a, b] = OCEAN_TILE_FADE_PX
  const t = Math.min(Math.max((px - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
