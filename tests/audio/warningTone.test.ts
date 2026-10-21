import { describe, expect, it } from 'vitest'
import { WARNING_TONE_HZ, WARBLE_PERIOD_FAR, WARBLE_PERIOD_NEAR, warblePeriod } from '../../src/audio/warningTone'

/**
 * ミサイル警告音（段 B10、ADR 0035）。録画の持続音は約 766 Hz の倍音で、揺れの周期は 150 ms。
 * 着弾が近づくほど周期を縮め、1 秒以内で 60 ms（ユーザーの決定）
 */
describe('ミサイル警告音', () => {
  it('高さは録画の倍音から出した 766 Hz', () => {
    expect(WARNING_TONE_HZ).toBe(766)
    // 録画の線 2,300・3,060・3,830・4,600 Hz が 3〜6 倍の ±2% に入る
    for (const [k, hz] of [[3, 2300], [4, 3060], [5, 3830], [6, 4600]] as const) {
      expect(Math.abs(WARNING_TONE_HZ * k - hz) / hz).toBeLessThan(0.02)
    }
  })

  it('着弾まで 6 秒以上は録画の 150 ms、1 秒以内は 60 ms', () => {
    expect(WARBLE_PERIOD_FAR).toBe(0.15)
    expect(WARBLE_PERIOD_NEAR).toBe(0.06)
    expect(warblePeriod(6)).toBeCloseTo(0.15, 9)
    expect(warblePeriod(20)).toBeCloseTo(0.15, 9)
    expect(warblePeriod(Infinity)).toBeCloseTo(0.15, 9)
    expect(warblePeriod(Number.NaN)).toBeCloseTo(0.15, 9)
    expect(warblePeriod(1)).toBeCloseTo(0.06, 9)
    expect(warblePeriod(0.2)).toBeCloseTo(0.06, 9)
  })

  it('間は一様に縮む', () => {
    expect(warblePeriod(3.5)).toBeCloseTo(0.105, 9)
    let last = Infinity
    for (let t = 8; t >= 0; t -= 0.25) {
      const p = warblePeriod(t)
      expect(p).toBeLessThanOrEqual(last)
      last = p
    }
  })
})
