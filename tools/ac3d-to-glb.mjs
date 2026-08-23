/**
 * AC3D（.ac）から glb を作る。
 *
 * FlightGear の機体を当プロジェクトの座標系へ移し、three の GLTFLoader で
 * 読める形にする。自前のローダは書かない。
 *
 * 舵面は別ノードに切り出し、ヒンジの位置へノードの原点を移す。そうしないと
 * 描画側でヒンジまわりの回転を表せない。ヒンジの数値は FlightGear の
 * アニメーション XML に入っているものをそのまま使う。
 *
 * **機体ごとに違うところは `aircraft-assets.mjs` が持つ。**このファイルは
 * 手順だけを持ち、どの機体でも同じ処理を通す。
 *
 * 実行は `node tools/ac3d-to-glb.mjs [id ...]`。id を省略すると定義にある
 * 全機体を変換する。`npm run assets` から呼ばれる。
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseAc3d,
  flatten,
  stats,
  bounds,
  toWorld,
  SURF_SMOOTH,
  SURF_TWO_SIDED,
} from './ac3d.mjs'
import { AIRCRAFT_ASSETS, DEFAULT_GEAR_PATTERN, assetById } from './aircraft-assets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
/**
 * glb とテクスチャの出力先。
 *
 * glb が同じディレクトリの相対名でテクスチャを参照するので、複製先を
 * そろえる必要がある。
 */
const OUT_DIR = join(ROOT, 'public/aircraft')

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2])
  return l === 0 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * 部品を役割ごとに分ける。
 *
 * 舵面は 1 つずつ独立したノードにする。降着装置と操縦席はまとめて 1 ノード。
 * 残りは本体。
 */
function classify(parts, asset) {
  const hingeNames = new Set(asset.hinges.map((h) => h.node))
  const extra = asset.extraNodes ?? []
  const gearPattern = asset.gearPattern ?? DEFAULT_GEAR_PATTERN
  const groups = new Map()
  const put = (key, part) => {
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [part])
    else list.push(part)
  }

  for (const part of parts) {
    if (hingeNames.has(part.name)) put(part.name, part)
    else if (extra.includes(part.name)) put(part.name, part)
    else if (gearPattern.test(part.name)) put('gear', part)
    else if (part.texture === asset.cockpitTexture) put('cockpit', part)
    else put('body', part)
  }
  return groups
}

/**
 * 三角形を積む。
 *
 * SURF のビット 0x10 が滑らかな陰影。立っているなら部品内で法線を平均し、
 * 立っていないなら面ごとの法線を使う。混ぜて 1 つのプリミティブに入れると
 * どちらか一方の陰影が崩れるので、両面フラグと合わせてプリミティブを分ける。
 */
function buildPrimitives(parts, origin) {
  /** key = `${texture}|${mat}|${twoSided}` */
  const buckets = new Map()

  for (const part of parts) {
    const worldVerts = part.vertices.map(toWorld)
    const originWorld = origin

    // 滑らかな面の法線を頂点へ足し込む
    const smooth = worldVerts.map(() => [0, 0, 0])
    for (const surf of part.surfaces) {
      if ((surf.flags & SURF_SMOOTH) === 0) continue
      const n = faceNormal(worldVerts, surf.refs)
      for (const ref of surf.refs) {
        smooth[ref[0]][0] += n[0]
        smooth[ref[0]][1] += n[1]
        smooth[ref[0]][2] += n[2]
      }
    }
    for (let i = 0; i < smooth.length; i++) smooth[i] = normalize(smooth[i])

    for (const surf of part.surfaces) {
      if (surf.refs.length < 3) continue
      const twoSided = (surf.flags & SURF_TWO_SIDED) !== 0
      const key = `${part.texture ?? ''}|${surf.mat}|${twoSided ? 1 : 0}`
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = {
          texture: part.texture,
          mat: surf.mat,
          twoSided,
          position: [],
          normal: [],
          uv: [],
          index: [],
          weld: new Map(),
        }
        buckets.set(key, bucket)
      }

      const flatNormal = faceNormal(worldVerts, surf.refs)
      const useSmooth = (surf.flags & SURF_SMOOTH) !== 0

      // 多角形は扇状に割る。凸でない面があると崩れるが、原本には出てこない
      for (let i = 1; i + 1 < surf.refs.length; i++) {
        for (const ref of [surf.refs[0], surf.refs[i], surf.refs[i + 1]]) {
          const v = worldVerts[ref[0]]
          const n = useSmooth ? smooth[ref[0]] : flatNormal
          pushVertex(
            bucket,
            [v[0] - originWorld[0], v[1] - originWorld[1], v[2] - originWorld[2]],
            n,
            // AC3D の V は下が 0。glTF は上が 0 なので反転する
            [ref[1], 1 - ref[2]],
          )
        }
      }
    }
  }

  for (const bucket of buckets.values()) delete bucket.weld
  return [...buckets.values()]
}

