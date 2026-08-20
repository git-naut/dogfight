import { describe, expect, it } from 'vitest'
import { vortexStrength } from '@render/aircraft/trails'

/**
 * 翼端渦の濃さへの写像。
 *
 * 水蒸気の量そのものは sim が持つ（`Aircraft.wingtipVapor`）。ここは
 * 0..1 へ写すだけ。閾値の妥当性は sim 側の実測値で見る。
 */
describe('vortexStrength', () => {
  // sim で実測した水蒸気の値（tests/sim/wingtipVapor.test.ts と対応）
  const levelFlight = 0.053 // 1.07 G / 408 m/s
  const fastShallowPull = 0.196 // 3.39 G / 388 m/s
  const steadyTurn = 0.387 // 3.08 G / 225 m/s
  const zoomClimb = 0.456 // 6.86 G / 340 m/s
  const hardPull = 0.582 // 5.92 G / 269 m/s

  it('水平飛行と、高速で荷重倍数の低い引き起こしでは出ない', () => {
    expect(vortexStrength(levelFlight)).toBe(0)
    expect(vortexStrength(fastShallowPull)).toBe(0)
  })

  it('定常旋回で出る', () => {
    expect(vortexStrength(steadyTurn)).toBeGreaterThan(0.3)
  })

  it('速い急上昇で出る。揚力係数だけで見ると取りこぼす場面', () => {
    expect(vortexStrength(zoomClimb)).toBeGreaterThan(0.5)
  })

  it('高 G の引き起こしで振り切る', () => {
    expect(vortexStrength(hardPull)).toBeGreaterThan(0.9)
  })

  it('0 から 1 に収まり、単調に増える', () => {
    let previous = vortexStrength(0)
    for (let i = 0; i <= 100; i++) {
      const value = vortexStrength(i / 50)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})
