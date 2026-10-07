// F/A-18E の脚の扉（2026-10-08）。
//
// **原本に扉の部品は無い。**前脚は格納部の開口が開いたまま（脚を上げると機体の下に黒い穴が
// 見える）、主脚は格納部の開口そのものが無い。ユーザーの要望（脚を畳むとき機体面が開いて
// 閉じる表現）で、扉の板をこちらで足す。
//
// 寸法は原本を下から真上へ光線で測った（`lowestHit`）。座標は**この作品の座標**（機首 −Z、
// 上 +Y、右 +X）で m。扉の形（平らな長方形）と開く角度（90 度）は推測。
//
// | 扉 | x | z | 閉じたときの高さ | 蝶番 |
// |---|---|---|---|---|
// | 前脚・左右 2 枚 | −0.18〜0・0〜+0.18 | −6.18〜−5.00 | −0.235（前）〜−0.195（後） | 外側の縁 |
// | 主脚・左右 1 枚ずつ | ±0.30〜±0.70 | −0.15〜+1.45 | −0.597 | 外側の縁 |
//
// 前脚の開口の測った値は x ±0.18、z −6.18〜約 −5.0、縁の外板の高さは左右とも −0.215、前端
// −0.245・後端 −0.19。主脚の後ろの下面は |x| 0.36〜0.72 で y −0.59〜−0.61 のほぼ平ら。
// 主脚は付け根（x ±0.475、z 0.05）から後ろへ畳まれるので、その通り道を覆う。
import { readGltfParts } from './gltf-parts.mjs'
import { SCALE } from './f18e-parts.mjs'

/** 扉が開き切るまでに使う、脚の位置の割合。残りで脚が動く */
export const DOOR_SHARE = 0.2

/** 扉が開く角度 deg（推測） */
export const DOOR_OPEN_DEG = 90

/**
 * 扉の定義。`corners` は閉じたときの 4 隅で、最初の 2 点が蝶番の辺（前→後）。
 * `hideWhenClosed` は閉じたら隠す扉（主脚。外板と重なってちらつくため）
 */
export const DOORS = [
  {
    node: 'DoorNoseLeft',
    leg: 'nose',
    hideWhenClosed: false,
    corners: [
      [-0.18, -0.235, -6.18],
      [-0.18, -0.195, -5.0],
      [0, -0.195, -5.0],
      [0, -0.235, -6.18],
    ],
  },
  {
    node: 'DoorNoseRight',
    leg: 'nose',
    hideWhenClosed: false,
    corners: [
      [0.18, -0.235, -6.18],
      [0.18, -0.195, -5.0],
      [0, -0.195, -5.0],
      [0, -0.235, -6.18],
    ],
  },
  {
    node: 'DoorMainLeft',
    leg: 'left',
    hideWhenClosed: true,
    corners: [
      [-0.7, -0.597, -0.15],
      [-0.7, -0.597, 1.45],
      [-0.3, -0.597, 1.45],
      [-0.3, -0.597, -0.15],
    ],
  },
  {
    node: 'DoorMainRight',
    leg: 'right',
    hideWhenClosed: true,
    corners: [
      [0.7, -0.597, -0.15],
      [0.7, -0.597, 1.45],
      [0.3, -0.597, 1.45],
      [0.3, -0.597, -0.15],
    ],
  },
]

/**
 * 扉の付け根と軸。軸は蝶番の辺に沿い、**正の角で扉の自由な縁が下がる（開く）向き**に選ぶ。
 * 描画はこれを読んで `open × DOOR_OPEN_DEG` 回す
 */
export function doorHinges() {
  return DOORS.map((d) => {
    const [a, b, c] = d.corners
    const edge = [0, 1, 2].map((k) => b[k] - a[k])
    const len = Math.hypot(...edge)
    let axis = edge.map((x) => x / len)
    // 自由な縁の点を少し回して、下がるかどうか
    const v = [0, 1, 2].map((k) => c[k] - a[k])
    const t = 0.01
    const cross = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]]
    const dy = v[1] * Math.cos(t) + cross[1] * Math.sin(t) - v[1]
    if (dy > 0) axis = axis.map((x) => -x)
    return { node: d.node, leg: d.leg, hideWhenClosed: d.hideWhenClosed, origin: a, axis, corners: d.corners }
  })
}

/**
 * 下から真上へ光線を飛ばし、最初に当たる高さ（m、この作品の座標）を返す。当たらなければ null。
 * `exclude` に入る部品（脚など）は見ない。原本の座標は (x, y, z) → (−z, y, x) で回す
 * （`tools/f18e-to-glb.mjs` と同じ変換）
 */
export function lowestHit(gltfPath, points, exclude = new Set()) {
  const { parts } = readGltfParts(gltfPath, { vertices: true })
  const tris = []
  for (const p of parts) {
    if (exclude.has(p.parent ?? p.name)) continue
    const v = p.vertices.map(([x, y, z]) => [-z * SCALE, y * SCALE, x * SCALE])
    const idx = p.indices ?? v.map((_, i) => i)
    for (let i = 0; i + 2 < idx.length; i += 3) tris.push([v[idx[i]], v[idx[i + 1]], v[idx[i + 2]]])
  }
  return points.map(([x, z]) => {
    let best = null
    for (const [a, b, c] of tris) {
      // xz 平面で三角形の内側か（重心座標）
      const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
      if (Math.abs(d) < 1e-12) continue
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
      const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
      const l3 = 1 - l1 - l2
      if (l1 < 0 || l2 < 0 || l3 < 0) continue
      const y = l1 * a[1] + l2 * b[1] + l3 * c[1]
      if (best === null || y < best) best = y
    }
    return best
  })
}
