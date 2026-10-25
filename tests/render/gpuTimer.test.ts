import { describe, expect, it } from 'vitest'
import type { GpuFrameSample, GpuFrameTimer, RenderBackend } from '@render/backend'
import { PASS_HISTORY, PASS_SUM_TOLERANCE_MS, createGpuTimer } from '@render/gpuTimer'
import type { FramePassTimes } from '@render/pipeline/passTimes'

/**
 * 計器が読む GPU 時間（段 S0a で内訳を足した）。
 *
 * **パスの和と three の合計の食い違いを数える。**両方とも同じ解決の Map から
 * 出るので定義の上では一致する。食い違うのはフレームの選び方が three と
 * ずれたときで、そのときの内訳は信じない。
 */

function frame(totalMs: number, at = 1): FramePassTimes {
  return {
    frame: at,
    totalMs,
    passes: [{ uid: 'r:1:1:f1', label: 'Scene → output', group: '場面', ms: totalMs }],
    unlabeled: 0,
  }
}

/** 回収の中身を 1 回ずつ台本どおりに返すバックエンド */
function backendWith(batches: GpuFrameSample[][]): RenderBackend {
  const timer: GpuFrameTimer = {
    supported: true,
    inflight: 0,
    dropped: 0,
    begin() {},
    end() {},
    collect() {
      return batches.shift() ?? []
    },
    dispose() {},
  }
  return { createTimer: () => timer } as unknown as RenderBackend
}

describe('GPU 時間の内訳', () => {
  it('直近の内訳を残す', () => {
    const t = createGpuTimer(backendWith([[{ id: 0, ms: 3, passes: frame(3) }]]))
    expect(t.lastPasses).toBeNull()
    t.begin()
    expect(t.lastMs).toBe(3)
    expect(t.lastPasses!.totalMs).toBe(3)
    expect(t.passMismatches).toBe(0)
  })

  it('和が合計と許容を超えて食い違った回を数える', () => {
    const t = createGpuTimer(
      backendWith([
        [{ id: 0, ms: 3, passes: frame(3 + PASS_SUM_TOLERANCE_MS / 2) }],
        [{ id: 0, ms: 3, passes: frame(3 + PASS_SUM_TOLERANCE_MS * 2) }],
        [{ id: 0, ms: 3, passes: frame(3 - PASS_SUM_TOLERANCE_MS * 2) }],
      ]),
    )
    t.begin()
    expect(t.passMismatches).toBe(0)
    t.begin()
    expect(t.passMismatches).toBe(1)
    t.begin()
    expect(t.passMismatches).toBe(2)
  })

  it('内訳の無い回は前の内訳を消さない', () => {
    const t = createGpuTimer(
      backendWith([[{ id: 0, ms: 3, passes: frame(3) }], [{ id: 0, ms: 4 }]]),
    )
    t.begin()
    t.begin()
    expect(t.lastMs).toBe(4)
    expect(t.lastPasses!.totalMs).toBe(3)
  })

  it('解決ごとの全フレームを古い順に輪へ積み、上限で古いものから捨てる', () => {
    const batches: GpuFrameSample[][] = []
    let at = 0
    // 1 回の解決に 3 フレームずつ、上限を 2 倍超えるまで
    while (at < PASS_HISTORY * 2) {
      const frames = [frame(1, at), frame(1, at + 1), frame(1, at + 2)]
      batches.push([{ id: 0, ms: 1, passes: frames[2]!, frames }])
      at += 3
    }
    // `collect` が台本を前から取り崩すので、回数は先に数えておく
    const resolves = batches.length
    const t = createGpuTimer(backendWith(batches))
    for (let i = 0; i < resolves; i++) t.begin()
    expect(t.passHistory).toHaveLength(PASS_HISTORY)
    // 古い順で、最新のフレームが末尾
    expect(t.passHistory.at(-1)!.frame).toBe(at - 1)
    expect(t.passHistory[0]!.frame).toBe(at - PASS_HISTORY)
  })
})
