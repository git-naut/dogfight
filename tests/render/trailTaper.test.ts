import { describe, expect, it } from 'vitest'
import { TRAIL_TAPER_POINTS, fillTapers } from '../../src/render/aircraft/trails'

/**
 * 途切れる手前の先細り。
 *
 * 水蒸気は 0.2 秒で立ち上がるので、機動を始めた瞬間の位置に急な段差ができる。
 * 旋回を続けるとその段差が視界へ回り込み、**直角に切り落としたような末端**に
 * 見える。実機の 5.44 G 旋回で指摘された。
 *
 * 段差は履歴の末尾だけにあるのではないので、本数ではなく「0 になる点からの
 * 距離」で数える。
 */
describe('fillTapers', () => {
  const N = TRAIL_TAPER_POINTS

  /** 新しい順の濃さから先細りを求める */
  function taper(values: number[]): number[] {
    const strengths = new Float32Array(values)
    const out = new Float32Array(values.length)
    fillTapers(strengths, values.length, out)
    return Array.from(out)
  }

  it('履歴の末尾が透明から立ち上がる', () => {
    const t = taper(Array(N * 3).fill(1))
    expect(t[N * 3 - 1]).toBeCloseTo(1 / N, 6)
    expect(t[N * 3 - N]).toBeCloseTo(1, 6)
    expect(t[0]).toBe(1)
  })

  it('区間の途中に段差があっても、その古い側で先細りする', () => {
    // 新しい側 20 本は出ていない（引くのをやめた）、そこから 100 本が濃い、
    // その先は出ていない（引き始める前）
    const values = [...Array(20).fill(0), ...Array(100).fill(1), ...Array(60).fill(0)]
    const t = taper(values)
    // 濃い区間の古い側の端（index 119）はほぼ透明
    expect(t[119]).toBeCloseTo(1 / N, 6)
    // そこから N 本で 1 に達する
    expect(t[119 - N + 1]).toBeCloseTo(1, 6)
    // 濃い区間の新しい側は絞らない。翼端では出たままにする
    expect(t[20]).toBe(1)
  })

  it('出ていない点は 0 になる。濃さも 0 なので絵には出ない', () => {
    const t = taper([...Array(5).fill(0), ...Array(50).fill(1)])
    for (let i = 0; i < 5; i++) expect(t[i]).toBe(0)
    expect(t[54]).toBeCloseTo(1 / N, 6)
  })

  it('段差が 2 つあれば 2 回やり直す', () => {
    const values = [...Array(50).fill(1), 0, ...Array(50).fill(1)]
    const t = taper(values)
    expect(t[100]).toBeCloseTo(1 / N, 6) // 古い区間の端
    expect(t[50]).toBe(0) // 段差そのもの
    expect(t[49]).toBeCloseTo(1 / N, 6) // 新しい区間の古い側の端
  })

  it('先細りは単調に増える。区間の中で戻らない', () => {
    const t = taper(Array(N * 4).fill(1))
    for (let i = 1; i < t.length; i++) {
      expect(t[i - 1]!).toBeGreaterThanOrEqual(t[i]!)
    }
  })
})
