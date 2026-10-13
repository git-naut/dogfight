// 水平尾翼の付け根を胴体の中まで伸ばす（2026-10-13）。
//
// **原本の水平尾翼は、付け根と胴体の間が空いている。**舵角 0 度でも、付け根の前後 4.7 m で
// 0 cm、後ろへ行くほど開いて 6.7 m で 13〜14 cm のくさび形。胴体は後ろへ行くほど細くなるのに、
// 付け根の線はほぼまっすぐなため。振るとさらに開く（8 度で最大 19〜23 cm）。ユーザーの指摘
// 「付け根と胴体の間があるので、埋めてください」で、付け根を胴体まで伸ばすことにした（ユーザーの
// 判断。尾翼と一緒に回るので、振っても横のすき間は開かない）。
//
// 付け根の線を前後 0.1 m ごとに拾い、そこから胴体の中心へ水平に光線を飛ばして胴体の面までの
// 距離を測る。見た目の振れの上限（`MAX_DEG.stabilator`）までの各角度で測った最大に `ROOT_MARGIN`
// を足した幅だけ、付け根の頂点を中心線へ寄せる。もう接している区間（`ROOT_TOUCH` 未満）と、
// 光線がどの角度でも胴体に当たらない区間は動かさない。
//
// 座標は原本（機首 −X、上 +Y、Z が翼幅）× SCALE の m。`tools/f18e-hinges.mjs` と同じ。
import { readGltfParts } from './gltf-parts.mjs'
import { identifyParts, SCALE } from './f18e-parts.mjs'
import { buildHinges } from './f18e-hinges.mjs'

/** 胴体の面より内側へ入れる余裕 m */
export const ROOT_MARGIN = 0.05

/**
 * これより狭いすき間は、もう胴体に接しているとみなして動かさない m。付け根の前端
 * （前後 4.0〜4.45 m）は 0〜1 cm で接していて、5 cm 寄せると胴体の面を突き抜けた
 */
export const ROOT_TOUCH = 0.02

/** 付け根とみなす帯の幅 m。付け根の線からこの内側の頂点を動かす */
export const ROOT_BAND = 0.03

/** 付け根の線を拾う前後の刻み m */
const BIN = 0.1

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** 点 `pt` を、`from` を通る軸 `axis` まわりに `ang` rad 回す（ロドリゲス） */
function rotate(pt, from, axis, ang) {
  const n = Math.hypot(...axis)
  const k = axis.map((x) => x / n)
  const v = sub(pt, from)
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const kv = cross(k, v)
  const kd = dot(k, v)
  return [0, 1, 2].map((i) => from[i] + v[i] * c + kv[i] * s + k[i] * kd * (1 - c))
}

/** 原本を読み、尾翼の頂点（左右）と、尾翼以外の三角形を返す */
function load(gltfPath) {
  const id = identifyParts(gltfPath)
  const stabs = id.matched.filter((m) => m.role === 'stabilator')
  const sideOf = (p) => {
    const m = stabs.find((s) => s.node === p.parent || s.name === p.name || s.primitives.some((x) => x.name === p.name))
    return m === undefined ? null : m.side
  }
  const { parts } = readGltfParts(gltfPath, { vertices: true })
  const tris = []
  const stab = { left: [], right: [] }
  const stabParts = []
  for (const p of parts) {
    const side = sideOf(p)
    const v = p.vertices.map((q) => q.map((c) => c * SCALE))
    if (side !== null) {
      stab[side].push(...v)
      stabParts.push({ part: p, side })
      continue
    }
    const idx = p.indices ?? v.map((_, i) => i)
    for (let i = 0; i + 2 < idx.length; i += 3) tris.push([v[idx[i]], v[idx[i + 1]], v[idx[i + 2]]])
  }
  const hinges = buildHinges(gltfPath).filter((h) => h.role === 'stabilator')
  return { tris, stab, stabParts, hinges }
}

