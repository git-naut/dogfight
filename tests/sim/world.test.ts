import { describe, it, expect } from 'vitest'
import { World, neutralInput } from '@sim/world'
import { FIXED_DT } from '@sim/loop'

describe('World', () => {
  it('step ごとに frame が 1 増える', () => {
    const world = new World({ seed: 1 })
    const input = neutralInput()
    expect(world.frame).toBe(0)
    world.step(input)
    world.step(input)
    expect(world.frame).toBe(2)
  })

  it('time は frame から計算され、誤差が蓄積しない', () => {
    const world = new World({ seed: 1 })
    const input = neutralInput()
    const steps = 120 * 600 // 10 分相当

    for (let i = 0; i < steps; i++) world.step(input)

    // time += dt で積算していたらここで誤差が乗る。
    // frame * dt なら掛け算 1 回なので厳密に一致する。
    expect(world.time).toBe(steps * FIXED_DT)
    expect(world.time).toBeCloseTo(600, 9)
  })

  it('同じシードの World は同じ乱数状態をたどる', () => {
    const a = new World({ seed: 4242 })
    const b = new World({ seed: 4242 })
    for (let i = 0; i < 500; i++) {
      expect(a.rng.next()).toBe(b.rng.next())
    }
    expect(a.rng.snapshot).toBe(b.rng.snapshot)
  })

  it('neutralInput は舵中立・スロットル中間で返る', () => {
    const input = neutralInput()
    expect(input.pitch).toBe(0)
    expect(input.roll).toBe(0)
    expect(input.yaw).toBe(0)
    expect(input.throttle).toBe(0.5)
    expect(input.fireGun).toBe(false)
    expect(input.fireMissile).toBe(false)
  })
})
