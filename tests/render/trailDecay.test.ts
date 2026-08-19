import { describe, expect, it } from 'vitest'
import { TRAIL_DECAY_HOLD, trailDecay } from '../../src/render/aircraft/trails'

/**
 * 軌跡の減衰。
 *
 * 以前は履歴の何本目かに対して二乗で落としていたので、画面に映る範囲で
 * すでに薄くなり、軌跡が空中で尻すぼみに消えた。手前を保つ形に変えた。
 * その性質を固定する。
 */
describe('trailDecay', () => {
  it('生まれたばかりの点は減衰しない', () => {
    expect(trailDecay(0)).toBe(1)
    expect(trailDecay(TRAIL_DECAY_HOLD)).toBe(1)
  })

  it('寿命で 0 になる', () => {
    expect(trailDecay(1)).toBe(0)
    expect(trailDecay(1.5)).toBe(0)
  })

  it('手前は濃さを保つ。画面に映る範囲で薄くならないための性質', () => {
    // 寿命 16 秒に対し、画面に映るのは実測で 1 秒ぶん。その範囲は減衰なし
    expect(trailDecay(1 / 16)).toBe(1)
    // 保持の直後もまだほとんど落ちない
    expect(trailDecay(TRAIL_DECAY_HOLD + 0.05)).toBeGreaterThan(0.98)
  })

  it('単調に減る', () => {
    let previous = trailDecay(0)
    for (let i = 1; i <= 100; i++) {
      const value = trailDecay(i / 100)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }
  })

  it('中間で滑らかに落ちる。smoothstep なので中点はちょうど半分', () => {
    const middle = TRAIL_DECAY_HOLD + (1 - TRAIL_DECAY_HOLD) / 2
    expect(trailDecay(middle)).toBeCloseTo(0.5, 6)
  })
})
