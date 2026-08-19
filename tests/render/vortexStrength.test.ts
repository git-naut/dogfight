import { describe, expect, it } from 'vitest'
import { vortexStrength } from '../../src/render/aircraft/trails'

/**
 * 翼端渦の濃さ。
 *
 * 最初は荷重倍数で決めていた。実測するとsteadyTurnは 3.0〜3.3 G までしか
 * 出ないので閾値 3.5 に届かず、旋回でまったく渦が出なかった。逆に高速の
 * 引き起こしは 3.3 G で閾値近くまで来る。揚力係数で見ると逆転する。
 *
 * ここで固定するのは、その逆転が保たれていること。
 */
describe('vortexStrength', () => {
  // sim で実測した値（tests/sim/aircraft.test.ts と同じ台本）
  const levelFlight = 0.044
  const fastPull = 0.171 // 3.39 G / 388 m/s
  const steadyTurn = 0.569 // 3.08 G / 225 m/s
  const deepTurn = 0.675 // 2.96 G / 204 m/s
  const hardPull = 0.71 // 5.92 G / 269 m/s

  it('levelFlightでは出ない', () => {
    expect(vortexStrength(levelFlight)).toBe(0)
  })

  it('fastPullでは出ない。荷重倍数が 3.39 でも揚力係数が低い', () => {
    expect(vortexStrength(fastPull)).toBe(0)
  })

  it('steadyTurnでは出る。荷重倍数 3.08 のほうが 3.39 より濃い', () => {
    expect(vortexStrength(steadyTurn)).toBeGreaterThan(0.4)
    expect(vortexStrength(steadyTurn)).toBeGreaterThan(vortexStrength(fastPull))
  })

  it('遅くdeepTurnのほうが濃い', () => {
    expect(vortexStrength(deepTurn)).toBeGreaterThan(vortexStrength(steadyTurn))
  })

  it('hardPullで濃くなる', () => {
    expect(vortexStrength(hardPull)).toBeGreaterThan(0.7)
  })

  it('0 から 1 に収まり、負の揚力でも対称に効く', () => {
    for (const cl of [-3, -1, -0.5, 0, 0.5, 1, 3]) {
      const value = vortexStrength(cl)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
      expect(value).toBe(vortexStrength(-cl))
    }
  })

  it('単調に増える', () => {
    let previous = vortexStrength(0)
    for (let i = 1; i <= 100; i++) {
      const value = vortexStrength(i / 100)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})
