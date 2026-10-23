import { describe, it, expect } from 'vitest'
import { World, createWorldFromScript } from '@sim/world'
import { getScript } from '@sim/scripts'
import { Vec3 } from '@sim/vec3'
import { makeInput } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import { MISSILE_MAX_RANGE, lockingOn } from '@sim/ai/fighter'
import { Aircraft } from '@sim/aircraft'
import { Quat } from '@sim/quat'
import { Target } from '@sim/target'

/**
 * 敵機にロックされている（Phase 10 の宿題 2、HUD の WARNING）。
 *
 * 撃てる形で弾が残っていればロックとみる（ユーザーの決定、2026-10-23）。録画では、ミサイルが
 * 過ぎたあとも敵が後ろにいるあいだ WARNING が出ていた（lesson 5 のコマ 21432〜21482）
 */

const ALT = 3000
const trim = trimCondition(250, airDensity(ALT))

/** 自機の真後ろ `range` m に敵機を 1 機置く。敵は自機を追う */
function chased(range: number, missiles?: number): World {
  return new World({
    seed: 20260823,
    aircraft: {
      position: new Vec3(0, ALT, 0),
      velocity: new Vec3(0, 0, -250),
      throttle: trim.throttle,
    },
    enemies: [
      {
        offset: new Vec3(0, 0, range),
        speed: 250,
        ...(missiles !== undefined ? { missiles } : {}),
      },
    ],
  })
}

/** seconds 秒まっすぐ飛び、ロックの有無をフレームごとに返す */
function record(world: World, seconds: number): boolean[] {
  const out: boolean[] = []
  for (let i = 0; i < seconds * 120; i++) {
    world.step(makeInput({ throttle: trim.throttle }))
    out.push(world.lockWarning.active)
  }
  return out
}

describe('ロックの判定', () => {
  const origin = new Vec3(0, ALT, 0)
  const self = new Aircraft({
    position: origin.clone(),
    velocity: new Vec3(0, 0, -250),
    orientation: new Quat(),
  })
  const ahead = new Target({ offset: new Vec3(0, 0, -3000), speed: 250 }, origin)

  it('撃てる形で弾が残っていればロック', () => {
    expect(lockingOn('pursue', 2, self, ahead)).toBe(true)
    expect(lockingOn('attack', 1, self, ahead)).toBe(true)
  })

  it('弾が無ければロックしない', () => {
    expect(lockingOn('pursue', 0, self, ahead)).toBe(false)
  })

  it('立て直しと回避のあいだはロックしない', () => {
    expect(lockingOn('evade', 2, self, ahead)).toBe(false)
    expect(lockingOn('recover', 2, self, ahead)).toBe(false)
  })

  it('撃てない形（遠すぎる・機軸の外）ならロックしない', () => {
    const far = new Target({ offset: new Vec3(0, 0, -(MISSILE_MAX_RANGE + 500)), speed: 250 }, origin)
    const side = new Target({ offset: new Vec3(3000, 0, 0), speed: 250 }, origin)
    expect(lockingOn('pursue', 2, self, far)).toBe(false)
    expect(lockingOn('pursue', 2, self, side)).toBe(false)
  })
})

describe('World のロックの警告', () => {
  it('後ろ 3,000 m から追われると立ち、始まりのフレームを持つ', () => {
    const world = chased(3000)
    const log = record(world, 2)
    const first = log.indexOf(true)
    expect(first).toBeGreaterThanOrEqual(0)
    // 記録の i 番目は step を i + 1 回呼んだあと。始まりは進めたあとのフレーム番号
    expect(world.lockWarning.since).toBe(first + 1)
    expect(world.lockWarning.count).toBe(1)
  })

  it('撃ったあと、次に撃てるまでのあいだもロックが続く（録画の場面）', () => {
    const world = chased(3000)
    let firedAt = -1
    let lockedAfter = 0
    for (let i = 0; i < 5 * 120; i++) {
      world.step(makeInput({ throttle: trim.throttle }))
      if (firedAt < 0 && world.enemies[0]!.missilesFired > 0) firedAt = i
      else if (firedAt >= 0 && world.lockWarning.active) lockedAfter++
    }
    expect(firedAt).toBeGreaterThanOrEqual(0)
    expect(lockedAfter).toBeGreaterThan(120)
  })

  /** 台本 `lock-warning`。敵機はフレーム 1 からロックし続け、1 発目をフレアで外した f588 から WARNING だけになる */
  it('ミサイル警告が消えてロックが残れば、WARNING の始まりはその瞬間', () => {
    const { world, player } = createWorldFromScript(getScript('lock-warning'))
    let shownAt = -1
    for (let f = 0; f < 720 && shownAt < 0; f++) {
      world.step(player.at(f, world.player))
      if (world.frame > 30 && world.lockWarning.active && !world.combat.threat.active) shownAt = world.frame
    }
    expect(shownAt).toBe(588)
    expect(world.lockWarning.since).toBe(588)
  })

  it('弾を積んでいない敵機はロックしない', () => {
    expect(record(chased(3000, 0), 10)).not.toContain(true)
  })

  it('遠すぎる敵機はロックしない', () => {
    // 後ろ 8 km。同じ速さなので縮まらない
    expect(record(chased(8000), 3)).not.toContain(true)
  })

  it('自機が落ちたら消える', () => {
    const world = chased(2500)
    let dead = false
    for (let i = 0; i < 20 * 120 && !dead; i++) {
      world.step(makeInput({ throttle: trim.throttle }))
      dead = world.player.integrity <= 0
    }
    expect(dead).toBe(true)
    world.step(makeInput({ throttle: trim.throttle }))
    expect(world.lockWarning.active).toBe(false)
  })

  it('同じ入力からは同じ結果', () => {
    expect(record(chased(3000), 8)).toEqual(record(chased(3000), 8))
  })
})
