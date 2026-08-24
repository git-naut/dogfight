import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { Rng } from '@sim/rng'
import { Enemy, ENEMY_INTEGRITY } from '@sim/enemy'
import { Target } from '@sim/target'
import { World } from '@sim/world'
import { makeInput } from '@sim/input'
import { defaultTerrain } from '@sim/terrain'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import {
  CONTROL_FLOOR,
  CONTROL_ONSET,
  DAMAGE_SMOKE_LENGTH,
  DAMAGE_SMOKE_STRIDE,
  EXHAUST_OFFSET,
  SMOKE_ONSET,
  damageControl,
  damageSmoke,
} from '@sim/damage'

/**
 * ダメージの表現。
 *
 * 耐久が減っても落ちるまで何も変わらないと、当てている実感が出ない。
 * 段階を持たせたので、**段が正しく効くことと、効いた結果で敵が自滅しない
 * ことの両方を見る。**舵の効きを落としすぎると、撃たれた敵が必ず墜落する。
 */

const ALT = 3000
const ORIGIN = new Vec3(0, ALT, 0)
const terrain = defaultTerrain()
const rng = new Rng(1)

describe('ダメージの段階', () => {
  it('6 割より上では煙が出ない', () => {
    expect(damageSmoke(1)).toBe(0)
    expect(damageSmoke(0.8)).toBe(0)
    expect(damageSmoke(SMOKE_ONSET)).toBe(0)
  })

  it('6 割を切ると煙が出始め、0 で最大になる', () => {
    expect(damageSmoke(SMOKE_ONSET - 0.01)).toBeGreaterThan(0)
    expect(damageSmoke(0.3)).toBeCloseTo(0.5, 6)
    expect(damageSmoke(0)).toBe(1)
  })

  it('煙は単調に増える。境界で跳ねない', () => {
    let previous = 0
    for (let i = 100; i >= 0; i--) {
      const value = damageSmoke(i / 100)
      expect(value).toBeGreaterThanOrEqual(previous)
      // 1% 刻みで 0.02 以上跳ばない
      expect(value - previous).toBeLessThan(0.02)
      previous = value
    }
  })

  it('3 割より上では舵の効きが落ちない', () => {
    expect(damageControl(1)).toBe(1)
    expect(damageControl(0.5)).toBe(1)
    expect(damageControl(CONTROL_ONSET)).toBe(1)
  })

  it('3 割を切ると効きが落ち、0 で下限になる', () => {
    expect(damageControl(CONTROL_ONSET - 0.01)).toBeLessThan(1)
    expect(damageControl(0)).toBe(CONTROL_FLOOR)
    expect(damageControl(CONTROL_ONSET / 2)).toBeCloseTo((1 + CONTROL_FLOOR) / 2, 6)
  })

  it('効きは 0 にしない。立て直しができなくなる', () => {
    expect(CONTROL_FLOOR).toBeGreaterThan(0.4)
    expect(CONTROL_FLOOR).toBeLessThan(1)
  })

  /**
   * 煙が先、効きの低下があと。
   *
   * **先に効きが落ちると、煙も出ていないのに動きが鈍って理由が分からない。**
   */
  it('煙が出てから効きが落ちる', () => {
    expect(SMOKE_ONSET).toBeGreaterThan(CONTROL_ONSET)
    // 4 割の時点では煙が出ていて効きはそのまま
    expect(damageSmoke(0.4)).toBeGreaterThan(0)
    expect(damageControl(0.4)).toBe(1)
  })
})

