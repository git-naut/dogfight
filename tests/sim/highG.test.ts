import { describe, it, expect } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import type { ReplayScript } from '@sim/replay'

/**
 * ハイGターン（Phase 10 の段 B6、ADR 0028）。
 *
 * 録画（ACE COMBAT 7 の講座 lesson 2）では SPEED が約 10 秒で 404 → 116 に落ちる（29% が残る）。
 * 250 m/s・高度 3,000 m から約 90 度倒し、9.6 秒引き続けて速さの残りを比べる。
 * 曲がる速さの 1.4 倍は推測（録画から測れなかった）
 */

const HZ = 120

function run(highG: boolean, seconds: number): { ratio: number; turnedDeg: number } {
  const script = {
    name: 'high-g-probe',
    seed: 1,
    spawn: { altitude: 3000, speed: 250 },
    keyframes: [
      { frame: 0, input: { roll: 1 } },
      { frame: 48, input: { roll: 0, pitch: 1, highG } },
    ],
  } as unknown as ReplayScript
  const { world, player } = createWorldFromScript(script)
  for (let f = 0; f < 48; f++) world.step(player.at(f, world.player))
  const start = world.player.speed
  let turned = 0
  for (let f = 48; f < 48 + seconds * HZ; f++) {
    world.step(player.at(f, world.player))
    turned += Math.abs(world.player.angularVelocity.x) / HZ
  }
  expect(world.player.crashed).toBe(false)
  return { ratio: world.player.speed / start, turnedDeg: (turned * 180) / Math.PI }
}

describe('ハイGターン', () => {
  it('9.6 秒引き続けると速さが約 29% まで落ちる（録画は 10 秒で 29%）', () => {
    const { ratio } = run(true, 9.6)
    expect(ratio).toBeGreaterThan(0.25)
    expect(ratio).toBeLessThan(0.33)
  })

  it('普通の旋回は同じ条件で 7 割以上が残る', () => {
    expect(run(false, 9.6).ratio).toBeGreaterThan(0.7)
  })

  it('引き始めの 2 秒は普通の旋回より 1.4 倍以上よく回る', () => {
    const normal = run(false, 2).turnedDeg
    const high = run(true, 2).turnedDeg
    expect(high).toBeGreaterThan(normal * 1.4)
  })

  it('引いていなければ押しても効かない（速さが落ちない）', () => {
    const script = {
      name: 'high-g-idle',
      seed: 1,
      spawn: { altitude: 3000, speed: 250 },
      keyframes: [{ frame: 0, input: { highG: true } }],
    } as unknown as ReplayScript
    const { world, player } = createWorldFromScript(script)
    for (let f = 0; f < 2 * HZ; f++) world.step(player.at(f, world.player))
    expect(world.player.highGActive).toBe(false)
    expect(world.player.speed).toBeGreaterThan(240)
  })
})
