/**
 * 高さ場の突き合わせに使う標本点。
 *
 * **ここが唯一の定義。**GPU 側は画素の座標からこの式で world を導き、
 * CPU 側（`src/sim/terrain.ts` の `heightAt`）は同じ式で同じ点を引く。
 * 点の並びを写しで持つと、片方だけ直したときに別の点どうしを比べる。
 *
 * **three にも DOM にも依存しない純関数。**node 環境の単体テストで回る。
 *
 * 「見えている山と当たる山が違う」を機械で止めるのがこの検査の目的で、
 * 段 14 の合格条件は 1e-3 m 以内の一致。
 */

/** 標本の格子の一辺。区画ごとに 8x8 */
export const HEIGHT_PROBE_SIDE = 8

export interface HeightProbeRegion {
  readonly origin: { readonly x: number; readonly z: number }
  readonly step: { readonly x: number; readonly z: number }
}

/**
 * 標本の区画。
 *
 * **刻みをテクセル（48 m）の倍数にしない。**格子点に乗ると双三次が
 * `t = 0` になり、`p1` を厳密に返すだけの検査になる。補間の途中を通す。
 *
 * 1 つ目は起伏を通す区画。原点は総当たりで選んだ。実測でこの 64 点は
 * 陸地が 36 点、海底の平らな値から外れる点が 52 点あり、最高 2,050 m まで
 * 届く。**平らな海底ばかりの区画では、双三次を間違えても一致してしまう。**
 *
 * 2 つ目は縁を通す区画。高さ場は ±24,576 m しかないので、この区画の右端と
 * 下端は範囲の外へ出る。**縁で止める処理はここでしか通らない。**外すと
 * `textureLoad` が範囲外を引いて 0 を返し、海底の -320 m とずれる
 */
export const HEIGHT_PROBE_REGIONS: readonly HeightProbeRegion[] = [
  { origin: { x: -4000, z: -18000 }, step: { x: 1237.3, z: 1511.7 } },
  { origin: { x: 23800, z: 23800 }, step: { x: 137.3, z: 211.7 } },
]

/** 1 区画あたりの点の数 */
export const HEIGHT_PROBE_PER_REGION = HEIGHT_PROBE_SIDE * HEIGHT_PROBE_SIDE
/** 標本の総数 */
export const HEIGHT_PROBE_COUNT =
  HEIGHT_PROBE_PER_REGION * HEIGHT_PROBE_REGIONS.length

/**
 * 標本の番号から world の XZ を出す。
 *
 * 区画ごとに 64 点ずつ並べる。区画の中の並びは読み戻しに合わせて
 * 「行が先、列があと」。行は `uv.y` の小さい側から
 */
export function heightProbePoint(index: number): { x: number; z: number } {
  const region = HEIGHT_PROBE_REGIONS[Math.floor(index / HEIGHT_PROBE_PER_REGION)]
  if (region === undefined) return { x: Number.NaN, z: Number.NaN }
  const local = index % HEIGHT_PROBE_PER_REGION
  const col = local % HEIGHT_PROBE_SIDE
  const row = Math.floor(local / HEIGHT_PROBE_SIDE)
  return {
    x: region.origin.x + col * region.step.x,
    z: region.origin.z + row * region.step.z,
  }
}

/**
 * 読み戻した RGBA の R 成分だけを取り出す。
 *
 * 高さは R に入れる。GPU 側も CPU 側も同じこの関数を通す
 */
export function heightProbeValues(pixels: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < pixels.length / 4; i++) out.push(pixels[i * 4] ?? Number.NaN)
  return out
}

/** 2 つの並びの最大のずれ m。長さが違えば無限大 */
export function heightMaxError(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY
  let worst = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (!Number.isFinite(d)) return Number.POSITIVE_INFINITY
    if (d > worst) worst = d
  }
  return worst
}