/** 光線 `o + t d`（0 < t < maxT）が最初に当たる三角形までの t。当たらなければ Infinity */
function ray(tris, o, d, maxT) {
  let best = Infinity
  for (const [a, b, c] of tris) {
    const e1 = sub(b, a)
    const e2 = sub(c, a)
    const p = cross(d, e2)
    const det = dot(e1, p)
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const s = sub(o, a)
    const u = dot(s, p) * inv
    if (u < 0 || u > 1) continue
    const q = cross(s, e1)
    const w = dot(d, q) * inv
    if (w < 0 || u + w > 1) continue
    const t = dot(e2, q) * inv
    if (t > 1e-4 && t < best && t < maxT) best = t
  }
  return best
}

/** 付け根の線。前後 `BIN` ごとに、いちばん胴体寄りの頂点を上面・下面で 1 つずつ */
function rootLine(vertices) {
  const bins = new Map()
  for (const v of vertices) {
    const k = Math.round(v[0] / BIN)
    for (const tag of ['top', 'bot']) {
      const key = `${k}${tag}`
      const cur = bins.get(key)
      const closer = cur === undefined || Math.abs(v[2]) < Math.abs(cur[2]) - 0.01
      const same = cur !== undefined && Math.abs(Math.abs(v[2]) - Math.abs(cur[2])) <= 0.01
      if (closer || (same && (tag === 'top' ? v[1] > cur[1] : v[1] < cur[1]))) bins.set(key, v)
    }
  }
  // 翼端側の後縁（付け根の後端より後ろの刻みには付け根の頂点が無い）を外す
  const zmin = Math.min(...vertices.map((v) => Math.abs(v[2])))
  return [...bins.values()].filter((v) => Math.abs(v[2]) < zmin + 0.5).sort((a, b) => a[0] - b[0])
}

/**
 * 付け根の線と、そこを胴体まで伸ばす幅を測る。
 *
 * returns 左右それぞれ、付け根の点（前後 x・横 |z|・上下 y）と、伸ばす幅 `shift` m
 */
export function measureStabRoot(gltfPath, maxDeg) {
  const { tris, stab, hinges } = load(gltfPath)
  const out = {}
  for (const side of ['left', 'right']) {
    const h = hinges.find((x) => x.side === side)
    const line = rootLine(stab[side])
    const angles = []
    for (let a = -maxDeg; a <= maxDeg + 1e-9; a += 2) angles.push(a)
    const points = line.map((v) => {
      const inward = [0, 0, -Math.sign(v[2])]
      let worst = null
      for (const deg of angles) {
        const p = rotate(v, h.from, sub(h.to, h.from), (deg * Math.PI) / 180)
        const t = ray(tris, p, inward, 2)
        if (t !== Infinity) worst = worst === null ? t : Math.max(worst, t)
      }
      return {
        x: v[0],
        y: v[1],
        z: Math.abs(v[2]),
        gap: worst,
        shift: worst === null || worst < ROOT_TOUCH ? 0 : worst + ROOT_MARGIN,
      }
    })
    out[side] = { points, hinge: h }
  }
  return out
}

/** 付け根の点の列から、前後 `x` での値を線形に補う */
function interp(points, x, key) {
  if (x <= points[0].x) return points[0][key]
  if (x >= points[points.length - 1].x) return points[points.length - 1][key]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)
      return a[key] + (b[key] - a[key]) * t
    }
  }
  return points[points.length - 1][key]
}

/** 前後 `x` ごとに、上下の 2 点のうち胴体寄りの横位置と、大きいほうの伸ばす幅をまとめる */
function profile(points) {
  const byX = new Map()
  for (const p of points) {
    const k = Math.round(p.x / BIN)
    const cur = byX.get(k)
    if (cur === undefined) byX.set(k, { x: p.x, z: p.z, shift: p.shift })
    else byX.set(k, { x: (cur.x + p.x) / 2, z: Math.min(cur.z, p.z), shift: Math.max(cur.shift, p.shift) })
  }
  return [...byX.values()].sort((a, b) => a.x - b.x)
}

/** 行優先 4x4 の左上 3x3 の逆行列 */
function inverse3(m) {
  const [a, b, c] = [m[0][0], m[0][1], m[0][2]]
  const [d, e, f] = [m[1][0], m[1][1], m[1][2]]
  const [g, h, i] = [m[2][0], m[2][1], m[2][2]]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-15) throw new Error('世界行列が退化している')
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}

