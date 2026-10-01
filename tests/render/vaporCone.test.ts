import { describe, expect, it } from 'vitest'
import { vaporStrength } from '../../src/render/aircraft/vaporCone'

describe('ベイパーコーンが出る速さ', () => {
  it('巡航（マッハ 0.73）では出ない', () => {
    expect(vaporStrength(0.73)).toBe(0)
    expect(vaporStrength(0.88)).toBe(0)
  })

  it('マッハ 0.95〜1.02 で最大', () => {
    expect(vaporStrength(0.95)).toBe(1)
    expect(vaporStrength(1.0)).toBe(1)
    expect(vaporStrength(1.02)).toBe(1)
  })

  it('超音速へ抜けると消える', () => {
    expect(vaporStrength(1.1)).toBe(0)
    expect(vaporStrength(1.5)).toBe(0)
    expect(vaporStrength(1.06)).toBeGreaterThan(0)
    expect(vaporStrength(1.06)).toBeLessThan(1)
  })
})
