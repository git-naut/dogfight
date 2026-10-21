import { describe, expect, it } from 'vitest'
import { engineLayerGains, shouldLightBurner, turbineRate } from '../../src/audio/engineMix'
import { AUGMENTATION_THROTTLE } from '../../src/sim/flightModel'

/** エンジン音の 3 層（段 B11b、ADR 0038） */
describe('エンジン音の 3 層', () => {
  it('アイドルは下げるほど大きく、タービンは上げるほど大きい', () => {
    const lo = engineLayerGains(0)
    const mid = engineLayerGains(0.6)
    const hi = engineLayerGains(0.84)
    expect(lo.idle).toBeGreaterThan(mid.idle)
    expect(mid.idle).toBeGreaterThan(hi.idle - 1e-9)
    expect(lo.turbine).toBeLessThan(mid.turbine)
    expect(mid.turbine).toBeLessThan(hi.turbine)
  })

  /**
   * ループは RMS をそろえてあるので、全体の大きさは 3 層の大きさの二乗和の平方根に比例する。最初の幅
   * （アイドル 0.55・タービン 0.55）では 0.2 から 0.7 で 0.05 dB しか上がらなかった
   */
  it('全体の大きさは 0.2・0.7・1.0 と上げるたびに 2 dB 以上大きくなる', () => {
    const level = (t: number) => {
      const g = engineLayerGains(t)
      return 20 * Math.log10(Math.hypot(g.idle, g.turbine, g.burner))
    }
    expect(level(0.7) - level(0.2)).toBeGreaterThan(2)
    expect(level(1) - level(0.7)).toBeGreaterThan(2)
  })

  it('アフターバーナーは 0.85 を越えるまで鳴らない', () => {
    expect(engineLayerGains(0).burner).toBe(0)
    expect(engineLayerGains(AUGMENTATION_THROTTLE - 0.001).burner).toBe(0)
    expect(engineLayerGains(0.93).burner).toBeGreaterThan(0)
    expect(engineLayerGains(1).burner).toBeCloseTo(0.8, 9)
  })

  it('タービンの再生の速さは 0.85 倍から 1.15 倍', () => {
    expect(turbineRate(0)).toBeCloseTo(0.85, 9)
    expect(turbineRate(1)).toBeCloseTo(1.15, 9)
    expect(turbineRate(2)).toBeCloseTo(1.15, 9)
  })

  it('点火の音は 0.85 を下から越えた瞬間だけ、1 秒あけて鳴らす', () => {
    expect(shouldLightBurner(0.8, 0.9, 10, -Infinity)).toBe(true)
    expect(shouldLightBurner(0.9, 0.95, 10, -Infinity)).toBe(false)
    expect(shouldLightBurner(0.8, 0.84, 10, -Infinity)).toBe(false)
    expect(shouldLightBurner(0.8, 0.9, 10, 9.5)).toBe(false)
    expect(shouldLightBurner(0.8, 0.9, 10, 9)).toBe(true)
  })
})