/**
 * 原本の glTF のバイナリの中で、水平尾翼の付け根の頂点を中心線へ寄せる。
 *
 * `gltf` は原本の JSON（accessor と bufferView を読む）、`binary` は原本のバイナリ。
 * **その場で書き換える。**POSITION の accessor の min・max も直す。
 * returns 動かした頂点の数と、左右の伸ばした幅の最大 m
 */
export function extendStabRoot(gltfPath, gltf, binary, maxDeg) {
  const measured = measureStabRoot(gltfPath, maxDeg)
  const { stabParts } = load(gltfPath)
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  const done = new Set()
  let moved = 0
  for (const { part, side } of stabParts) {
    const accessorIndex = part.positionAccessor
    // **同じ accessor を 2 度動かさない。**プリミティブが共有していると 2 倍寄る
    if (done.has(accessorIndex)) continue
    done.add(accessorIndex)
    const prof = profile(measured[side].points)
    const inv = inverse3(part.world)
    const a = gltf.accessors[accessorIndex]
    const bv = gltf.bufferViews[a.bufferView]
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const stride = bv.byteStride ?? 12
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < a.count; i++) {
      const o = base + i * stride
      const local = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]
      const w = part.vertices[i].map((c) => c * SCALE)
      const rootZ = interp(prof, w[0], 'z')
      const shift = interp(prof, w[0], 'shift')
      if (Math.abs(w[2]) <= rootZ + ROOT_BAND && shift > 0) {
        // 世界（m）で中心線へ `shift`。原本の単位へ戻し、局所の座標へ移す
        const dw = [0, 0, (-Math.sign(w[2]) * shift) / SCALE]
        for (let r = 0; r < 3; r++) local[r] += inv[r][0] * dw[0] + inv[r][1] * dw[1] + inv[r][2] * dw[2]
        view.setFloat32(o, local[0], true)
        view.setFloat32(o + 4, local[1], true)
        view.setFloat32(o + 8, local[2], true)
        moved++
      }
      for (let k = 0; k < 3; k++) {
        if (local[k] < min[k]) min[k] = local[k]
        if (local[k] > max[k]) max[k] = local[k]
      }
    }
    a.min = min
    a.max = max
  }
  const maxShift = (side) => Math.max(...measured[side].points.map((p) => p.shift))
  return { moved, left: maxShift('left'), right: maxShift('right'), measured }
}

/**
 * 伸ばした付け根が、見た目の振れの上限まで胴体の中に入っているか（検査用）。
 *
 * 伸ばした付け根の点を各角度へ回し、そこから外へ（元の付け根の点へ向けて）光線を飛ばす。
 * 元の付け根に着く前に胴体の面に当たれば、伸ばした点は胴体の中にある。
 * returns 角度ごとに、胴体の中に入っている点と入っていない点の数
 */
export function rootInsideFuselage(gltfPath, maxDeg) {
  const measured = measureStabRoot(gltfPath, maxDeg)
  const { tris } = load(gltfPath)
  const out = {}
  for (const side of ['left', 'right']) {
    const { points, hinge: h } = measured[side]
    out[side] = {}
    for (const deg of [-maxDeg, 0, maxDeg]) {
      let inside = 0
      let outside = 0
      for (const p of points) {
        if (p.shift === 0) continue
        // 原本の座標の z の符号は左右で逆。測った |z| から元の点と伸ばした点を作る
        const zSign = Math.sign(h.to[2])
        const orig = [p.x, p.y, zSign * p.z]
        const ext = [p.x, p.y, zSign * (p.z - p.shift)]
        const ang = (deg * Math.PI) / 180
        const o = rotate(ext, h.from, sub(h.to, h.from), ang)
        const target = rotate(orig, h.from, sub(h.to, h.from), ang)
        const d = sub(target, o)
        const len = Math.hypot(...d)
        const t = ray(tris, o, d.map((x) => x / len), len)
        if (t !== Infinity) inside++
        else {
          outside++
          if (process.env['ROOT_DEBUG']) console.log(side, deg, p.x.toFixed(2), p.y.toFixed(3), 'shift', p.shift.toFixed(3), 'gap', p.gap)
        }
      }
      out[side][deg] = { inside, outside }
    }
  }
  return out
}
