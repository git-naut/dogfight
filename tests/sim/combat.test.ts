import { describe, it, expect } from 'vitest'
import { createWorldFromScript, runScript, World } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'
import { TARGET_INTEGRITY } from '@sim/target'
import { MAGAZINE, ROUNDS_PER_SECOND } from '@sim/weapons/gun'
import { makeInput } from '@sim/input'
import { FIXED_DT } from '@sim/loop'
import { Vec3 } from '@sim/vec3'

/**
 * 交戦。
 *
 * 台本を通した検証。**「当たる」だけでなく「狙わないと当たらない」ことも
 * 見る。**当たり判定を太らせすぎていないことの歯止めになる。
 */

const SEC = 120

describe('gun-pass — 機銃で標的を落とす', () => {
  it('0.5 秒で 50 発撃って 19 発当たる', () => {
    const w = runScript(SCRIPTS['gun-pass'], SEC * 0.5)
    expect(w.combat.roundsFired).toBe(50)
    expect(w.combat.hits).toBe(19)
  })

  it('1 秒以内に撃墜できる', () => {
    const w = runScript(SCRIPTS['gun-pass'], SEC * 1)
    expect(w.combat.kills).toBe(1)
    expect(w.targets[0]!.alive).toBe(false)
    expect(w.targets[0]!.integrity).toBeLessThanOrEqual(0)
  })

  it('撃墜に要る命中は耐久ぶん。それ以上は数えない', () => {
    const w = runScript(SCRIPTS['gun-pass'], SEC * 5)
    // 落ちたあとの弾は当たらないので、命中は耐久で止まる
    expect(w.combat.hits).toBe(TARGET_INTEGRITY)
    expect(w.combat.kills).toBe(1)
  })

  it('撃った弾より多くは当たらない。貫通させていない', () => {
    for (const sec of [0.5, 1, 2, 5]) {
      const w = runScript(SCRIPTS['gun-pass'], SEC * sec)
      expect(w.combat.hits, `${sec} 秒`).toBeLessThanOrEqual(w.combat.roundsFired)
    }
  })

  it('残弾が減る', () => {
    const w = runScript(SCRIPTS['gun-pass'], SEC * 2)
    expect(w.combat.rounds).toBe(MAGAZINE - 200)
  })

  it('2 回再生しても命中数が一致する', () => {
    const a = runScript(SCRIPTS['gun-pass'], SEC * 3)
    const b = runScript(SCRIPTS['gun-pass'], SEC * 3)
    expect(a.combat.hits).toBe(b.combat.hits)
    expect(a.combat.kills).toBe(b.combat.kills)
    expect(a.combat.roundsFired).toBe(b.combat.roundsFired)
  })
})

describe('狙わないと当たらない', () => {
  it('引き金を引かなければ 1 発も出ない', () => {
    const w = runScript(SCRIPTS['target-ahead'], SEC * 5)
    expect(w.combat.roundsFired).toBe(0)
    expect(w.combat.hits).toBe(0)
    expect(w.targets[0]!.alive).toBe(true)
  })

  it('標的がいなければ当たらない', () => {
    const world = new World({ seed: 1 })
    const input = makeInput({ fireGun: true })
    for (let i = 0; i < SEC * 2; i++) world.step(input)
    expect(world.combat.roundsFired).toBe(200)
    expect(world.combat.hits).toBe(0)
  })

  it('狙いが 30 m 高いと当たらない', () => {
    // gun-pass の標的を 30 m 上へずらす。同じ 3 秒で 1 発も当たらない
    const world = new World({
      seed: 20260816,
      aircraft: { position: new Vec3(0, 3000, 0), velocity: new Vec3(0, 0, -250) },
      targets: [{ offset: new Vec3(0, 41, -300), speed: 245 }],
    })
    const input = makeInput({ fireGun: true, throttle: 0.255 })
    for (let i = 0; i < SEC * 3; i++) world.step(input)
    expect(world.combat.roundsFired).toBeGreaterThan(250)
    expect(world.combat.hits).toBe(0)
  })
})

