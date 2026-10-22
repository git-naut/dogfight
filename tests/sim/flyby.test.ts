import { describe, expect, it } from 'vitest'
import { FlybyTracker } from '@sim/flyby'
import { createWorldFromScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'

/** すれ違いの判定（段 B11d、ADR 0040） */
describe('すれ違いの判定', () => {
  it('300 m の内で近づくから遠ざかるに変わったとき 1 回だけ', () => {
    const t = new FlybyTracker()
    const distances = [1000, 600, 250, 80, 120, 400, 900]
    const hits = distances.map((d, i) => t.update(0, d, i * 0.1))
    expect(hits).toEqual([false, false, false, false, true, false, false])
  })

  it('いちばん近づいても 300 m の外なら鳴らさない', () => {
    const t = new FlybyTracker()
    const hits = [1000, 600, 350, 320, 340, 600].map((d, i) => t.update(0, d, i * 0.1))
    expect(hits.some(Boolean)).toBe(false)
  })

  it('同じ相手は 5 秒あける。別の相手は別に数える', () => {
    const t = new FlybyTracker()
    const pass = (id: number, start: number) =>
      [500, 100, 200].map((d, i) => t.update(id, d, start + i * 0.1)).some(Boolean)
    expect(pass(0, 0)).toBe(true)
    expect(pass(0, 1)).toBe(false)
    expect(pass(1, 1)).toBe(true)
    expect(pass(0, 6)).toBe(true)
  })
})

describe('World のすれ違いの数', () => {
  function run(name: string, frames: number) {
    const { world, player } = createWorldFromScript(SCRIPTS[name as keyof typeof SCRIPTS]!)
    for (let f = 0; f < frames; f++) world.step(player.at(f, world.player))
    return world
  }

  // enemy-ahead は前方の敵機に 163.9 m まで近づき（フレーム 299）、そのあと離れる
  it('enemy-ahead はフレーム 299 ですれ違い、1 回だけ数える', () => {
    expect(run('enemy-ahead', 240).flybyCount).toBe(0)
    const world = run('enemy-ahead', 360)
    expect(world.flybyCount).toBe(1)
    expect(world.lastFlybyEnemy).toBe(0)
  })

  it('敵機のいない level では数えない', () => {
    expect(run('level', 600).flybyCount).toBe(0)
  })
})
