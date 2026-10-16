import { describe, expect, it } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'

/**
 * 自機の弾かミサイルが最後に当たったフレームと、最後に撃墜したフレーム（Phase 10 の段 B3）。
 * HUD の結果の帯（HIT・DESTROYED）に使う。`World.frame` の数え方で持つ
 */
describe('Combat.lastHitFrame・lastKillFrame', () => {
  it('missile-shot は撃墜したフレームで当たりと撃墜が同じになり、それまでは −1', () => {
    const { world, player } = createWorldFromScript(SCRIPTS['missile-shot'])
    let downAt = -1
    for (let f = 0; f < 900 && downAt < 0; f++) {
      expect(world.combat.lastKillFrame).toBe(-1)
      world.step(player.at(f, world.player))
      if (!world.combatants[0]!.alive) downAt = world.frame
    }
    expect(downAt).toBeGreaterThan(0)
    expect(world.combat.lastKillFrame).toBe(downAt)
    expect(world.combat.lastHitFrame).toBe(downAt)
  })
})
