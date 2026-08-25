import { describe, it, expect } from 'vitest'
import { World } from '@sim/world'
import { Vec3 } from '@sim/vec3'
import { makeInput } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import {
  ENEMY_MISSILE_COUNT,
  MISSILE_CONE,
  MISSILE_INTERVAL_SECONDS,
  MISSILE_MAX_RANGE,
  MISSILE_MIN_RANGE,
  boresightError,
  missileShotReady,
} from '@sim/ai/fighter'
import { Aircraft } from '@sim/aircraft'
import { Quat } from '@sim/quat'
import { Target } from '@sim/target'

/**
 * 敵がミサイルを撃つ。
 *
 * **弾の物理は `Combat` の 1 か所に置く。**機銃と同じ規約
 * （`docs/decisions/0007-enemy.md`）。`Enemy` は器を選んで初期条件を
 * 与えるだけで、進めるのも当たり判定も `Combat` の仕事。
 *
 * ミサイルは 1 発で落とせる（ダメージ 100 に対し耐久 60）。**だから
 * フレアが要る。**避けられなければ、まっすぐ飛んでいて突然落ちる。
 */

const ALT = 3000
const trim = trimCondition(250, airDensity(ALT))

function engagement(range: number, missiles?: number): World {
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

/** flareAt 秒でフレアを 1 回出す。null なら出さない */
function fly(world: World, seconds: number, flareAt: number | null = null): void {
  for (let i = 0; i < seconds * 120; i++) {
    const t = i / 120
    const deploy = flareAt !== null && t >= flareAt && t < flareAt + 2 / 120
    world.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
  }
}

/** 自機が落ちるまでの秒。落ちなければ Infinity */
function survivalSeconds(world: World, seconds: number, flareAt: number | null): number {
  for (let i = 0; i < seconds * 120; i++) {
    const t = i / 120
    const deploy = flareAt !== null && t >= flareAt && t < flareAt + 2 / 120
    world.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
    if (world.player.integrity <= 0) return t
  }
  return Infinity
}

describe('発射の条件', () => {
  function craft(position: Vec3, heading = 0): Aircraft {
    const orientation = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), -heading)
    const velocity = new Vec3()
    orientation.forward(velocity)
    velocity.multiplyScalar(250)
    return new Aircraft({ position, velocity, orientation })
  }

  const origin = new Vec3(0, ALT, 0)

  it('間合いの内側で機軸が合っていれば撃つ', () => {
    const self = craft(origin)
    const target = new Target({ offset: new Vec3(0, 0, -3000), speed: 250 }, origin)
    expect(missileShotReady(self, target)).toBe(true)
  })

  /** 近すぎると安全解除（0.5 秒）の前に相手を追い越す */
  it('近すぎたら撃たない', () => {
    const self = craft(origin)
    const target = new Target(
      { offset: new Vec3(0, 0, -(MISSILE_MIN_RANGE - 100)), speed: 250 },
      origin,
    )
    expect(missileShotReady(self, target)).toBe(false)
  })

  /** 遠すぎると燃焼が終わってから届く */
  it('遠すぎたら撃たない', () => {
    const self = craft(origin)
    const target = new Target(
      { offset: new Vec3(0, 0, -(MISSILE_MAX_RANGE + 100)), speed: 250 },
      origin,
    )
    expect(missileShotReady(self, target)).toBe(false)
  })

  it('機軸から外れていたら撃たない', () => {
    const self = craft(origin)
    // 真横。機軸から 90 度
    const target = new Target({ offset: new Vec3(3000, 0, 0), speed: 250 }, origin)
    expect(missileShotReady(self, target)).toBe(false)
  })

  /**
   * **機銃より許容角が広い。**ミサイルは撃ったあと自分で曲がるので、機首が
   * 正確に乗っている必要がない。機銃は 2 度、ミサイルは 20 度。
   */
  it('許容角は機銃より広い', () => {
    const self = craft(origin)
    const rad = (15 * Math.PI) / 180
    const target = new Target(
      {
        offset: new Vec3(Math.sin(rad) * 3000, 0, -Math.cos(rad) * 3000),
        speed: 250,
      },
      origin,
    )
    expect(boresightError(self, target)).toBeLessThan(MISSILE_CONE)
    expect(missileShotReady(self, target)).toBe(true)
  })

  it('落ちた相手には撃たない', () => {
    const self = craft(origin)
    const target = new Target({ offset: new Vec3(0, 0, -3000), speed: 250 }, origin)
    target.damage(1000)
    expect(missileShotReady(self, target)).toBe(false)
  })
})

