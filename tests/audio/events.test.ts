import { describe, it, expect } from 'vitest'
import {
  diffCounters,
  limitExplosions,
  isFiring,
  MAX_EXPLOSIONS_PER_FRAME,
  type AudioCounters,
} from '../../src/audio/events'

/**
 * 音のきっかけ。
 *
 * **主題はやり直しでカウンタが 0 へ戻る場合。**素直に引くと大きな負の数に
 * なる。
 */

function counters(
  roundsFired: number,
  explosionCount: number,
  missilesFired: number,
): AudioCounters {
  return { roundsFired, explosionCount, missilesFired }
}

describe('カウンタの差', () => {
  it('進んだぶんを返す', () => {
    const e = diffCounters(counters(10, 2, 1), counters(14, 3, 1))
    expect(e).toEqual({ shots: 4, explosions: 1, launches: 0 })
  })

  it('何も起きていなければ 0', () => {
    expect(diffCounters(counters(10, 2, 1), counters(10, 2, 1))).toEqual({
      shots: 0,
      explosions: 0,
      launches: 0,
    })
  })

  /** **R でやり直すと `World` が作り直されてカウンタが 0 へ戻る** */
  it('やり直しで 0 へ戻っても負を返さない', () => {
    const e = diffCounters(counters(500, 8, 6), counters(0, 0, 0))
    expect(e).toEqual({ shots: 0, explosions: 0, launches: 0 })
  })

  /** 1 つでも戻っていたらそのフレームは鳴らさない */
  it('一部だけ戻った場合も鳴らさない', () => {
    const e = diffCounters(counters(500, 8, 6), counters(520, 0, 6))
    expect(e).toEqual({ shots: 0, explosions: 0, launches: 0 })
  })

  it('ミサイルの発射を拾う', () => {
    expect(diffCounters(counters(0, 0, 2), counters(0, 0, 3)).launches).toBe(1)
  })
})

describe('爆発の上限', () => {
  it('上限までは素通し', () => {
    const e = { shots: 0, explosions: MAX_EXPLOSIONS_PER_FRAME, launches: 0 }
    expect(limitExplosions(e)).toEqual(e)
  })

  /** **同時に重なると振幅が足し合わさってクリップする** */
  it('超えたぶんは切る', () => {
    const e = limitExplosions({ shots: 3, explosions: 7, launches: 1 })
    expect(e.explosions).toBe(MAX_EXPLOSIONS_PER_FRAME)
    // 他の項目は触らない
    expect(e.shots).toBe(3)
    expect(e.launches).toBe(1)
  })
})

describe('機銃', () => {
  /** **1 発ずつ鳴らさない。**秒 100 発で音源を 100 個作ることになる */
  it('撃っていれば真', () => {
    expect(isFiring({ shots: 1, explosions: 0, launches: 0 })).toBe(true)
    expect(isFiring({ shots: 12, explosions: 0, launches: 0 })).toBe(true)
  })

  it('撃っていなければ偽', () => {
    expect(isFiring({ shots: 0, explosions: 3, launches: 1 })).toBe(false)
  })
})