function faceNormal(verts, refs) {
  const a = verts[refs[0][0]]
  const b = verts[refs[1][0]]
  const c = verts[refs[2][0]]
  const u = subtract(b, a)
  const v = subtract(c, a)
  return normalize([
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ])
}

/** 同じ位置・法線・UV の頂点は 1 つにまとめる */
function pushVertex(bucket, p, n, uv) {
  const key = `${q(p[0])},${q(p[1])},${q(p[2])},${q(n[0])},${q(n[1])},${q(n[2])},${q(uv[0])},${q(uv[1])}`
  let index = bucket.weld.get(key)
  if (index === undefined) {
    index = bucket.position.length / 3
    bucket.position.push(p[0], p[1], p[2])
    bucket.normal.push(n[0], n[1], n[2])
    bucket.uv.push(uv[0], uv[1])
    bucket.weld.set(key, index)
  }
  bucket.index.push(index)
}

function q(x) {
  return Math.round(x * 10000)
}

/**
 * AC3D のマテリアルから PBR の値を決める。
 *
 * **金属度を `spec` から決めてはいけない。**Gouraud の `spec` は誘電体でも
 * 1 になる「ハイライトの色」で、金属かどうかとは無関係。機械的に写したら
 * パイロントミサイルが金属度 1・粗さ 0.12 になり、環境反射を入れた瞬間に
 * 鏡になった。実測で画素が (3,3,3) から (127,151,181) へ跳ね、空をそのまま
 * 映していた。
 *
 * 既定は誘電体（金属度 0）。航空機で本当に金属なのは露出した排気口の内側
 * くらいなので、そこだけ名前で拾う。粗さは 0.25 を下限にして、どこも鏡に
 * ならないようにする。
 */
function materialFor(bucket, materials) {
  const src = materials[bucket.mat] ?? materials[0]
  const name = src.name
  const shine = Math.min(1, Math.max(0, src.shi / 128))

  let metallic = 0
  let roughness = Math.min(0.95, Math.max(0.25, 1 - Math.sqrt(shine)))
  if (/Glass|HUD/i.test(name)) {
    roughness = 0.05
  } else if (/Reactor/i.test(name)) {
    // 排気口の内側。ここは地金が出ている
    metallic = 0.85
    roughness = 0.35
  } else if (/Rubber|LCD|newmtl_0|Black/i.test(name)) {
    roughness = 0.8
  } else if (bucket.texture !== null) {
    // 機体外板。塗装なので誘電体。塗膜の粗さは 0.45 前後が実機の写真に近い
    metallic = 0.05
    roughness = 0.45
  }

  // 自発光。アフターバーナーの炎と灯火がこれを使っている。落とすと炎が
  // 黒い板になる（実測。ExternalFlame は rgb 0,0,0 で emis だけを持つ）
  const emissive = (src.emis[0] + src.emis[1] + src.emis[2]) / 3
  if (emissive > 0.05) metallic = 0

  const alpha = 1 - src.trans
  const material = {
    name: `${name}${bucket.texture ? `_${bucket.texture}` : ''}`,
    pbrMetallicRoughness: {
      baseColorFactor: bucket.texture
        ? [1, 1, 1, alpha]
        : [src.rgb[0], src.rgb[1], src.rgb[2], alpha],
      metallicFactor: metallic,
      roughnessFactor: roughness,
    },
    doubleSided: bucket.twoSided,
  }
  if (emissive > 0.05) {
    material.emissiveFactor = [src.emis[0], src.emis[1], src.emis[2]]
  }
  if (src.trans > 0) {
    material.alphaMode = 'BLEND'
  }
  return material
}

