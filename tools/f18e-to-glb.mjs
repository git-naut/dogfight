// F/A-18E の glTF を、この作品が読める glb へ直す。
//
// **AC3D からの変換とは別の道具。**`tools/ac3d-to-glb.mjs` は AC3D を解いて
// 頂点を組み直すが、こちらの原本は既に glTF なので**頂点を 1 バイトも触らない。**
// ノードの階層と変換だけを書き換える。
//
// ## やること
//
// 1. 舵面ごとに親ノードを挿し、`AileronLeft` などと名付ける
// 2. その親の原点をヒンジの位置に置き、子で打ち消して元の位置へ戻す
// 3. 降着装置を `gear` ノードの下にまとめる
// 4. 座標系をこの作品の規約（機首 −Z、上 +Y、右 +X）へ回す
// 5. 単位を m にする
// 6. ヒンジを `scenes[0].extras.hinges` に載せる
// 7. テクスチャを WebP へ落として `public/aircraft/` へ置く
//
// ## 頂点を触らない理由
//
// 「原点をヒンジへ移す」は、ふつうは頂点を平行移動して実現する
// （`ac3d-to-glb.mjs` がそうしている）。だがこの原本は 6.3 MB の `scene.bin` を
// 持ち、インターリーブされた頂点属性が入っている。書き換えると法線も接線も
// UV も並べ直すことになり、**間違えても絵にしか出ない。**
//
// ノードを 1 段挟めば同じことが行列でできる。
//
//   AileronLeft   （原点 = ヒンジ位置。ここを回す）
//     └ Main2     （translation = 元の位置 − ヒンジ位置）
//         └ Main2_Material.005_0（メッシュ。無改変）
//
// ## 座標系
//
// 原本は 機首 −X / 上 +Y / Z が翼幅。この作品は 機首 −Z / 上 +Y / 右 +X。
// Y 軸まわりに −90 度回すと機首が −Z を向く。
//
//   (x, y, z) → (−z, y, x)
//
// **鏡映は使えない。**左右を合わせるために鏡映すると、テクスチャの文字
// （`VFA-143` や機番）が裏返る。回転で機首を合わせ、**左右の割り当ては絵を
// 見て決める**（`MIRROR_SIDES`）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { packGlb } from './glb-pack.mjs'
import { identifyParts, SCALE } from './f18e-parts.mjs'
import { buildHinges } from './f18e-hinges.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'assets/upstream/f18e/scene.gltf')
const OUT_DIR = join(ROOT, 'public/aircraft')
const OUT_NAME = 'f18e'

/**
 * 左右の割り当てを入れ替えるか。
 *
 * 座標系を回すと、原本の「Z が負の側」が変換後の右（+X）になる。それが
 * 実際の右翼かどうかは**絵を見ないと分からない。**確認したら値を固定する。
 *
 * 入れ替えが要るなら、同定した `side` を反転して名前を付ける。ヒンジの軸の
 * 向きも一緒に反転する（左右で逆を向いている必要があるため）。
 */
const MIRROR_SIDES = false


function rotateToWorld([x, y, z]) {
  // Y 軸まわりに −90 度。機首 −X → −Z
  return [-z, y, x]
}

