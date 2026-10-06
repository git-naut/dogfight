// 空母 Gerald R. Ford の glTF を、この作品が読める glb へ直す（Phase 9 の段 2）。
//
// **頂点を 1 バイトも触らない。**シーンの頂上に `ford` ノードを 1 つ挟み、`tools/ford-parts.mjs`
// の行列（原点・180 度の回転・倍率）を掛けるだけにする。F/A-18E の `tools/f18e-to-glb.mjs`
// と同じ方針で、間違えても絵にしか出ない頂点の並べ替えを避ける。
//
// テクスチャは `tools/textures-to-webp.py ford` が `assets/generated/ford/` へ出した WebP を
// 配る（Pillow が CI に無いので、変換は手で走らせてコミットする。f18e と同じ）。
//
// 実行は `npm run assets`（`package.json`）。出力は `public/aircraft/ford.glb` と
// `public/aircraft/ford-*.webp` で、git の管理外。
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { packGlb } from './glb-pack.mjs'
import { DECK_HEIGHT, LENGTH_OVERALL, SCALE, worldMatrix } from './ford-parts.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'assets/upstream/ford/scene.gltf')
const OUT_DIR = join(ROOT, 'public/aircraft')
const OUT_NAME = 'ford'

/** 行優先 4x4 → glTF の列優先 16 要素 */
function toGltfMatrix(a) {
  const out = []
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(a[r][c])
  return out
}

function main() {
  const gltf = JSON.parse(readFileSync(SRC, 'utf8'))
  const srcDir = dirname(SRC)

  // ---- 頂上にノードを挟む ----
  // 原本の上位ノード（Sketchfab_model → gerald ford carrier.fbx → RootNode → ship_deck）は
  // そのまま残す。`readGltfParts` が測った座標はこの階層を掛けたあとの値なので、その外側に
  // 掛ければ `ford-parts.mjs` の `toWorld` と同じになる
  const scene = gltf.scenes[gltf.scene ?? 0]
  gltf.nodes.push({ name: OUT_NAME, matrix: toGltfMatrix(worldMatrix()), children: [...scene.nodes] })
  scene.nodes = [gltf.nodes.length - 1]
  scene.extras = {
    ...(scene.extras ?? {}),
    lengthOverall: LENGTH_OVERALL,
    scale: SCALE,
    deckHeight: DECK_HEIGHT,
  }

  // ---- テクスチャを差し替える ----
  mkdirSync(OUT_DIR, { recursive: true })
  let images = 0
  for (const image of gltf.images ?? []) {
    if (image.uri === undefined) continue
    const base = decodeURIComponent(image.uri).replace(/^textures\//, '')
    const webp = base.replace(/\.(png|jpe?g)$/i, '.webp')
    const src = join(ROOT, 'assets/generated', OUT_NAME, webp)
    if (!existsSync(src)) {
      throw new Error(`${webp} が無い。python3 tools/textures-to-webp.py ford を走らせてコミットすること`)
    }
    const out = `${OUT_NAME}-${webp.toLowerCase()}`.replace(/[^a-z0-9.-]/g, '-')
    copyFileSync(src, join(OUT_DIR, out))
    image.uri = out
    // 原本は jpeg と png。WebP に替えたので型の指定を外す（uri の拡張子で読まれる）
    delete image.mimeType
    images++
  }

  // ---- バイナリを読んで glb にまとめる ----
  const binUri = gltf.buffers[0].uri
  if (binUri === undefined) throw new Error('埋め込みバッファは未対応')
  const binary = new Uint8Array(readFileSync(join(srcDir, decodeURIComponent(binUri))))
  delete gltf.buffers[0].uri
  gltf.buffers[0].byteLength = binary.byteLength
  const glb = packGlb(gltf, binary)
  writeFileSync(join(OUT_DIR, `${OUT_NAME}.glb`), glb)

  const triangles = (gltf.meshes ?? []).reduce(
    (sum, mesh) =>
      sum +
      mesh.primitives.reduce(
        (s2, p) => s2 + (p.indices !== undefined ? Math.floor(gltf.accessors[p.indices].count / 3) : 0),
        0,
      ),
    0,
  )
  console.log(
    `${OUT_NAME}.glb  ${(glb.byteLength / 1024 / 1024).toFixed(2)} MB  ${triangles.toLocaleString()} 三角形` +
      `  テクスチャ ${images} 枚  甲板の高さ ${DECK_HEIGHT.toFixed(2)} m`,
  )
}

main()
