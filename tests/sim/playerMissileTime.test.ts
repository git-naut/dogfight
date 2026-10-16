import { describe, expect, it } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import { Vec3 } from '@sim/vec3'

/**
 * 自機のミサイルの速さ（Phase 10 の段 B3b）。録画（ACE COMBAT 7 の講座 lesson 5、コマ 20027 → 20091）
 * では距離の表示 2,025 の敵に発射から命中まで 2.13 秒。距離の単位は ft とみなした（ユーザーの決定、
 * 617 m）。録画の 2.13 秒はミサイルが画面に入ったコマから数えたので、発射からはもう少し長い
 */
const HZ = 120

function flightSeconds(distance: number): number {
  const script = {
    name: 'player-missile-time',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 0, -distance), speed: 240 }],
    keyframes: [
      { frame: HZ, input: { fireMissile: true } },
      { frame: HZ + 1, input: { fireMissile: false } },
    ],
  }
  const { world, player } = createWorldFromScript(script as never)
  let launch = -1
  for (let f = 0; f < 30 * HZ; f++) {
    world.step(player.at(f, world.player))
    if (launch < 0 && world.combat.missilesInFlight > 0) launch = world.frame
    if (!world.combatants[0]!.alive) return (world.frame - launch) / HZ
  }
  return Infinity
}

describe('自機のミサイルの速さ', () => {
  it('617 m 先の同じ向きに逃げる的に、発射から撃墜まで 2.0〜2.3 秒（録画 2.13 秒）', () => {
    const t = flightSeconds(617)
    expect(t).toBeGreaterThanOrEqual(2.0)
    expect(t).toBeLessThanOrEqual(2.3)
  })
})