/**
 * 機体 1 機を変換して glb を書く。
 *
 * @param asset `aircraft-assets.mjs` の定義
 */
function convert(asset) {
  const source = join(ROOT, asset.source)
  const text = readFileSync(source, 'utf8')
  const { materials, root } = parseAc3d(text)
  const parts = flatten(root)
  const st = stats(root)
  const b = bounds(parts)

  const groups = classify(parts, asset)

  // glTF の組み立て
  const gltf = {
    asset: {
      version: '2.0',
      generator: 'dogfight tools/ac3d-to-glb.mjs',
      copyright: asset.copyright,
    },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  }
  const images = new Map()
  const chunks = []
  let offset = 0

  const addBufferView = (typedArray, target) => {
    const bytes = new Uint8Array(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    )
    const padding = (4 - (offset % 4)) % 4
    if (padding > 0) {
      chunks.push(new Uint8Array(padding))
      offset += padding
    }
    const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength }
    if (target !== undefined) view.target = target
    gltf.bufferViews.push(view)
    chunks.push(bytes)
    offset += bytes.byteLength
    return gltf.bufferViews.length - 1
  }

  const addAccessor = (typedArray, componentType, type, count, minMax) => {
    const isIndex = componentType === 5125 || componentType === 5123
    const view = addBufferView(typedArray, isIndex ? 34963 : 34962)
    const accessor = { bufferView: view, componentType, count, type }
    if (minMax !== undefined) {
      accessor.min = minMax.min
      accessor.max = minMax.max
    }
    gltf.accessors.push(accessor)
    return gltf.accessors.length - 1
  }

  const materialIndexFor = (bucket) => {
    const material = materialFor(bucket, materials)
    if (bucket.texture !== null) {
      const file = asset.textures[bucket.texture]
      if (file === undefined) throw new Error(`未知のテクスチャ ${bucket.texture}`)
      let imageIndex = images.get(file)
      if (imageIndex === undefined) {
        imageIndex = images.size
        images.set(file, imageIndex)
      }
      material.pbrMetallicRoughness.baseColorTexture = { index: imageIndex }
      // 自発光もテクスチャで模様が付く。炎はテクスチャの一部を使っている
      if (material.emissiveFactor !== undefined) {
        material.emissiveTexture = { index: imageIndex }
      }
    }
    // 同じ内容のマテリアルは 1 つにまとめる
    const serialized = JSON.stringify(material)
    const existing = gltf.materials.findIndex((m) => JSON.stringify(m) === serialized)
    if (existing >= 0) return existing
    gltf.materials.push(material)
    return gltf.materials.length - 1
  }

  const addMeshNode = (name, groupParts, origin) => {
    const primitives = buildPrimitives(groupParts, origin)
    if (primitives.length === 0) return null

    const meshPrimitives = primitives.map((bucket) => {
      const position = new Float32Array(bucket.position)
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < position.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (position[i + a] < min[a]) min[a] = position[i + a]
          if (position[i + a] > max[a]) max[a] = position[i + a]
        }
      }
      const count = position.length / 3
      const posAccessor = addAccessor(position, 5126, 'VEC3', count, { min, max })
      const nrmAccessor = addAccessor(
        new Float32Array(bucket.normal),
        5126,
        'VEC3',
        count,
      )
      const uvAccessor = addAccessor(new Float32Array(bucket.uv), 5126, 'VEC2', count)
      // 頂点が 65,536 未満なら 16bit で足りる。実測で 4 割小さくなる
      const small = count < 65536
      const indexAccessor = addAccessor(
        small ? new Uint16Array(bucket.index) : new Uint32Array(bucket.index),
        small ? 5123 : 5125,
        'SCALAR',
        bucket.index.length,
      )
      return {
        attributes: {
          POSITION: posAccessor,
          NORMAL: nrmAccessor,
          TEXCOORD_0: uvAccessor,
        },
        indices: indexAccessor,
        material: materialIndexFor(bucket),
      }
    })

    gltf.meshes.push({ name, primitives: meshPrimitives })
    const node = { name, mesh: gltf.meshes.length - 1 }
    if (origin[0] !== 0 || origin[1] !== 0 || origin[2] !== 0) {
      node.translation = [origin[0], origin[1], origin[2]]
    }
    gltf.nodes.push(node)
    return gltf.nodes.length - 1
  }

  const rootChildren = []
  const hingeInfo = []

  for (const [key, groupParts] of groups) {
    const hinge = asset.hinges.find((h) => h.node === key)
    if (hinge === undefined) {
      const index = addMeshNode(key, groupParts, [0, 0, 0])
      if (index !== null) rootChildren.push(index)
      continue
    }

    // ヒンジの位置へノードの原点を移す。頂点はそのぶん引く
    const from = asset.xmlToWorld(hinge.from)
    const axis = normalize(subtract(asset.xmlToWorld(hinge.to), from))
    const index = addMeshNode(key, groupParts, from)
    if (index !== null) rootChildren.push(index)
    hingeInfo.push({ node: key, origin: from, axis, maxDeg: hinge.maxDeg })
  }

  gltf.nodes.push({ name: asset.id, children: rootChildren })
  gltf.scenes[0].nodes = [gltf.nodes.length - 1]

  if (images.size > 0) {
    gltf.images = [...images.keys()].map((uri) => ({ uri }))
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
    gltf.textures = gltf.images.map((_, i) => ({ source: i, sampler: 0 }))
  }

  // ヒンジは描画側が要るので glTF の extras に載せる。別ファイルにすると
  // モデルと定義がずれる
  gltf.scenes[0].extras = { hinges: hingeInfo }

  gltf.buffers.push({ byteLength: offset })

  const binary = concat(chunks, offset)
  const glb = packGlb(gltf, binary)

  mkdirSync(OUT_DIR, { recursive: true })
  const outGlb = join(OUT_DIR, `${asset.id}.glb`)
  writeFileSync(outGlb, glb)

  const textureDir = join(ROOT, asset.textureDir)
  for (const file of Object.values(asset.textures)) {
    const from = join(textureDir, file)
    if (!existsSync(from)) {
      throw new Error(`${file} が無い。${asset.textureHint}`)
    }
    copyFileSync(from, join(OUT_DIR, file))
  }

  const triangles = gltf.meshes.reduce(
    (sum, mesh) =>
      sum +
      mesh.primitives.reduce(
        (s, p) => s + gltf.accessors[p.indices].count / 3,
        0,
      ),
    0,
  )

  console.log(`${asset.id}.glb を書いた: ${(glb.byteLength / 1024).toFixed(0)} KB`)
  console.log(
    `  原本 ${st.objects} オブジェクト / ${st.triangles} 三角形 / ${st.vertices} 頂点`,
  )
  console.log(`  出力 ${gltf.meshes.length} メッシュ / ${triangles} 三角形`)
  console.log(
    `  境界（.ac 座標） X ${b.size[0].toFixed(3)} / Y ${b.size[1].toFixed(3)} / Z ${b.size[2].toFixed(3)}`,
  )
  console.log(`  ノード: ${gltf.nodes.map((n) => n.name).join(', ')}`)
}

