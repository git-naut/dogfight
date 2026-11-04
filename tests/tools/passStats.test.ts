import { describe, expect, it } from 'vitest'
import {
  DROPPED_INTERVAL_MS,
  FRAME_BUDGET_MS,
  READ_GAP_MS,
  collectFrames,
  frameOutliers,
  passStats,
  quantile,
  type CpuFrame,
  type PassFrame,
} from '../../tools/pass-stats.mjs'

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

/** rAF の時刻を間隔の列から作る */
function cpuFrames(start: number, intervals: number[]): CpuFrame[] {
  let at = 1000
  const out: CpuFrame[] = [{ frame: start, at, simMs: 1, syncMs: 1, renderMs: 2, hudMs: 0.5 }]
  intervals.forEach((ms, i) => {
    at += ms
    out.push({ frame: start + i + 1, at, simMs: 1, syncMs: 1, renderMs: ms > 20 ? 9 : 2, hudMs: 0.5 })
  })
  return out
}

describe('跳ねたコマ（段 S5）', () => {
  it('GPU が 1 フレームの長さを越えたコマを数え、重い順に群の内訳を出す', () => {
    const frames = [
      frame(1, [['場面', 6], ['海', 2]]),
      frame(2, [['場面', 12], ['海', 6]]),
      frame(3, [['場面', 6], ['海', 2], ['環境', 9]]),
    ]
    const o = frameOutliers(frames, [])
    expect(o.gpu.over).toBe(2)
    // 越えたかに関わらず重い順（跳ねが無い回でも最も重いコマを見る）
    expect(o.gpu.worst.map((w) => w.frame)).toEqual([2, 3, 1])
    expect(o.gpu.worst[0]!.groups[0]).toEqual({ group: '場面', ms: 12 })
    // 境目: ちょうど 1 フレームの長さは越えていない
    expect(frameOutliers([frame(9, [['場面', FRAME_BUDGET_MS]])], []).gpu.over).toBe(0)
  })

  it('CPU の記録が無い版では cpu を null にする', () => {
    expect(frameOutliers([frame(1, [['場面', 5]])], []).cpu).toBeNull()
  })

  it('rAF の間隔が 1.5 フレームを越えたコマを落ちたコマとして数え、同じ番号の GPU を添える', () => {
    const frames = [frame(11, [['場面', 5]]), frame(12, [['場面', 14]])]
    const o = frameOutliers(frames, cpuFrames(10, [16.7, 33.4, 16.6, DROPPED_INTERVAL_MS]))
    expect(o.cpu!.intervals).toBe(4)
    // ちょうど 1.5 倍は落ちていない
    expect(o.cpu!.dropped).toBe(1)
    const w = o.cpu!.worst[0]!
    expect(w.frame).toBe(12)
    expect(w.intervalMs).toBeCloseTo(33.4, 9)
    expect(w.renderMs).toBe(9)
    expect(w.gpuMs).toBe(14)
    // GPU の記録の無い番号は null
    expect(o.cpu!.worst.find((x) => x.frame === 13)!.gpuMs).toBeNull()
  })

  it('番号が飛んでも間隔を作り、1 秒を越える間隔は読み出しの抜けとして作らない', () => {
    // 実機では番号が 1 ずつ進まなかった（段 S5）
    const cpu = cpuFrames(10, [16.7, 16.7]).map((c, i) => ({ ...c, frame: 10 + i * 3 }))
    expect(frameOutliers([], cpu).cpu!.intervals).toBe(2)
    const gap = [...cpu, { ...cpu[2]!, frame: 40, at: cpu[2]!.at + READ_GAP_MS + 1 }]
    const o = frameOutliers([], gap).cpu!
    expect(o.intervals).toBe(2)
    expect(o.dropped).toBe(0)
  })
})
