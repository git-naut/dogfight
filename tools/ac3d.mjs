/**
 * AC3D（.ac）のパーサ。
 *
 * FlightGear の機体はこの形式で配布されている。素のテキストで、行ごとに
 * キーワードと値が並ぶだけなので依存パッケージは要らない。
 *
 * 仕様のうちこのファイルが使う部分だけ実装した。原本（assets/upstream/f18）に
 * 出てこない `rot` `crease` `texrep` `url` `data` は扱わない。出てきたら
 * 例外を投げる。黙って無視すると形が崩れたまま気づけない。
 *
 * 座標系は 機首 −X、上 +Y、左 +Z。当プロジェクトは 機首 −Z、上 +Y、右 +X。
 * 変換は `toWorld` が行う。
 */

/** SURF のフラグ。下位 4 bit が種類、0x10 が滑らかな陰影、0x20 が両面 */
export const SURF_SMOOTH = 0x10
export const SURF_TWO_SIDED = 0x20

/**
 * テキストを木に読む。
 *
 * 返す座標は .ac のまま。`loc` も親からの相対のまま持つ。世界座標へ移すのは
 * `flatten` の仕事。パースと座標変換を混ぜると、どちらの誤りか切り分け
 * られなくなる。
 */
export function parseAc3d(text) {
  const lines = text.split('\n')
  if (!lines[0].startsWith('AC3D')) {
    throw new Error(`AC3D のヘッダがない: ${lines[0].slice(0, 20)}`)
  }

  const materials = []
  let index = 1
  let root = null

  while (index < lines.length) {
    const line = lines[index].trim()
    if (line.startsWith('MATERIAL ')) {
      materials.push(parseMaterial(line))
      index++
    } else if (line.startsWith('OBJECT ')) {
      const result = parseObject(lines, index)
      root = result.node
      index = result.next
      break
    } else {
      index++
    }
  }

  if (root === null) throw new Error('OBJECT が 1 つも無い')
  return { materials, root }
}

function parseMaterial(line) {
  const name = /^MATERIAL "([^"]*)"/.exec(line)?.[1] ?? ''
  const pick = (key, count) => {
    const re = new RegExp(`\\b${key}\\s+((?:[-0-9.eE+]+\\s*){${count}})`)
    const m = re.exec(line)
    if (m === null) throw new Error(`MATERIAL に ${key} が無い: ${line}`)
    return m[1].trim().split(/\s+/).map(Number)
  }
  return {
    name,
    rgb: pick('rgb', 3),
    amb: pick('amb', 3),
    emis: pick('emis', 3),
    spec: pick('spec', 3),
    shi: pick('shi', 1)[0],
    trans: pick('trans', 1)[0],
  }
}

const KNOWN_KEYS = new Set([
  'OBJECT',
  'name',
  'texture',
  'loc',
  'numvert',
  'numsurf',
  'kids',
])

/** OBJECT ブロック 1 つ。`kids` の数だけ子を読む */
function parseObject(lines, start) {
  let index = start
  const header = lines[index].trim().split(/\s+/)
  const node = {
    type: header[1] ?? 'poly',
    name: '',
    texture: null,
    loc: [0, 0, 0],
    vertices: [],
    surfaces: [],
    kids: [],
  }
  index++

  let kids = 0

  while (index < lines.length) {
    const line = lines[index].trim()
    if (line === '') {
      index++
      continue
    }
    const key = line.split(/\s+/)[0]

    if (key === 'name') {
      node.name = /"([^"]*)"/.exec(line)?.[1] ?? ''
      index++
    } else if (key === 'texture') {
      node.texture = /"([^"]*)"/.exec(line)?.[1] ?? null
      index++
    } else if (key === 'loc') {
      node.loc = line.split(/\s+/).slice(1, 4).map(Number)
      index++
    } else if (key === 'numvert') {
      const count = Number(line.split(/\s+/)[1])
      index++
      for (let i = 0; i < count; i++) {
        node.vertices.push(lines[index + i].trim().split(/\s+/).map(Number))
      }
      index += count
    } else if (key === 'numsurf') {
      const count = Number(line.split(/\s+/)[1])
      index++
      for (let i = 0; i < count; i++) {
        const surf = parseSurface(lines, index)
        node.surfaces.push(surf.surface)
        index = surf.next
      }
    } else if (key === 'kids') {
      kids = Number(line.split(/\s+/)[1])
      index++
      break
    } else if (KNOWN_KEYS.has(key)) {
      index++
    } else {
      throw new Error(`未対応のキーワード "${key}"（${index + 1} 行目）`)
    }
  }

  for (let i = 0; i < kids; i++) {
    const child = parseObject(lines, index)
    node.kids.push(child.node)
    index = child.next
  }

  return { node, next: index }
}

