import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { Enemy, ENEMY_INTEGRITY } from '@sim/enemy'
import { createAircraftSample } from '@sim/aircraft'
import { World } from '@sim/world'
import { neutralInput } from '@sim/input'
import type { Combatant } from '@sim/combatant'

/**
 * 敵機。
 *
 * この段では AI を載せていないので、見るのは 3 つ。トリムで置いた敵が
 * 直進を保つこと。撃たれる側の口が成立していること。**墜落を撃墜と同じに
 * 扱うこと。**AI を載せると自滅しうるので、その扱いを先に固めておく。
 */

const ORIGIN = new Vec3(0, 3000, 0)

function enemy(offset = new Vec3(0, 0, -300), speed = 250): Enemy {
  return new Enemy({ offset, speed }, ORIGIN)
}

/** dt で秒数ぶん進める。相手は自分自身（この段では読まれない） */
function run(e: Enemy, seconds: number): void {
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) e.step(FIXED_DT, e)
}

describe('Enemy', () => {
  it('Combatant を満たす', () => {
    const e: Combatant = enemy()
    expect(e.alive).toBe(true)
    expect(e.speed).toBeCloseTo(250, 6)
  })

  it('台本の相対位置に湧く', () => {
    const e = enemy(new Vec3(35, 12, -190))
    expect(e.position.x).toBeCloseTo(35, 6)
    expect(e.position.y).toBeCloseTo(3012, 6)
    expect(e.position.z).toBeCloseTo(-190, 6)
  })

  it('方位 0 では −Z へ、π では +Z へ進む', () => {
    const ahead = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    const back = new Enemy({ offset: new Vec3(), speed: 250, heading: Math.PI }, ORIGIN)
    expect(ahead.velocity.z).toBeCloseTo(-250, 4)
    expect(Math.abs(ahead.velocity.x)).toBeLessThan(1e-6)
    expect(back.velocity.z).toBeCloseTo(250, 4)
    expect(Math.abs(back.velocity.x)).toBeLessThan(1e-6)
  })

  it('方位 π/2 では +X（右）へ進む', () => {
    const right = new Enemy(
      { offset: new Vec3(), speed: 250, heading: Math.PI / 2 },
      ORIGIN,
    )
    expect(right.velocity.x).toBeCloseTo(250, 4)
    expect(Math.abs(right.velocity.z)).toBeLessThan(1e-6)
  })

  /**
   * トリムで置いたら 60 秒放っても高度と速度を保つ。
   *
   * **開始直後に沈むか浮くかすると、そのぶんだけ後の検証がぶれる。**
   * 実測で 60 秒後に高度 +3.793 m、速度 249.937 m/s。1 分で 3.8 m 浮き、
   * 速度は 0.063 m/s 落ちる
   */
  it('60 秒放っても水平飛行を保つ', () => {
    const e = enemy()
    const startAltitude = e.altitude
    run(e, 60)
    expect(e.altitude - startAltitude).toBeGreaterThan(-5)
    expect(e.altitude - startAltitude).toBeLessThan(5)
    expect(e.speed).toBeCloseTo(250, 0)
    expect(e.alive).toBe(true)
  })

  it('中立の舵から動かない', () => {
    const e = enemy()
    run(e, 10)
    const out = createAircraftSample()
    e.sample(1, out)
    expect(Math.abs(out.aileron)).toBeLessThan(1e-6)
    expect(Math.abs(out.rudder)).toBeLessThan(1e-6)
    expect(Math.abs(out.bank)).toBeLessThan(1e-4)
  })

  it('落ちた瞬間だけ true を返す', () => {
    const e = enemy()
    expect(e.damage(ENEMY_INTEGRITY - 1)).toBe(false)
    expect(e.damage(1)).toBe(true)
    // 落ちたあとの弾では二重に数えない
    expect(e.damage(1)).toBe(false)
    expect(e.alive).toBe(false)
  })

  /**
   * 墜落を撃墜と同じに扱う。
   *
   * AI が地面に当たったら、そこから先は的として数えない。地面より下へ
   * 置いて 1 ステップ回すと `Aircraft.crashed` が立つ。
   */
  it('墜落したら耐久が残っていても数に入らない', () => {
    // **海面ちょうど（高度 0）では落ちない。**トリムでは揚力が重量とつり合う
    // ので高度がわずかに正へ動き、`y <= floor` を満たさなくなる。海面より
    // 下へ置く
    const e = new Enemy({ offset: new Vec3(0, -3050, 0), speed: 250 }, ORIGIN)
    expect(e.altitude).toBeCloseTo(-50, 6)
    run(e, 1)
    expect(e.aircraft.crashed).toBe(true)
    expect(e.integrity).toBe(ENEMY_INTEGRITY)
    expect(e.alive).toBe(false)
    // 墜落したものへ当てても撃墜にしない
    expect(e.damage(ENEMY_INTEGRITY)).toBe(false)
  })
})

describe('World の敵機', () => {
  it('台本の enemies から作られ、combatants に並ぶ', () => {
    const w = new World({
      seed: 1,
      targets: [{ offset: new Vec3(0, 0, -500), speed: 240 }],
      enemies: [{ offset: new Vec3(0, 0, -800), speed: 250 }],
    })
    expect(w.targets.length).toBe(1)
    expect(w.enemies.length).toBe(1)
    // 標的が先、敵があと。ロックの添字がこの順で決まる
    expect(w.combatants.length).toBe(2)
    expect(w.combatants[0]).toBe(w.targets[0])
    expect(w.combatants[1]).toBe(w.enemies[0])
  })

  it('敵だけでもロックが立つ', () => {
    const w = new World({
      seed: 1,
      enemies: [{ offset: new Vec3(0, 0, -2000), speed: 240 }],
    })
    for (let i = 0; i < 120; i++) w.step(neutralInput())
    expect(w.combat.lock.state).toBe('locked')
    expect(w.combat.lockedTarget).toBe(w.enemies[0])
  })

  it('敵を撃墜すると数が減る', () => {
    const w = new World({
      seed: 1,
      enemies: [{ offset: new Vec3(0, 0, -2000), speed: 240 }],
    })
    expect(w.enemiesAlive).toBe(1)
    w.enemies[0]!.damage(ENEMY_INTEGRITY)
    expect(w.enemiesAlive).toBe(0)
  })

  it('同じシードと同じ台本から同じ結果になる', () => {
    const build = (): World =>
      new World({
        seed: 20260823,
        enemies: [{ offset: new Vec3(120, 30, -1500), speed: 245, heading: 0.4 }],
      })
    const a = build()
    const b = build()
    for (let i = 0; i < 600; i++) {
      a.step(neutralInput())
      b.step(neutralInput())
    }
    expect(a.enemies[0]!.position.x).toBe(b.enemies[0]!.position.x)
    expect(a.enemies[0]!.position.y).toBe(b.enemies[0]!.position.y)
    expect(a.enemies[0]!.position.z).toBe(b.enemies[0]!.position.z)
  })
})