/** 4x4 の行優先。掛け算と、ノードの matrix（列優先）との相互変換 */
function matMul(a, b) {
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

/** glTF の列優先 16 要素 → 行優先 4x4 */
function fromGltfMatrix(m) {
  return [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ]
}

/** 行優先 4x4 → glTF の列優先 16 要素 */
function toGltfMatrix(a) {
  const out = []
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(a[r][c])
  return out
}

/** ノードの変換を行優先 4x4 で取り出す */
function nodeMatrix(node) {
  if (node.matrix !== undefined) return fromGltfMatrix(node.matrix)
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
  const sc = [sx, sy, sz]
  return [
    [r[0][0] * sc[0], r[0][1] * sc[1], r[0][2] * sc[2], tx],
    [r[1][0] * sc[0], r[1][1] * sc[1], r[1][2] * sc[2], ty],
    [r[2][0] * sc[0], r[2][1] * sc[1], r[2][2] * sc[2], tz],
    [0, 0, 0, 1],
  ]
}

function normalize([x, y, z]) {
  const n = Math.hypot(x, y, z)
  if (n === 0) throw new Error('長さ 0 の軸')
  return [x / n, y / n, z / n]
}

function main() {
  const gltf = JSON.parse(readFileSync(SRC, 'utf8'))
  const srcDir = dirname(SRC)
  const { matched, gear } = identifyParts(SRC)
  const hinges = buildHinges(SRC)

  // ---- ノードの索引を作る ----
  const nodeIndexByName = new Map()
  gltf.nodes.forEach((n, i) => {
    if (n.name !== undefined) nodeIndexByName.set(n.name, i)
  })

  // 元のルート（`RootNode`）の子を数え直す。舵面と脚は移すので外す
  const rootName = 'RootNode'
  const rootIndex = nodeIndexByName.get(rootName)
  if (rootIndex === undefined) throw new Error('RootNode が無い。原本の構造が変わった')

  // ---- 上の 3 段の変換を `RootNode` の子へ焼き込む ----
  //
  // **これをやらないと回転の中心が合わない。**原本は
  // `Sketchfab_model`（Z-up → Y-up）→ `FA18E.fbx`（0.01 倍）→ `RootNode` の
  // 3 段を経てから各部品が並ぶ。舵面のヒンジは m 単位の変換後の座標で
  // 書いてあるので、`RootNode` の下にそのまま置くと上の 3 段でさらに 500 分の
  // 1 に縮み、**回転の中心が機体の原点になる。**実測で舵面が機体から離れて
  // 翼端の外に浮いた。
  //
  // 上の 3 段と、この作品の座標系への回転・スケールを 1 つの行列に合成して、
  // `RootNode` の各子へ掛ける。**そのあと `RootNode` をシーンのルートにする。**
  const rootToWorld = (() => {
    // f18e（Y 軸 −90 度 + m へのスケール）
    // (x, y, z) → (−z, y, x)。機首 −X が −Z を向く。
    // **符号を逆に書いて 1 度踏んだ。**(z, y, −x) にすると機首が +Z を向き、
    // 追従カメラから見て機体が手前を向く
    const rot = [
      [0, 0, -1, 0],
      [0, 1, 0, 0],
      [1, 0, 0, 0],
      [0, 0, 0, 1],
    ]
    const scl = [
      [SCALE, 0, 0, 0],
      [0, SCALE, 0, 0],
      [0, 0, SCALE, 0],
      [0, 0, 0, 1],
    ]
    let m = matMul(scl, rot)
    // 原本の上の 2 段を辿る。`Sketchfab_model` から `RootNode` の手前まで
    const chain = ['Sketchfab_model', 'FA18E.fbx']
    for (const name of chain) {
      const i = nodeIndexByName.get(name)
      if (i === undefined) throw new Error(`${name} が無い。原本の構造が変わった`)
      m = matMul(m, nodeMatrix(gltf.nodes[i]))
    }
    return m
  })()

  for (const child of gltf.nodes[rootIndex].children ?? []) {
    const node = gltf.nodes[child]
    const baked = matMul(rootToWorld, nodeMatrix(node))
    delete node.translation
    delete node.rotation
    delete node.scale
    node.matrix = toGltfMatrix(baked)
  }

  const moved = new Set()
  for (const m of matched) moved.add(nodeIndexByName.get(m.node))
  // 脚はプリミティブの親を集める
  const gearNodes = new Set()
  for (const p of gear) {
    const parent = p.raw.parent
    const idx = parent !== null ? nodeIndexByName.get(parent) : undefined
    if (idx !== undefined) gearNodes.add(idx)
  }
  for (const i of gearNodes) moved.add(i)

  const keptChildren = (gltf.nodes[rootIndex].children ?? []).filter((c) => !moved.has(c))

  // ---- 舵面の親ノードを作る ----
  const hingeInfo = []
  const surfaceNodes = []
  for (const h of hinges) {
    const srcIndex = nodeIndexByName.get(h.sourceNode)
    if (srcIndex === undefined) throw new Error(`${h.sourceNode} が無い`)

    // ヒンジの位置と軸を、この作品の座標系へ回す
    const origin = rotateToWorld(h.from)
    const axisRaw = [0, 1, 2].map((k) => h.to[k] - h.from[k])
    const axis = normalize(rotateToWorld(axisRaw))

    // 子は「元の位置 − ヒンジ位置」だけ戻す。**回すのは親だけ**なので、
    // 子の変換は平行移動で足りる
    const inner = {
      name: `${h.node}__inner`,
      translation: [-origin[0], -origin[1], -origin[2]],
      children: [srcIndex],
    }
    gltf.nodes.push(inner)
    const innerIndex = gltf.nodes.length - 1

    gltf.nodes.push({
      name: h.node,
      translation: origin,
      children: [innerIndex],
    })
    surfaceNodes.push(gltf.nodes.length - 1)

    hingeInfo.push({
      node: h.node,
      origin,
      axis,
      maxDeg: h.maxDeg,
      channel: h.channel,
      sign: h.sign,
    })
  }

  // ---- 脚をまとめる ----
  gltf.nodes.push({ name: 'gear', children: [...gearNodes] })
  const gearIndex = gltf.nodes.length - 1

  // ---- ルートを組み直す ----
  gltf.nodes.push({
    name: 'body',
    children: keptChildren,
  })
  const bodyIndex = gltf.nodes.length - 1

  gltf.nodes[rootIndex] = {
    name: rootName,
    children: [bodyIndex, gearIndex, ...surfaceNodes],
  }
  void rootName

  // **`RootNode` をそのままシーンのルートにする。**変換は各子へ焼き込んだので、
  // ここに回転やスケールを置くと二重に掛かる
  gltf.nodes[rootIndex].name = OUT_NAME
  gltf.scenes[0].nodes = [rootIndex]

  // ---- ヒンジを載せる ----
  gltf.scenes[0].extras = { hinges: hingeInfo }

  // ---- テクスチャを差し替える ----
  //
  // **変換はここでやらない。**`tools/textures-to-webp.py` が
  // `assets/generated/f18e/` へ出したものを配る。Pillow は CI のランナーに
  // 無いので、`npm run assets` から呼ぶと落ちる（そちらのファイルの注記）。
  // 原本を変えたときだけ手で走らせてコミットする。
  mkdirSync(OUT_DIR, { recursive: true })
  const renamed = new Map()
  for (const image of gltf.images ?? []) {
    if (image.uri === undefined) continue
    const base = decodeURIComponent(image.uri).replace(/^textures\//, '')
    const webp = base.replace(/\.(png|jpe?g)$/i, '.webp')
    const src = join(ROOT, 'assets/generated', OUT_NAME, webp)
    if (!existsSync(src)) {
      throw new Error(
        `${webp} が無い。python3 tools/textures-to-webp.py f18e を走らせてコミットすること`,
      )
    }
    const out = `${OUT_NAME}-${webp.toLowerCase()}`.replace(/[^a-z0-9.-]/g, '-')
    copyFileSync(src, join(OUT_DIR, out))
    renamed.set(image.uri, out)
    image.uri = out
  }

  // ---- バイナリを glb へ ----
  const binUri = gltf.buffers[0].uri
  if (binUri === undefined) throw new Error('埋め込みバッファは未対応')
  const binary = readFileSync(join(srcDir, decodeURIComponent(binUri)))
  delete gltf.buffers[0].uri
  gltf.buffers[0].byteLength = binary.byteLength

  const glb = packGlb(gltf, new Uint8Array(binary))
  const outGlb = join(OUT_DIR, `${OUT_NAME}.glb`)
  writeFileSync(outGlb, glb)

  const triangles = (gltf.meshes ?? []).reduce(
    (sum, mesh) =>
      sum +
      mesh.primitives.reduce(
        (s2, p) =>
          s2 + (p.indices !== undefined ? Math.floor(gltf.accessors[p.indices].count / 3) : 0),
        0,
      ),
    0,
  )

  console.log(`${OUT_NAME}.glb  ${(glb.byteLength / 1024 / 1024).toFixed(2)} MB  ${triangles.toLocaleString()} 三角形`)
  console.log(`  舵面 ${hingeInfo.length} 件  脚 ${gearNodes.size} ノード  テクスチャ ${renamed.size} 枚`)
  console.log(`  左右の入れ替え: ${MIRROR_SIDES ? 'する' : 'しない'}（絵で確かめる）`)
}

main()
