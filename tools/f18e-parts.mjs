// F/A-18E の glTF から舵面と降着装置を同定する。
//
// **名前が使えない。**Sketchfab が FBX から変換したモデルなので、ノード名は
// `Meshpart126_Material.001_0` のような自動生成名。意味のある名前は
// `Canopy1` と `Tailhook1/2` の 3 つだけ。F/A-18C（FlightGear の AC3D）は
// `AileronLeft` で分かれていたので、そちらの作法は使えない。
//
// **幾何で当てる。**位置と寸法から「主翼後縁の外側にある左右対称の薄板」を
// エルロンと決める。当てた結果は `tests/tools/f18eParts.test.ts` が固定する。
//
// ## 座標系（実測で確定）
//
// 原点は機体のどこでもない中途半端な場所にあり、軸も three の規約と違う。
//
// | 軸 | 意味 | 向き |
// |---|---|---|
// | X | 前後 | **機首が −X** |
// | Y | 上下 | 上が +Y |
// | Z | 左右 | 翼幅方向 |
//
// 単位も実機ではない。全長を公称 18.31 m とみなすと倍率 0.2005（およそ
// 5 単位 = 1 m）。`SCALE` はその実測値。
import { readGltfParts, findMirrorPairs } from './gltf-parts.mjs'

/**
 * モデルの単位を m へ直す倍率。
 *
 * 全体の bbox の X（前後）を公称の全長 18.31 m とみなして出した。
 * この倍率で翼幅が 13.19 m（公称 13.62、差 3.2%）、全高が 4.91 m
 * （公称 4.88、差 0.6%）になる。**2 つが独立に合うので倍率は正しい。**
 */
export const SCALE = 18.31 / 91.32

/** 公称寸法 m。米海軍 fact file / F/A-18E/F NATOPS / SAC（`assets/CREDITS.md`） */
export const SPEC = {
  length: 18.31,
  span: 13.62,
  height: 4.88,
  wingArea: 46.5,
}

/**
 * 舵面と可動部の同定。
 *
 * **位置は実測値で書く。**モデルは固定なので、当たった値をそのまま条件に
 * する。閾値は実測の中心から ±0.6 m 程度に取り、隣の部品を巻き込まない
 * ことを検査で確かめる。
 *
 * 単位は m（`SCALE` を掛けたあと）。`x` は前後で機首が負、`z` は左右の絶対値。
 */
export const PART_RULES = [
  {
    name: 'AileronLeft',
    role: 'aileron',
    side: 'left',
    // 実測 X 1.43 / |Z| 5.41 / 1.99 x 0.33 x 2.06
    match: (p) => near(p.x, 1.43, 0.5) && near(p.absZ, 5.41, 0.5) && p.z < 0 && thin(p, 0.45),
  },
  {
    name: 'AileronRight',
    role: 'aileron',
    side: 'right',
    match: (p) => near(p.x, 1.43, 0.5) && near(p.absZ, 5.41, 0.5) && p.z > 0 && thin(p, 0.45),
  },
  {
    name: 'FlapLeft',
    role: 'flap',
    side: 'left',
    // 実測 X -0.24 / |Z| 3.20 / 1.94 x 0.27 x 2.64
    match: (p) => near(p.x, -0.24, 0.6) && near(p.absZ, 3.2, 0.6) && p.z < 0 && thin(p, 0.4),
  },
  {
    name: 'FlapRight',
    role: 'flap',
    side: 'right',
    match: (p) => near(p.x, -0.24, 0.6) && near(p.absZ, 3.2, 0.6) && p.z > 0 && thin(p, 0.4),
  },
  {
    name: 'StabilatorLeft',
    role: 'stabilator',
    side: 'left',
    // 実測 X 6.00 / |Z| 2.24 / 3.99 x 0.20 x 2.60。**水平尾翼は全遊動**
    match: (p) => near(p.x, 6.0, 0.8) && near(p.absZ, 2.24, 0.8) && p.z < 0 && thin(p, 0.35),
  },
  {
    name: 'StabilatorRight',
    role: 'stabilator',
    side: 'right',
    match: (p) => near(p.x, 6.0, 0.8) && near(p.absZ, 2.24, 0.8) && p.z > 0 && thin(p, 0.35),
  },
  {
    name: 'RudderLeft',
    role: 'rudder',
    side: 'left',
    // 実測 X 4.95 / |Z| 1.25 / 1.04 x 1.74 x 0.68。**垂直尾翼ごと動かす。**
    // ラダーだけを切り出すメッシュが無いので、面全体を回す（見た目で足りる）
    match: (p) => near(p.x, 4.95, 0.7) && near(p.absZ, 1.25, 0.6) && p.z < 0 && p.sizeY > 1.2,
  },
  {
    name: 'RudderRight',
    role: 'rudder',
    side: 'right',
    match: (p) => near(p.x, 4.95, 0.7) && near(p.absZ, 1.25, 0.6) && p.z > 0 && p.sizeY > 1.2,
  },
]

/** 降着装置。**Y が低いものをまとめる。**個別の名前は要らない */
export const GEAR_RULE = {
  name: 'gear',
  match: (p) => p.y < -0.6,
}

function near(value, target, tolerance) {
  return Math.abs(value - target) <= tolerance
}

/** 板状か。いちばん薄い辺が `limit` m 未満 */
function thin(p, limit) {
  return Math.min(p.sizeX, p.sizeY, p.sizeZ) < limit
}

/**
 * glTF を読んで部品を同定する。
 *
 * @returns `{ parts, matched, gear, size, pairs }`
 *   `matched` は `{ name, role, side, index, part }` の配列
 */
export function identifyParts(gltfPath) {
  const { parts, size, min, max } = readGltfParts(gltfPath)
  const metric = parts.map((p, index) => ({
    index,
    name: p.name,
    triangles: p.triangles,
    x: p.center[0] * SCALE,
    y: p.center[1] * SCALE,
    z: p.center[2] * SCALE,
    absZ: Math.abs(p.center[2]) * SCALE,
    sizeX: p.extent[0] * SCALE,
    sizeY: p.extent[1] * SCALE,
    sizeZ: p.extent[2] * SCALE,
    raw: p,
  }))

  // **親ノードでまとめる。**Sketchfab の変換はマテリアルごとにノードを
  // 分けるので、`Meshpart125`（左の垂直尾翼）は 2 つのプリミティブを持つ。
  // 回すのは親 1 つでよく、同定の結果も親の名前で数える
  const matched = []
  for (const rule of PART_RULES) {
    const hits = metric.filter((p) => rule.match(p))
    const nodes = new Map()
    for (const hit of hits) {
      const key = hit.raw.parent ?? hit.name
      if (!nodes.has(key)) nodes.set(key, { node: key, primitives: [], triangles: 0 })
      const entry = nodes.get(key)
      entry.primitives.push(hit)
      entry.triangles += hit.triangles
    }
    for (const entry of nodes.values()) {
      matched.push({
        name: rule.name,
        role: rule.role,
        side: rule.side,
        node: entry.node,
        triangles: entry.triangles,
        primitives: entry.primitives,
        part: entry.primitives[0],
      })
    }
  }
  const gear = metric.filter((p) => GEAR_RULE.match(p))

  return {
    parts: metric,
    matched,
    gear,
    pairs: findMirrorPairs(parts),
    size: size.map((v) => v * SCALE),
    min,
    max,
  }
}
