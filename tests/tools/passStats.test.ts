import { describe, expect, it } from 'vitest'
import { collectFrames, passStats, quantile, type PassFrame } from '../../tools/pass-stats.mjs'

/**
 * 実機の計測の統計（段 S0a）。予算の判断はこの数字で行うので、分位点と
 * 間欠の群の扱いを固定する。
 */

function frame(at: number, parts: [string, number][]): PassFrame {
  const passes = parts.map(([group, ms], i) => ({ uid: `r:${i}:0:f${at}`, label: group, group, ms }))
  return { frame: at, totalMs: parts.reduce((a, [, ms]) => a + ms, 0), passes, unlabeled: 0 }
}

describe('分位点', () => {
  it('線形補間で取る', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([4, 1, 3, 2], 0)).toBe(1)
    expect(quantile([4, 1, 3, 2], 1)).toBe(4)
    expect(quantile([10, 20], 0.95)).toBeCloseTo(19.5, 12)
  })

  it('空なら null', () => {
    expect(quantile([], 0.5)).toBeNull()
  })
})

describe('フレームの集め方', () => {
  it('フレーム番号で重なりを除く', () => {
    const seen = new Map<number, PassFrame>()
    expect(collectFrames(seen, [frame(1, []), frame(2, [])])).toBe(2)
    // 0.5 秒後に読むと前回と重なる
    expect(collectFrames(seen, [frame(2, []), frame(3, [])])).toBe(1)
    expect([...seen.keys()]).toEqual([1, 2, 3])
  })
})

describe('群ごとの統計', () => {
  it('間欠の群は出たフレームの値と全フレームの平均の寄与を分ける', () => {
    // 4 フレームのうち 1 フレームだけ環境反射が 8 ms 加わる
    const frames = [
      frame(1, [['場面', 4]]),
      frame(2, [['場面', 4]]),
      frame(3, [
        ['場面', 4],
        ['環境反射', 8],
      ]),
      frame(4, [['場面', 4]]),
    ]
    const stats = passStats(frames)
    const env = stats.groups.find((g) => g.group === '環境反射')!
    expect(env.frames).toBe(1)
    expect(env.share).toBe(0.25)
    expect(env.median).toBe(8)
    expect(env.meanPerFrame).toBe(2)
    expect(stats.total.median).toBe(4)
    expect(stats.total.max).toBe(12)
  })

  it('同じ群の複数のパスはフレームの中で足す', () => {
    const stats = passStats([
      frame(1, [
        ['ブルーム', 0.25],
        ['ブルーム', 0.5],
      ]),
    ])
    expect(stats.groups[0]!.median).toBe(0.75)
  })
})