/**
 * 引数の id を変換する。省略すれば定義にある全機体。
 *
 * **id を並べられるようにしてあるのは、片方だけを作り直したいときのため。**
 * F-16 を足す作業で F/A-18C を毎回作り直すと、出力が変わっていないことの
 * 確認に時間がかかる。
 */
function main() {
  const ids = process.argv.slice(2)
  const assets = ids.length > 0 ? ids.map(assetById) : AIRCRAFT_ASSETS
  for (const asset of assets) convert(asset)
}

function concat(chunks, total) {
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

function packGlb(gltf, binary) {
  const json = new TextEncoder().encode(JSON.stringify(gltf))
  const jsonPadding = (4 - (json.byteLength % 4)) % 4
  const binPadding = (4 - (binary.byteLength % 4)) % 4

  const jsonLength = json.byteLength + jsonPadding
  const binLength = binary.byteLength + binPadding
  const total = 12 + 8 + jsonLength + 8 + binLength

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // "glTF"
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)

  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // "JSON"
  out.set(json, 20)
  // JSON の余りは空白で埋める。仕様の指定
  for (let i = 0; i < jsonPadding; i++) out[20 + json.byteLength + i] = 0x20

  const binHeader = 20 + jsonLength
  view.setUint32(binHeader, binLength, true)
  view.setUint32(binHeader + 4, 0x004e4942, true) // "BIN"
  out.set(binary, binHeader + 8)

  return out
}

main()
