import { describe, expect, it } from 'vitest'
import {
  benchBestGain,
  benchNoiseFloor,
  benchUnreadable,
  selectBenchCases,
  type BenchRow,
} from '@render/bench'

/**
 * 「読めない計測」の判定。
 *
 * **「有意」が 1 つも無い表は、費用が無いのではなく測れていない。**実機で
 * 1 度これを踏んだ。ばらつき 3.84 ms に対していちばん大きい差が 2.24 ms で
 * 全行が「誤差以下」か「逆」になった。後処理の連鎖は別の回に 2.75〜3.39 ms
 * と出ているので、費用が無いわけではない。
 *
 * 表の上で見分けるには全行を突き合わせる必要があるので、表に判定させる。
 * **その判定が発火することを、ここで固定する。**SwiftShader では騒がしくても
 * 後処理の差が 500 ms 出るので、絵からは発火を確かめられない。
 */

function row(
  label: string,
  gpuMinMs: number,
  gpuMedianMs: number,
  triangles = 100_000,
): BenchRow {
  return {
    label,
    gpuMinMs,
    gpuMedianMs,
    cpuMinMs: gpuMinMs,
    cpuMedianMs: gpuMedianMs,
    cpuMaxMs: gpuMedianMs * 2,
    triangles,
  }
}

describe('ばらつきの目安', () => {
  it('最小と中央の差の中央値を取る', () => {
    // 差は 1, 2, 3, 4, 5 → 中央は 3
    const rows = [1, 2, 3, 4, 5].map((d, i) => row(`c${i}`, 10, 10 + d))
    expect(benchNoiseFloor(rows)).toBe(3)
  })

  it('GPU クエリが使えないときは 0', () => {
    const rows: BenchRow[] = [
      {
        label: 'a',
        gpuMinMs: null,
        gpuMedianMs: null,
        cpuMinMs: 10,
        cpuMedianMs: 12,
        cpuMaxMs: 20,
        triangles: 0,
      },
    ]
    expect(benchNoiseFloor(rows)).toBe(0)
  })

  it('行が無ければ 0', () => {
    expect(benchNoiseFloor([])).toBe(0)
  })
})

describe('いちばん大きい短縮', () => {
  it('基準は先頭の行。負の値で返す', () => {
    const rows = [row('基準', 10, 11), row('切った', 7, 8), row('少し', 9.5, 10)]
    expect(benchBestGain(rows)).toBeCloseTo(-3, 6)
  })

  it('どれも縮まなければ 0。切ったのに遅い行は差にしない', () => {
    const rows = [row('基準', 10, 11), row('逆', 10.5, 11), row('同じ', 10, 11)]
    expect(benchBestGain(rows)).toBe(0)
  })

  it('行が無ければ 0', () => {
    expect(benchBestGain([])).toBe(0)
  })
})

