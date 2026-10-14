import { describe, it, expect } from 'vitest'
import { APPROACH, FLAP_LIFT_COEFFICIENT, AIRCRAFT, liftCoefficient, trimCondition } from '@sim/flightModel'
import { SEA_LEVEL_DENSITY } from '@sim/isa'
import { World, worldOptionsFromScript, createWorldFromScript } from '@sim/world'
import { getScript } from '@sim/scripts'
import { makeInput } from '@sim/input'
import { DESIGN_ENVELOPE, judgeTouchdown } from '@sim/deckContact'

/**
 * フラップ（Phase 9、段 7 と段 8 のあいだ、2026-10-14）。
 *
 * **脚と一緒に動く**（G で両方）。下ろし切ると、進入の状態（迎角 8.1 度＝AIAA 2016-1770 PDF 3 頁、
 * 速さ 130 kt＝AOPA 2017）で水平に飛べるだけの揚力を足す。揚力の増分の一次資料は無く、
 * そこから逆算している（ADR 0019）
 */
const DEG = Math.PI / 180

describe('揚力の増分', () => {
  it('進入の迎角 8.1 度・130 kt で、海面で水平に飛べる大きさ', () => {
    expect(APPROACH.alpha / DEG).toBeCloseTo(8.1, 9)
    expect(APPROACH.speed).toBeCloseTo(130 * 0.514444, 9)
    const t = trimCondition(APPROACH.speed, SEA_LEVEL_DENSITY, 1)
    expect(t.alpha / DEG).toBeCloseTo(8.1, 6)
    // 実測 1.0507。迎角 8.1 度の素の揚力 0.566 に足して CL 1.617
    expect(FLAP_LIFT_COEFFICIENT).toBeCloseTo(1.0507, 3)
    expect(liftCoefficient(APPROACH.alpha) + FLAP_LIFT_COEFFICIENT).toBeCloseTo(
      (AIRCRAFT.mass * 9.80665) / (0.5 * SEA_LEVEL_DENSITY * APPROACH.speed ** 2 * AIRCRAFT.wingArea),
      6,
    )
  })

  it('フラップなしでは 130 kt で迎角 22.5 度（尾部が甲板に当たる）。だから要る', () => {
    expect(trimCondition(APPROACH.speed, SEA_LEVEL_DENSITY, 0).alpha / DEG).toBeCloseTo(22.5, 1)
  })

  /**
   * **進入角 3.5 度で降りると機首は約 4.6 度**（迎角 8.1 − 3.5）。構造設計の範囲の内側に、
   * 機首方向で十分な余裕がある（降下率 13.65 ft/s のとき、範囲は −3.1〜12.3 度）
   */
  it('進入の機首の角度は構造設計の範囲の内側', () => {
    const pitch = APPROACH.alpha - 3.5 * DEG
    expect(pitch / DEG).toBeCloseTo(4.6, 6)
    expect(judgeTouchdown(13.65 * 0.3048, pitch, 0)).toBeNull()
    expect(DESIGN_ENVELOPE.length).toBeGreaterThan(10)
  })
})

describe('脚と一緒に動く', () => {
  it('脚を出して 130 kt で始めると、迎角 8.1 度で高度を保つ', () => {
    const world = new World(
      worldOptionsFromScript({
        name: 'flap-level',
        seed: 1,
        spawn: { altitude: 50, speed: APPROACH.speed, gearDown: true },
        keyframes: [],
      }),
    )
    const y0 = world.player.position.y
    expect(world.player.angleOfAttack / DEG).toBeCloseTo(8.1, 0)
    for (let i = 0; i < 120; i++) world.step(makeInput({ throttle: world.player.throttle }))
    expect(Math.abs(world.player.position.y - y0)).toBeLessThan(3)
  })

  it('脚を上げるとフラップも上がり、同じ速さでは揚力が足りず沈む', () => {
    const world = new World(
      worldOptionsFromScript({
        name: 'flap-up',
        seed: 1,
        spawn: { altitude: 300, speed: APPROACH.speed, gearDown: true },
        keyframes: [],
      }),
    )
    const y0 = world.player.position.y
    world.step(makeInput({ gearToggle: true }))
    for (let i = 0; i < 700; i++) world.step(makeInput({ throttle: world.player.throttle }))
    expect(world.player.gearPosition).toBe(0)
    expect(world.player.position.y).toBeLessThan(y0 - 5)
  })
})

/**
 * 射出もフラップを下ろしたまま（ユーザーの判断）。終点からすぐ浮き、f348 に甲板を離れて沈まない。
 * f3000 の高度は 360.6 m から 424.8 m に上がった（実測）
 */
describe('射出', () => {
  it('射出の台本は射出の終点より下へ沈まず、f3000 で 400 m を超える', () => {
    const { world, player } = createWorldFromScript(getScript('catapult-launch'))
    let min = Infinity
    for (let i = 0; i < 3000; i++) {
      world.step(player.at(i))
      if (world.catapult?.phase === 'airborne') min = Math.min(min, world.player.position.y)
    }
    expect(min).toBeGreaterThan(20.5)
    expect(world.player.position.y).toBeGreaterThan(400)
    expect(world.player.crashed).toBe(false)
  })
})
