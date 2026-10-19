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
  /**
   * 録画（lesson 2、コマ 8945〜9233）と同じ始まり（404 kt・高度 4,679 ft）で、0.25 秒右へ倒してから
   * 引き続ける。録画の SPEED の割合は 1.8 秒で 91%・5.8 秒で 65%・7.8 秒で 49%・9.6 秒で 29%、
   * 合格は各 ±10 ポイント（段 C2、ユーザーの決定）。高度は録画と同じく上がる（録画 +780 ft）
   */
  it('録画と同じ始まりで、速さの減り方が録画の ±10 ポイントの内', () => {
    const KT = 1.943844
    const script = {
      name: 'high-g-recording',
      seed: 1,
      spawn: { altitude: 1426, speed: 404 / KT },
      keyframes: [
        { frame: 0, input: { roll: 1 } },
        { frame: 30, input: { roll: 0, pitch: 1, highG: true } },
      ],
    } as unknown as ReplayScript
    const { world, player } = createWorldFromScript(script)
    const recorded: [number, number][] = [
      [1.8, 0.91],
      [5.8, 0.65],
      [7.8, 0.49],
      [9.6, 0.29],
    ]
    const v0 = world.player.speed
    const a0 = world.player.altitude
    let f = 0
    for (const [t, ratio] of recorded) {
      for (; f < 30 + Math.round(t * HZ); f++) world.step(player.at(f, world.player))
      expect(Math.abs(world.player.speed / v0 - ratio), `${t} 秒`).toBeLessThanOrEqual(0.1)
    }
    expect(world.player.altitude).toBeGreaterThan(a0)
    expect(world.player.crashed).toBe(false)
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