describe('読めない計測の判定', () => {
  /**
   * 実機で踏んだ形をそのまま入れる。**21 条件ぶん全部でないと中央値が
   * 合わない。**部分集合で書いたら 3.80 になった。
   *
   * Intel Arc 140V / preset high / 1920 x 946 / `enemy-eight` f240。
   */
  const REAL_NOISY: readonly (readonly [string, number, number])[] = [
    ['基準', 7.01, 11.3],
    ['空なし', 6.64, 11.84],
    ['地形なし', 8.16, 12.23],
    ['海面なし', 6.1, 11.73],
    ['雲なし', 5.14, 8.64],
    ['後処理だけ', 4.77, 8.57],
    ['法線摂動なし', 8.17, 11.92],
    ['機体なし', 7.83, 10.58],
    ['影なし', 6.98, 11.88],
    ['環境反射なし', 6.3, 10.61],
    ['軌跡なし', 8.68, 11.55],
    ['標的なし', 7.4, 11.41],
    ['敵機なし', 5.93, 6.94],
    ['ダメージの煙なし', 7.51, 11.64],
    ['曳光弾なし', 8.0, 11.84],
    ['ミサイルなし', 6.22, 12.06],
    ['煙なし', 8.42, 11.23],
    ['爆発なし', 8.87, 11.41],
    ['武装ぜんぶなし', 7.78, 11.5],
    ['lod 0.65', 9.21, 12.54],
    ['cells 24', 6.08, 11.75],
  ]

  it('差がばらつきに埋もれていれば読めない', () => {
    const rows = REAL_NOISY.map(([l, n, m]) => row(l, n, m))
    expect(benchNoiseFloor(rows)).toBeCloseTo(3.84, 2)
    expect(benchBestGain(rows)).toBeCloseTo(-2.24, 2)
    expect(benchUnreadable(rows)).toBe(true)
  })

  it('騒がしい 1 行を静かにするだけでは読めるようにならない', () => {
    // 敵機なしの中央を下げてもばらつきの中央は動かない。**1 行では効かない**
    const rows = REAL_NOISY.map(([l, n, m]) => row(l, n, l === '敵機なし' ? n : m))
    expect(benchUnreadable(rows)).toBe(true)
  })

  it('ばらつきを超える差が 1 つでもあれば読める', () => {
    // 後処理だけを 3.0 ms まで落とす。差 −4.01 ms がばらつき 3.84 を超える
    const rows = REAL_NOISY.map(([l, n, m]) =>
      row(l, l === '後処理だけ' ? 3.0 : n, l === '後処理だけ' ? 6.84 : m),
    )
    expect(benchNoiseFloor(rows)).toBeCloseTo(3.84, 2)
    expect(benchBestGain(rows)).toBeCloseTo(-4.01, 2)
    expect(benchUnreadable(rows)).toBe(false)
  })

  it('境界。差がばらつきと同じなら読める', () => {
    const rows = [row('基準', 10, 11), row('切った', 9, 10)]
    expect(benchNoiseFloor(rows)).toBe(1)
    expect(benchBestGain(rows)).toBe(-1)
    expect(benchUnreadable(rows)).toBe(false)
  })

  it('境界。差がばらつきをわずかに下回れば読めない', () => {
    const rows = [row('基準', 10, 11), row('切った', 9.01, 10.01)]
    expect(benchUnreadable(rows)).toBe(true)
  })

  it('1 行だけなら判定しない。比べる相手がいない', () => {
    expect(benchUnreadable([row('基準', 10, 11)])).toBe(false)
    expect(benchUnreadable([])).toBe(false)
  })

  /**
   * **SwiftShader では発火しない。**騒がしくても後処理の差が桁で出る。
   * 実測で ばらつき 493.30 ms・後処理だけ −513.39 ms。
   */
  it('SwiftShader の実測では読めると判定する', () => {
    const rows = [
      row('基準', 727.48, 1233.94),
      row('空なし', 690.96, 1137.57),
      row('地形なし', 506.69, 901.28),
      row('海面なし', 817.31, 897.84),
      row('雲なし', 478.31, 705.64),
      row('後処理だけ', 214.09, 279.5),
      row('法線摂動なし', 721.35, 793.01),
      row('機体なし', 634.38, 850.67),
      row('影なし', 649.32, 1015.73),
      row('環境反射なし', 687.64, 1381.92),
      row('軌跡なし', 821.32, 1578.24),
      row('標的なし', 633.69, 1530.02),
      row('敵機なし', 599.45, 1711.14),
      row('ダメージの煙なし', 785.28, 1777.05),
      row('曳光弾なし', 817.92, 1169.2),
      row('ミサイルなし', 661.99, 1320.57),
      row('煙なし', 676.36, 1242.85),
      row('爆発なし', 668.1, 885.54),
      row('武装ぜんぶなし', 710.86, 1538.73),
      row('lod 0.65', 682.38, 1189.01),
      row('cells 24', 598.16, 1091.45),
    ]
    expect(benchNoiseFloor(rows)).toBeCloseTo(493.29, 1)
    expect(benchBestGain(rows)).toBeCloseTo(-513.39, 2)
    expect(benchUnreadable(rows)).toBe(false)
  })
})

describe('条件の絞り込み', () => {
  const all = [
    { key: 'base', label: '基準', config: {} },
    { key: 'clouds', label: '雲なし', config: {} },
    { key: 'enemies', label: '敵機なし', config: {} },
    { key: 'lod', label: 'lod 0.65', config: {} },
  ]

  it('空なら全条件', () => {
    expect(selectBenchCases(all, '').map((c) => c.key)).toEqual([
      'base',
      'clouds',
      'enemies',
      'lod',
    ])
  })

  it('選んだ条件だけを残す', () => {
    expect(selectBenchCases(all, 'enemies').map((c) => c.key)).toEqual(['base', 'enemies'])
  })

  it('基準は選ばなくても入る。差の基準になる', () => {
    expect(selectBenchCases(all, 'clouds,lod').map((c) => c.key)).toEqual([
      'base',
      'clouds',
      'lod',
    ])
  })

  it('並びは元の順を保つ。渡した順ではない', () => {
    expect(selectBenchCases(all, 'lod,clouds').map((c) => c.key)).toEqual([
      'base',
      'clouds',
      'lod',
    ])
  })

  it('空白を挟んでも読む', () => {
    expect(selectBenchCases(all, ' enemies , lod ').map((c) => c.key)).toEqual([
      'base',
      'enemies',
      'lod',
    ])
  })

  /**
   * **知らない名前で基準だけになったら全条件へ戻す。**1 行の表を出しても
   * 何も分からないので、絞り込みが噛んでいないと分かる形にする。
   */
  it('知らない名前だけなら全条件へ戻す', () => {
    expect(selectBenchCases(all, 'nosuch').map((c) => c.key)).toHaveLength(4)
  })

  it('基準だけを選んでも全条件へ戻す', () => {
    expect(selectBenchCases(all, 'base').map((c) => c.key)).toHaveLength(4)
  })

  it('知らない名前が混ざっても、分かるものは残す', () => {
    expect(selectBenchCases(all, 'nosuch,enemies').map((c) => c.key)).toEqual([
      'base',
      'enemies',
    ])
  })
})