describe('敵の発射', () => {
  it('間合いに入れば撃つ', () => {
    const w = engagement(3000)
    fly(w, 3)
    expect(w.enemies[0]!.missilesFired).toBeGreaterThan(0)
  })

  it('積んでいる数を超えて撃たない', () => {
    const w = engagement(3000)
    fly(w, 60)
    const e = w.enemies[0]!
    expect(e.missilesFired).toBeLessThanOrEqual(ENEMY_MISSILE_COUNT)
    expect(e.missilesLeft).toBe(ENEMY_MISSILE_COUNT - e.missilesFired)
  })

  /** 間隔を空ける。連射させると 2 発が同時に飛んで避けようがない */
  it('間隔を空けて撃つ', () => {
    const w = engagement(3000)
    // 1 発目のあと、間隔より短い時間では 2 発目が出ない
    fly(w, MISSILE_INTERVAL_SECONDS - 1)
    expect(w.enemies[0]!.missilesFired).toBe(1)
  })

  it('積まない指定なら撃たない', () => {
    const w = engagement(3000, 0)
    fly(w, 30)
    expect(w.enemies[0]!.missilesFired).toBe(0)
  })

  /**
   * **自機が落ちる。**ダメージ 100 に対し耐久 60 なので 1 発で落ちる。
   * 実測で 1,500 m から 5.2 秒、4,000 m から 10.4 秒。
   */
  it('当たれば自機が落ちる', () => {
    const w = engagement(2500)
    const dead = survivalSeconds(w, 20, null)
    expect(dead).toBeLessThan(20)
    expect(w.combat.taken).toBeGreaterThan(0)
  })
})

/**
 * フレアで避けられる。
 *
 * **これが Phase 6.5 の主題。**ミサイルは 1 発で落とすので、避ける手段が
 * ないと「まっすぐ飛んでいて突然落ちる」になる。
 *
 * 実測で、着弾の 3 秒前から 0.5 秒前までのどこで出しても避けられる。
 * そのあとは敵の機銃で削られるので、落ちる時刻は延びるだけ。
 */
describe('フレアで避ける', () => {
  it.each([
    { range: 1500, hitAt: 5.2 },
    { range: 2500, hitAt: 7.1 },
    { range: 4000, hitAt: 10.4 },
  ])('$range m・着弾 $hitAt 秒。その 1 秒前に出せば避けられる', ({ range, hitAt }) => {
    const without = survivalSeconds(engagement(range), 30, null)
    const with_ = survivalSeconds(engagement(range), 30, hitAt - 1)
    expect(without).toBeLessThan(hitAt + 1)
    // 落ちる時刻が延びる。ミサイルは避けたが機銃では削られる
    expect(with_).toBeGreaterThan(without + 2)
  })

  it('出したフレアは消費される', () => {
    const w = engagement(2500)
    fly(w, 6, 5)
    expect(w.countermeasures.deployed).toBeGreaterThan(0)
    expect(w.countermeasures.left).toBeLessThan(30)
  })

  /**
   * **敵はフレアを持たない**（Phase 6.5 の範囲）。自機のミサイルには囮を
   * 渡していないので、自分の撒いたフレアに引っかからない。
   *
   * 敵を前方に置いてロックさせる。後方の相手はシーカーの捕捉角
   * （20 度）に入らないので撃てない。
   */
  it('自分の撒いたフレアで自分のミサイルが逸れない', () => {
    const w = new World({
      seed: 20260823,
      aircraft: {
        position: new Vec3(0, ALT, 0),
        velocity: new Vec3(0, 0, -250),
        throttle: trim.throttle,
      },
      // 前方 3,000 m。機銃だけの敵にして、こちらが撃つ側になる
      enemies: [{ offset: new Vec3(0, 0, -3000), speed: 250, missiles: 0 }],
    })
    for (let i = 0; i < 20 * 120; i++) {
      const t = i / 120
      w.step(
        makeInput({
          throttle: trim.throttle,
          // ロックが立つまで待ってから撃つ
          fireMissile: t > 2 && t < 2.1,
          deployFlare: t > 1 && t < 1.1,
        }),
      )
    }
    expect(w.countermeasures.deployed).toBeGreaterThan(0)
    expect(w.combat.missilesFired).toBeGreaterThan(0)
    // 自分のフレアを掴んでいない
    for (const missile of w.combat.missiles) {
      const tracked = missile.tracked
      if (tracked === null) continue
      expect(w.countermeasures.flares).not.toContain(tracked)
    }
  })
})

describe('決定論', () => {
  it('同じ入力からは同じ結果', () => {
    const a = survivalSeconds(engagement(2500), 20, 6)
    const b = survivalSeconds(engagement(2500), 20, 6)
    expect(a).toBe(b)
  })
})