describe('発射管制', () => {
  it('墜落したら撃てない', () => {
    // 低空から地面へ突っ込ませながら引き金を引く
    const world = new World({
      seed: 1,
      aircraft: { position: new Vec3(0, 60, 0), velocity: new Vec3(0, -120, 0) },
    })
    const input = makeInput({ fireGun: true })
    for (let i = 0; i < SEC * 2; i++) world.step(input)
    expect(world.player.crashed).toBe(true)
    const afterCrash = world.combat.roundsFired
    for (let i = 0; i < SEC; i++) world.step(input)
    expect(world.combat.roundsFired).toBe(afterCrash)
  })

  it('引き金を離したら弾が増えない', () => {
    const { world, player } = createWorldFromScript(SCRIPTS['gun-pass'])
    for (let i = 0; i < SEC; i++) world.step(player.at(i))
    const fired = world.combat.roundsFired
    const idle = makeInput({ throttle: 0.255 })
    for (let i = 0; i < SEC; i++) world.step(idle)
    expect(world.combat.roundsFired).toBe(fired)
  })

  it('発射速度が 100 発/秒。ワールド越しでも変わらない', () => {
    const world = new World({ seed: 1 })
    const input = makeInput({ fireGun: true })
    for (let i = 0; i < SEC; i++) world.step(input)
    expect(world.combat.roundsFired).toBe(ROUNDS_PER_SECOND)
  })

  it('弾は寿命で消える。飛行中の数が上限で止まる', () => {
    const world = new World({ seed: 1 })
    const input = makeInput({ fireGun: true })
    for (let i = 0; i < SEC * 5; i++) world.step(input)
    // 寿命 2.5 秒 × 100 発/秒 = 250 発が定常。ステップ内は advance で数え直した
    // あとに fire が足すので、250 + そのステップの発射ぶんまで振れる
    expect(world.combat.bulletsInFlight).toBeLessThanOrEqual(253)
    expect(world.combat.bulletsInFlight).toBeGreaterThan(245)
  })
})

describe('弾を読む口', () => {
  it('プールの大きさと中身が読める', () => {
    const world = new World({ seed: 1 })
    const input = makeInput({ fireGun: true })
    for (let i = 0; i < 60; i++) world.step(input)

    const bullets = world.combat.bullets
    expect(bullets.bulletCapacity).toBeGreaterThan(250)
    let live = 0
    for (let i = 0; i < bullets.bulletCapacity; i++) {
      if (bullets.bulletAt(i).life > 0) live++
    }
    expect(live).toBe(bullets.bulletsInFlight)
    expect(live).toBeGreaterThan(40)
  })

  it('前ステップの位置が入っている。掃引に使う', () => {
    const world = new World({ seed: 1 })
    const input = makeInput({ fireGun: true })
    for (let i = 0; i < 30; i++) world.step(input)

    const bullets = world.combat.bullets
    for (let i = 0; i < bullets.bulletCapacity; i++) {
      const b = bullets.bulletAt(i)
      if (b.life <= 0) continue
      const step = b.previous.distanceTo(b.position)
      // 1 ステップで 8.6 m 前後。生まれた直後だけ 0
      expect(step, `${i} 番`).toBeLessThan(12)
      if (b.life < 2.4) expect(step, `${i} 番`).toBeGreaterThan(5)
    }
  })
})

describe('リセット', () => {
  it('弾と戦績が戻る', () => {
    const { world, player } = createWorldFromScript(SCRIPTS['gun-pass'])
    for (let i = 0; i < SEC * 2; i++) world.step(player.at(i))
    expect(world.combat.hits).toBeGreaterThan(0)

    world.combat.reset()
    expect(world.combat.hits).toBe(0)
    expect(world.combat.kills).toBe(0)
    expect(world.combat.rounds).toBe(MAGAZINE)
    expect(world.combat.roundsFired).toBe(0)
    world.combat.gun.advance(FIXED_DT, 2300)
    expect(world.combat.bulletsInFlight).toBe(0)
  })
})
