import { describe, it, expect } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import { autopilotCommand, AUTOPILOT_OVERRIDE } from '@sim/autopilot'
import { Vec3 } from '@sim/vec3'
import type { ReplayScript } from '@sim/replay'

/**
 * オートパイロット（Phase 10 の段 B6、ADR 0028）。録画（lesson 2）ではヨーの 2 つのボタンを
 * 同時に押すと機体が水平に戻り、照準の下に AUTO PILOT が出る。こちらは Q と E の同時押し
 */

const HZ = 120
const DEG = Math.PI / 180

function attitude(world: ReturnType<typeof createWorldFromScript>['world']): { bank: number; climb: number } {
  const right = new Vec3()
  const up = new Vec3()
  world.player.orientation.right(right)
  world.player.orientation.up(up)
  const v = world.player.velocity
  return {
    bank: Math.atan2(-right.y, up.y) / DEG,
    climb: Math.asin(v.y / v.length()) / DEG,
  }
}

/** 0.4 秒右へ倒して少し引き、frame 60 で入れる。あとは手を離す */
function engaged(extra: ReplayScript['keyframes'] = []): ReturnType<typeof createWorldFromScript> {
  const script = {
    name: 'autopilot-probe',
    seed: 1,
    spawn: { altitude: 3000, speed: 250 },
    keyframes: [
      { frame: 0, input: { roll: 1, pitch: 0.5 } },
      { frame: 48, input: { roll: 0, pitch: 0 } },
      { frame: 60, input: { autopilot: true } },
      { frame: 61, input: { autopilot: false } },
      ...extra,
    ],
  } as unknown as ReplayScript
  return createWorldFromScript(script)
}

describe('autopilotCommand', () => {
  it('右へ傾いていれば左へ戻し、上り坂なら押す', () => {
    const c = autopilotCommand(20 * DEG, 5 * DEG)
    expect(c.roll).toBeLessThan(0)
    expect(c.pitch).toBeLessThan(0)
  })

  it('大きく傾いているあいだは引かない', () => {
    expect(autopilotCommand(80 * DEG, -10 * DEG).pitch).toBe(0)
  })

  it('水平なら何もしない', () => {
    const c = autopilotCommand(0, 0)
    expect(Math.abs(c.roll)).toBe(0)
    expect(Math.abs(c.pitch)).toBe(0)
  })
})

describe('オートパイロット', () => {
  it('押すと入り、5 秒で翼が水平・機首が水平線に戻る', () => {
    const { world, player } = engaged()
    for (let f = 0; f < 60; f++) world.step(player.at(f, world.player))
    const before = attitude(world)
    expect(Math.abs(before.bank)).toBeGreaterThan(30)
    for (let f = 60; f < 60 + 5 * HZ; f++) world.step(player.at(f, world.player))
    expect(world.player.autopilot).toBe(true)
    const after = attitude(world)
    expect(Math.abs(after.bank)).toBeLessThan(3)
    expect(Math.abs(after.climb)).toBeLessThan(3)
  })

  it('押さなければ傾いたまま', () => {
    const script = {
      name: 'autopilot-off',
      seed: 1,
      spawn: { altitude: 3000, speed: 250 },
      keyframes: [
        { frame: 0, input: { roll: 1, pitch: 0.5 } },
        { frame: 48, input: { roll: 0, pitch: 0 } },
      ],
    } as unknown as ReplayScript
    const { world, player } = createWorldFromScript(script)
    for (let f = 0; f < 60 + 5 * HZ; f++) world.step(player.at(f, world.player))
    expect(world.player.autopilot).toBe(false)
    expect(Math.abs(attitude(world).bank)).toBeGreaterThan(30)
  })

  it(`ロールかピッチを ${AUTOPILOT_OVERRIDE} を超えて入れると切れる`, () => {
    const { world, player } = engaged([
      { frame: 120, input: { pitch: 0.5 } },
      { frame: 121, input: { pitch: 0 } },
    ])
    for (let f = 0; f < 120; f++) world.step(player.at(f, world.player))
    expect(world.player.autopilot).toBe(true)
    world.step(player.at(120, world.player))
    expect(world.player.autopilot).toBe(false)
  })

  it('押し続けても入れ直しにならない（押した瞬間だけ）', () => {
    const { world, player } = engaged([
      { frame: 100, input: { autopilot: true, roll: 0.5 } },
    ])
    for (let f = 0; f < 101; f++) world.step(player.at(f, world.player))
    expect(world.player.autopilot).toBe(false)
    for (let f = 101; f < 140; f++) world.step(player.at(f, world.player))
    expect(world.player.autopilot).toBe(false)
  })
})
