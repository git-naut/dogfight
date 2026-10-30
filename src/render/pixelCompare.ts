/**
 * 読み戻した絵のバイトを比べる道具。自己診断（`pipeline/node.ts`）と node-path の検査が使う。
 *
 * 段 S4b で体積の雲を消したときに、`clouds/marchProbe.ts`（`NOISE_FLOOR`・`byteDifference`）と
 * `clouds/geometry.ts`（`tileMeans`）から移した。雲に固有の道具ではなかった。
 */

/** 撮り直しで動く差の上限。これ以下は雑音として数えない */
export const NOISE_FLOOR = 1

/** 区画平均の区切りの数（一辺） */
export const TILES = 4

/**
 * 2 枚の絵のバイトの違いを数える。
 *
 * 完全一致を期待するが、外れたときに「どれくらい」を出せるようにしておく
 *
 * **「動いたか」を数えるときは `floor` に `NOISE_FLOOR` を渡す。**SwiftShader は
 * 同じ状態を撮り直しても約 1,800 バイトが 1 だけ動く（実測。雑音が 0 の回も
 * ある）。下限なしで数えると閾値を雑音で越え、影が 132 バイトしか動かない
 * のに 500 を通していた。`max` は下限に関係なく返す
 */
export function byteDifference(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  floor = 0,
): { differing: number; max: number } {
  if (a.length !== b.length) {
    return { differing: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY }
  }
  let differing = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > floor) differing++
    if (d > max) max = d
  }
  return { differing, max }
}

/**
 * RGBA の絵を `tiles` × `tiles` に区切り、区画ごとの赤の平均を 0..1 で返す。
 *
 * 行の並びは「uv の v = 0 の側が先頭」で両側そろえること。長さが足りなければ空を返す。
 * **黙って 0 で埋めない**
 */
export function tileMeans(
  bytes: ArrayLike<number>,
  width: number,
  height: number,
  tiles = TILES,
): number[] {
  if (bytes.length < width * height * 4) return []
  const sums = new Array<number>(tiles * tiles).fill(0)
  const counts = new Array<number>(tiles * tiles).fill(0)
  for (let y = 0; y < height; y++) {
    const row = Math.min(tiles - 1, Math.floor((y / height) * tiles))
    for (let x = 0; x < width; x++) {
      const col = Math.min(tiles - 1, Math.floor((x / width) * tiles))
      const t = row * tiles + col
      sums[t]! += bytes[(y * width + x) * 4]!
      counts[t]! += 1
    }
  }
  return sums.map((v, i) => (counts[i] === 0 ? 0 : v / counts[i]! / 255))
}
