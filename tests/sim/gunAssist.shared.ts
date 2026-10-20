import { Vec3 } from '@sim/vec3'
import { createWorldFromScript } from '@sim/world'

/** 500 m 前で右へ旋回する標的に、自機は真っすぐ飛んで 1.5 秒撃つ。当たった数と、吸い付いていたステップ数 */
export function crossingHits(turnRate: number): { hits: number; snapped: number } {
  const script = {
    name: 'gun-assist',
    seed: 20261020,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 0, -500), speed: 250, turnRate }],
    keyframes: [
      { frame: 0, input: { fireGun: true } },
      { frame: 180, input: { fireGun: false } },
    ],
  }
  const { world, player } = createWorldFromScript(script as never)
  let snapped = 0
  for (let f = 0; f < 300; f++) {
    world.step(player.at(f, world.player))
    if (world.combat.gunSnapped) snapped++
  }
  return { hits: world.combat.hits, snapped }
}
