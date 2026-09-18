// glTF の JSON とバイナリを glb 1 ファイルへ詰める。
//
// **写しを持たない。**`tools/ac3d-to-glb.mjs`（F/A-18C と F-16、AC3D 由来）と
// `tools/f18e-to-glb.mjs`（F/A-18E、glTF 由来）の両方が読む。詰め方を 2 か所に
// 書くと、片方だけ直したときに一方の機体だけ読めなくなる。

/**
 * glb のバイト列を作る。
 *
 * 仕様（glTF 2.0 の Binary glTF）で決まっていること。
 *
 * JSON チャンクの余りは**空白**（0x20）で埋める。0 で埋めると JSON の
 * パースが落ちる実装がある。BIN チャンクの余りは 0 で埋める。
 * どちらも 4 バイト境界に揃える。
 */
export function packGlb(gltf, binary) {
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
  for (let i = 0; i < jsonPadding; i++) out[20 + json.byteLength + i] = 0x20

  const binHeader = 20 + jsonLength
  view.setUint32(binHeader, binLength, true)
  view.setUint32(binHeader + 4, 0x004e4942, true) // "BIN"
  out.set(binary, binHeader + 8)

  return out
}
