import { describe, expect, it } from 'vitest'
import { AIRCRAFT_INTENSITY, exhaustIntensity } from '../../src/sim/combatant'
import { Aircraft } from '../../src/sim/aircraft'
import { Vec3 } from '../../src/sim/vec3'
import { Quat } from '../../src/sim/quat'

describe('排気の熱', () => {
  it('アフターバーナーを焚いていなければ 1、全開で 1.3', () => {
    // 期待値は固定の数で書く（定数から作ると、定数を壊したときに素通りする）
    expect(exhaustIntensity(0.5)).toBe(1)
    expect(exhaustIntensity(0.85)).toBe(1)
    expect(exhaustIntensity(1)).toBeCloseTo(1.3)
    expect(exhaustIntensity(0.925)).toBeCloseTo(1.15)
    expect(AIRCRAFT_INTENSITY).toBe(1)
  })

  it('機体の熱はエンジンのスロットルに従う', () => {
    const make = (throttle: number) =>
      new Aircraft({
        position: new Vec3(0, 3000, 0),
        velocity: new Vec3(0, 0, -250),
        orientation: new Quat(),
        throttle,
      })
    expect(make(0.5).intensity).toBe(1)
    expect(make(1).intensity).toBeCloseTo(1.3)
  })
})