function parseSurface(lines, start) {
  let index = start
  const surface = { flags: 0, mat: 0, refs: [] }

  while (index < lines.length) {
    const line = lines[index].trim()
    const parts = line.split(/\s+/)
    if (parts[0] === 'SURF') {
      surface.flags = Number.parseInt(parts[1], 16)
      index++
    } else if (parts[0] === 'mat') {
      surface.mat = Number(parts[1])
      index++
    } else if (parts[0] === 'refs') {
      const count = Number(parts[1])
      index++
      for (let i = 0; i < count; i++) {
        const ref = lines[index + i].trim().split(/\s+/)
        surface.refs.push([Number(ref[0]), Number(ref[1]), Number(ref[2])])
      }
      index += count
      break
    } else {
      throw new Error(`SURF の中に未対応の行 "${line}"（${index + 1} 行目）`)
    }
  }

  return { surface, next: index }
}

/** .ac の座標を当プロジェクトの座標へ。機首 −X → −Z、左 +Z → 右 −X */
export function toWorld(v) {
  return [-v[2], v[1], v[0]]
}

/**
 * 木を平らにして、頂点を世界座標へ移す。
 *
 * `loc` は親からの相対なので積み上げる。積まないと部品が原点付近に集まる。
 * 座標変換は最後に 1 回だけ掛ける。頂点ごとに掛けると、`loc` を足す順番と
 * 混ざって間違いに気づきにくい。
 */
export function flatten(root) {
  const out = []

  const walk = (node, offset) => {
    const origin = [
      offset[0] + node.loc[0],
      offset[1] + node.loc[1],
      offset[2] + node.loc[2],
    ]

    if (node.surfaces.length > 0) {
      out.push({
        name: node.name,
        texture: node.texture,
        // .ac のままの世界座標。変換はここではしない
        vertices: node.vertices.map((v) => [
          v[0] + origin[0],
          v[1] + origin[1],
          v[2] + origin[2],
        ]),
        surfaces: node.surfaces,
      })
    }

    for (const kid of node.kids) walk(kid, origin)
  }

  walk(root, [0, 0, 0])
  return out
}

/** 木の統計。パーサの検算に使う */
export function stats(root) {
  let objects = 0
  let vertices = 0
  let triangles = 0
  let surfaces = 0
  const textures = new Set()

  const walk = (node) => {
    objects++
    vertices += node.vertices.length
    surfaces += node.surfaces.length
    for (const s of node.surfaces) triangles += Math.max(0, s.refs.length - 2)
    if (node.texture !== null) textures.add(node.texture)
    for (const kid of node.kids) walk(kid)
  }

  walk(root)
  return { objects, vertices, triangles, surfaces, textures: [...textures].sort() }
}

/** 世界座標の境界。`flatten` の結果を渡す */
export function bounds(parts) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const part of parts) {
    for (const v of part.vertices) {
      for (let a = 0; a < 3; a++) {
        if (v[a] < min[a]) min[a] = v[a]
        if (v[a] > max[a]) max[a] = v[a]
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}
