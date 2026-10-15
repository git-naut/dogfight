import { describe, expect, it } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'

/**
 * ミサイル警告の出始めのフレーム（Phase 10 の段 B2）。HUD の MISSILE ALERT の点滅の位相を、
 * 出た瞬間が「点いている」になるよう合わせるのに使う。`Combat` が書く
 */
describe('MissileThreat.since', () => {
  it('警告が出た最初のフレームを持ち、出ているあいだは変えない', () => {
    const { world, player } = createWorldFromScript(SCRIPTS['enemy-missile'])
    let first = -1
    for (let f = 0; f < 600; f++) {
      world.step(player.at(f, world.player))
      const t = world.combat.threat
      if (t.active && first < 0) first = world.frame
      if (first >= 0 && t.active) expect(t.since, `f${world.frame}`).toBe(first)
    }
    expect(first).toBeGreaterThan(0)
  })
})