describe('敵機のダメージ', () => {
  function enemy(): Enemy {
    return new Enemy({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN, { terrain })
  }

  it('無傷では煙が出ない', () => {
    const e = enemy()
    expect(e.integrityRatio).toBe(1)
    expect(e.smokeStrength).toBe(0)
  })

  it('半分削ると煙が出る', () => {
    const e = enemy()
    e.damage(ENEMY_INTEGRITY / 2)
    expect(e.integrityRatio).toBeCloseTo(0.5, 6)
    expect(e.smokeStrength).toBeGreaterThan(0)
  })

  it('落ちたら煙を止める', () => {
    const e = enemy()
    e.damage(ENEMY_INTEGRITY)
    expect(e.alive).toBe(false)
    expect(e.smokeStrength).toBe(0)
  })

  it('傷が深いほど濃い', () => {
    const light = enemy()
    light.damage(ENEMY_INTEGRITY * 0.5)
    const heavy = enemy()
    heavy.damage(ENEMY_INTEGRITY * 0.9)
    expect(heavy.smokeStrength).toBeGreaterThan(light.smokeStrength)
  })

  it('傷が深いと舵の効きが落ちて旋回率が下がる', () => {
    // 同じ指令を与えて、向きの変化を比べる
    const measure = (damage: number): number => {
      const e = new Enemy({ offset: new Vec3(0, 0, 3000), speed: 250 }, ORIGIN, {
        terrain,
      })
      e.damage(damage)
      const target = new Target({ offset: new Vec3(2000, 0, 0), speed: 240 }, ORIGIN)
      const start = new Vec3().copy(e.velocity).multiplyScalar(1 / e.speed)
      for (let i = 0; i < 3 * 120; i++) e.step(FIXED_DT, target, rng)
      const end = new Vec3().copy(e.velocity).multiplyScalar(1 / e.speed)
      return Math.acos(Math.max(-1, Math.min(1, start.dot(end))))
    }
    const healthy = measure(0)
    const hurt = measure(ENEMY_INTEGRITY * 0.95)
    expect(hurt).toBeLessThan(healthy)
  })
})

describe('煙の履歴', () => {
  it('無傷でも記録する。濃さ 0 の点が並ぶ', () => {
    const e = new Enemy({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN, {
      terrain,
    })
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    for (let i = 0; i < 40; i++) e.step(FIXED_DT, target, rng)
    // 4 ステップごとに 1 本
    expect(e.smoke.trailLength).toBe(10)
    expect(e.smoke.trailPoint(0).smoke).toBe(0)
  })

  it('記録は排気口の位置。機体の後ろに出る', () => {
    const e = new Enemy({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN, {
      terrain,
    })
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    e.step(FIXED_DT, target, rng)
    const point = e.smoke.trailPoint(0).position
    // 機首は −Z、排気口は +Z 側。位置の差が EXHAUST_OFFSET の長さ
    expect(point.distanceTo(e.position)).toBeCloseTo(EXHAUST_OFFSET.length(), 3)
    expect(point.z).toBeGreaterThan(e.position.z)
  })

  it('傷ついてからの点だけ濃さを持つ', () => {
    const e = new Enemy({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN, {
      terrain,
    })
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    for (let i = 0; i < 40; i++) e.step(FIXED_DT, target, rng)
    e.damage(ENEMY_INTEGRITY * 0.7)
    for (let i = 0; i < 40; i++) e.step(FIXED_DT, target, rng)

    // 新しい側は濃く、古い側は 0
    expect(e.smoke.trailPoint(0).smoke).toBeGreaterThan(0)
    expect(e.smoke.trailPoint(e.smoke.trailLength - 1).smoke).toBe(0)
  })

  it('履歴の長さで頭打ちになる', () => {
    const e = new Enemy({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN, {
      terrain,
    })
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    const steps = (DAMAGE_SMOKE_LENGTH + 50) * DAMAGE_SMOKE_STRIDE
    for (let i = 0; i < steps; i++) e.step(FIXED_DT, target, rng)
    expect(e.smoke.trailLength).toBe(DAMAGE_SMOKE_LENGTH)
  })
})

/**
 * 傷ついた敵が自滅しない。
 *
 * **舵の効きを落としたぶんだけ立て直しが鈍る。**下限を下げすぎると、撃たれた
 * 敵が必ず墜落して撃墜と区別が付かなくなる。耐久を 1 まで削った状態で
 * 60 秒回して確かめる。
 */
describe('傷ついても自滅しない', () => {
  const cases = [
    { label: '3000 m / 耐久 1', alt: 3000, left: 1 },
    { label: '3000 m / 耐久 6', alt: 3000, left: 6 },
    { label: '1500 m / 耐久 1', alt: 1500, left: 1 },
    { label: '6000 m / 耐久 1', alt: 6000, left: 1 },
  ] as const

  it.each(cases)('$label で 60 秒回しても墜落しない', (item) => {
    const trim = trimCondition(250, airDensity(item.alt))
    const world = new World({
      seed: 20260823,
      aircraft: {
        position: new Vec3(0, item.alt, 0),
        velocity: new Vec3(0, 0, -250),
        throttle: trim.throttle,
      },
      enemies: [{ offset: new Vec3(600, 0, 1800), speed: 250 }],
    })
    const e = world.enemies[0]!
    e.damage(ENEMY_INTEGRITY - item.left)
    expect(e.alive).toBe(true)
    expect(damageControl(e.integrityRatio)).toBeLessThan(1)

    const input = makeInput({ throttle: trim.throttle })
    let minAgl = Infinity
    for (let i = 0; i < 60 * 120; i++) {
      world.step(input)
      if (e.alive) minAgl = Math.min(minAgl, e.aircraft.agl)
    }
    expect(e.aircraft.crashed, `最低対地 ${minAgl.toFixed(0)} m`).toBe(false)
    expect(minAgl, `最低対地 ${minAgl.toFixed(0)} m`).toBeGreaterThan(200)
  })
})
