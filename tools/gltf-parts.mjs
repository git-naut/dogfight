// glTF の部品を世界座標で測る。
//
// **名前で拾えないモデルがある。**`assets/upstream/f18e/scene.gltf` は Sketchfab
// が FBX から変換したもので、ノード名が `Meshpart126_Material.001_0` のような
// 自動生成名になっている。舵面が `AileronLeft` で分かれている F/A-18C
// （FlightGear の AC3D）とは事情が違う。
//
// **幾何で同定する。**220 メッシュの位置と寸法を世界座標で出せば、主翼後縁の
// 外側にある左右対称の薄板がエルロン、という具合に当てられる。この模組が
// その測りを引き受ける。同定そのものは `tools/f18e-parts.mjs` が持つ。
//
// **ノードの変換を掛ける。**`accessors[].min/max` をそのまま足すと局所座標の
// まま重なる。実測で全体の bbox が X 103 / Y 44 / Z 17 と出て、機体の比
// （18.31 : 13.62）とまるで合わなかった。階層を辿って行列を合成する。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** ノードの変換を 4x4 の行優先で返す */
function nodeMatrix(node) {
  if (node.matrix !== undefined) {
    // glTF の `matrix` は列優先
    const m = node.matrix
    return [
      [m[0], m[4], m[8], m[12]],
      [m[1], m[5], m[9], m[13]],
      [m[2], m[6], m[10], m[14]],
      [m[3], m[7], m[11], m[15]],
    ]
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
  const s = [sx, sy, sz]
  const t = [tx, ty, tz]
  return [
    [r[0][0] * s[0], r[0][1] * s[1], r[0][2] * s[2], t[0]],
    [r[1][0] * s[0], r[1][1] * s[1], r[1][2] * s[2], t[1]],
    [r[2][0] * s[0], r[2][1] * s[1], r[2][2] * s[2], t[2]],
    [0, 0, 0, 1],
  ]
}

function multiply(a, b) {
  const out = []
  for (let i = 0; i < 4; i++) {
    out.push([])
    for (let j = 0; j < 4; j++) {
      let v = 0
      for (let k = 0; k < 4; k++) v += a[i][k] * b[k][j]
      out[i].push(v)
    }
  }
  return out
}

function transform(m, p) {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
  ]
}

/**
 * glTF を読んで、部品ごとの世界座標の bbox を返す。
 *
 * @param gltfPath `scene.gltf` のパス。`scene.bin` は隣にある前提
 * @returns `{ parts, size, min, max }`。`parts[i]` は
 *   `{ name, mesh, material, triangles, min, max, center, extent }`
 */
export function readGltfParts(gltfPath) {
  const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'))
  const base = dirname(gltfPath)
  const buffers = gltf.buffers.map((b) => {
    if (b.uri === undefined) throw new Error('埋め込みバッファは未対応')
    return readFileSync(join(base, decodeURIComponent(b.uri)))
  })

  const positions = (accessorIndex) => {
    const a = gltf.accessors[accessorIndex]
    const view = gltf.bufferViews[a.bufferView]
    const buf = buffers[view.buffer]
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
    // **`byteStride` を見る。**インターリーブされた頂点では 12 ではない
    const stride = view.byteStride ?? 12
    const out = []
    for (let i = 0; i < a.count; i++) {
      const o = offset + i * stride
      out.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)])
    }
    return out
  }

  const parts = []
  const walk = (nodeIndex, parent, parentName) => {
    const node = gltf.nodes[nodeIndex]
    const world = multiply(parent, nodeMatrix(node))
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh]
      for (const prim of mesh.primitives) {
        const pos = positions(prim.attributes['POSITION'])
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        for (const v of pos) {
          const w = transform(world, v)
          for (let k = 0; k < 3; k++) {
            if (w[k] < min[k]) min[k] = w[k]
            if (w[k] > max[k]) max[k] = w[k]
          }
        }
        parts.push({
          name: node.name ?? mesh.name ?? '?',
          // **回すのは親。**Sketchfab の変換はマテリアルごとにノードを分ける
          // ので、`Meshpart125` の下に `_Material.005_0` と `_Material.004_0`
          // が並ぶ。舵面として回すのは親の `Meshpart125` 1 つでよい
          parent: parentName,
          mesh: node.mesh,
          material: prim.material,
          triangles:
            prim.indices !== undefined ? Math.floor(gltf.accessors[prim.indices].count / 3) : 0,
          min,
          max,
          center: [0, 1, 2].map((k) => (min[k] + max[k]) / 2),
          extent: [0, 1, 2].map((k) => max[k] - min[k]),
        })
      }
    }
    for (const child of node.children ?? []) walk(child, world, node.name ?? parentName)
  }

  const identity = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ]
  for (const scene of gltf.scenes) for (const n of scene.nodes) walk(n, identity, null)

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let k = 0; k < 3; k++) {
      if (p.min[k] < min[k]) min[k] = p.min[k]
      if (p.max[k] > max[k]) max[k] = p.max[k]
    }
  }
  return { parts, min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) }
}

/**
 * 左右対称のペアを探す。
 *
 * 舵面はほぼすべて左右にある。片方だけ見つかったら同定を疑う手がかりになる。
 *
 * @param axis 左右の軸。このモデルは Z（`f18e-parts.mjs` の実測）
 */
export function findMirrorPairs(parts, axis = 2, tolerance = 0.4) {
  const used = new Set()
  const pairs = []
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue
    const a = parts[i]
    // 中心にあるものは対称の相手を持たない
    if (Math.abs(a.center[axis]) < 0.3) continue
    for (let j = i + 1; j < parts.length; j++) {
      if (used.has(j)) continue
      const b = parts[j]
      const mirrored = Math.abs(a.center[axis] + b.center[axis]) < tolerance
      const sameElse = [0, 1, 2]
        .filter((k) => k !== axis)
        .every((k) => Math.abs(a.center[k] - b.center[k]) < tolerance)
      // 三角形数が近いこと。左右で作りが違うモデルもあるので 2% 見る
      const sameSize = Math.abs(a.triangles - b.triangles) <= Math.max(2, a.triangles * 0.02)
      if (mirrored && sameElse && sameSize) {
        pairs.push([i, j])
        used.add(i)
        used.add(j)
        break
      }
    }
  }
  return pairs
}
