import { describe, it, expect } from 'vitest'
import {
  BULLET_LIFETIME,
  DISPERSION,
  DRAG_K,
  Gun,
  MAGAZINE,
  MUZZLE_SPEED,
  ROUNDS_PER_SECOND,
  TRACER_INTERVAL,
  bulletRangeAfter,
  bulletSpeedAfter,
  bulletTimeToRange,
} from '@sim/weapons/gun'
import { FIXED_DT } from '@sim/loop'
import { GRAVITY } from '@sim/isa'
import { Rng } from '@sim/rng'
import { Vec3 } from '@sim/vec3'

/**
 * 機銃。
 *
 * 諸元は M61A1 の公表値。抗力係数だけは公表値がないので導出で置いた。
 * 弾道の閉形式と、ステップ積分の結果が合うことをここで突き合わせる。
 */

const ORIGIN = new Vec3(0, 3000, 0)
const NOSE = new Vec3(0, 0, -1)
const RIGHT = new Vec3(1, 0, 0)
const UP = new Vec3(0, 1, 0)
const STILL = new Vec3(0, 0, 0)
/** 地形を引かない高さ。地図の最高点より上 */
const HIGH = 2300

function gun(): { gun: Gun; rng: Rng } {
  return { gun: new Gun(), rng: new Rng(20260816) }
}

/**
 * 1 発だけ出す。
 *
 * **1 ステップは 0.833 発なので、`fire` を 1 回呼んでも弾は出ない。**
 * 端数を持ち越す仕組みそのものなので、テスト側も 1 発出るまで引く。
 */
function fireOne(
  g: Gun,
  rng: Rng,
  muzzle = ORIGIN,
  nose = NOSE,
  right = RIGHT,
  up = UP,
  carrier = STILL,
): void {
  let guard = 0
  while (g.roundsFired === 0) {
    g.fire(FIXED_DT, true, muzzle, nose, right, up, carrier, rng)
    if (++guard > 10) throw new Error('弾が出ない')
  }
}

/** 引き金を引いたまま seconds 秒進める。撃った数を返す */
function hold(g: Gun, rng: Rng, seconds: number): number {
  let spawned = 0
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    g.advance(FIXED_DT, HIGH)
    spawned += g.fire(FIXED_DT, true, ORIGIN, NOSE, RIGHT, UP, STILL, rng)
  }
  return spawned
}

describe('発射速度', () => {
  it('1 秒で 100 発。120 発にならない', () => {
    // 1 ステップ 0.833 発なので端数を持ち越す。持ち越さないと毎ステップ
    // 1 発になり、6,000 発/分が 7,200 発/分に化ける
    const { gun: g, rng } = gun()
    expect(hold(g, rng, 1)).toBe(ROUNDS_PER_SECOND)
  })

  it('3 秒で 300 発。端数が積もらない', () => {
    const { gun: g, rng } = gun()
    expect(hold(g, rng, 3)).toBe(300)
  })

  it('引き金を離すと端数を捨てる', () => {
    const { gun: g, rng } = gun()
    // 1 ステップだけ引いて離す。0.833 発ぶんの端数ができる
    g.fire(FIXED_DT, true, ORIGIN, NOSE, RIGHT, UP, STILL, rng)
    g.fire(FIXED_DT, false, ORIGIN, NOSE, RIGHT, UP, STILL, rng)
    // 離したあとに引き直しても、たまった端数がまとめて出ない
    const first = g.fire(FIXED_DT, true, ORIGIN, NOSE, RIGHT, UP, STILL, rng)
    expect(first).toBe(0)
  })

  it('残弾が尽きたら止まる', () => {
    const { gun: g, rng } = gun()
    expect(g.rounds).toBe(MAGAZINE)
    // **携行弾ぶんより長く回す。**`MAGAZINE` を増やしたときに、撃ち切る前に
    // 止まると「尽きた」ことを検査できない
    const spawned = hold(g, rng, MAGAZINE / ROUNDS_PER_SECOND + 2)
    expect(spawned).toBe(MAGAZINE)
    expect(g.rounds).toBe(0)
  })

  it('携行弾は 18 秒ぶん', () => {
    // **公表値の 578 発（5.78 秒）から増やした。**ミッション 01 が敵 5 機で、
    // 1 対 1 の実測では 1 機に 545 発かかる（`MAGAZINE` の注記）
    expect(MAGAZINE / ROUNDS_PER_SECOND).toBeCloseTo(18, 6)
  })

  it('曳光弾は 5 発に 1 発', () => {
    const { gun: g, rng } = gun()
    hold(g, rng, 0.5)
    let tracers = 0
    let live = 0
    for (let i = 0; i < g.bulletCapacity; i++) {
      const b = g.bulletAt(i)
      if (b.life <= 0) continue
      live++
      if (b.tracer) tracers++
    }
    expect(live).toBeGreaterThan(40)
    expect(tracers / live).toBeCloseTo(1 / TRACER_INTERVAL, 1)
  })
})

describe('弾道', () => {
  it('機体の速度を引き継ぐ', () => {
    const { gun: g, rng } = gun()
    const carrier = new Vec3(0, 0, -300)
    fireOne(g, rng, ORIGIN, NOSE, RIGHT, UP, carrier)
    let found = false
    for (let i = 0; i < g.bulletCapacity; i++) {
      const b = g.bulletAt(i)
      if (b.life <= 0) continue
      found = true
      // 地面から見た初速は 1,030 + 300
      expect(b.velocity.length()).toBeCloseTo(MUZZLE_SPEED + 300, 0)
    }
    expect(found).toBe(true)
  })

  it('抗力で減速する', () => {
    const { gun: g, rng } = gun()
    fireOne(g, rng)
    const bullet = g.bulletAt(0)
    const start = bullet.velocity.length()
    for (let i = 0; i < 60; i++) g.advance(FIXED_DT, HIGH)
    expect(bullet.velocity.length()).toBeLessThan(start)
  })

  it('ステップ積分が閉形式と 1% 以内で合う', () => {
    // dv/dt = −k v² の解。重力は水平距離にほぼ効かないので、水平だけ比べる
    const { gun: g, rng } = gun()
    fireOne(g, rng)
    const bullet = g.bulletAt(0)

    const seconds = 1
    for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) g.advance(FIXED_DT, HIGH)

    const travelled = Math.hypot(
      bullet.position.x - ORIGIN.x,
      bullet.position.z - ORIGIN.z,
    )
    // 高度が上がると空気が薄く抗力が弱まるので、閉形式（海面）より少し伸びる
    const closed = bulletRangeAfter(seconds)
    expect(travelled / closed).toBeGreaterThan(1)
    expect(travelled / closed).toBeLessThan(1.13)
  })

  it('重力で落ちる。落ちは時間の二乗に比例する', () => {
    /** 落ちと水平距離を返す */
    const fly = (seconds: number): { drop: number; horizontal: number } => {
      const { gun: g, rng } = gun()
      fireOne(g, rng)
      const bullet = g.bulletAt(0)
      for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) g.advance(FIXED_DT, HIGH)
      return {
        drop: ORIGIN.y - bullet.position.y,
        horizontal: Math.hypot(bullet.position.x - ORIGIN.x, bullet.position.z - ORIGIN.z),
      }
    }
    const a = fly(0.5)
    const b = fly(1)

    // **散布ぶんが混ざる。**初速の向きが上下に最大 DISPERSION rad 振れるので、
    // 0.5 秒で 452 m 進むだけで ±1.4 m のずれが出る。重力の落ち（1.23 m）と
    // 同じ大きさなので、比べるときはその幅を見込む
    const ideal = 0.5 * GRAVITY * 0.25
    expect(Math.abs(a.drop - ideal)).toBeLessThan(DISPERSION * a.horizontal)

    // 比は散布に依りにくい。散布の寄与は時間に比例、重力は二乗で効くので、
    // 時間を倍にすると重力の側が支配する
    expect(b.drop / a.drop).toBeGreaterThan(3)
    expect(b.drop / a.drop).toBeLessThan(5)
  })

  it('寿命で消える', () => {
    const { gun: g, rng } = gun()
    fireOne(g, rng)
    // 生まれた時点で数える。advance のときだけ数え直す作りにすると、
    // 同じステップで生まれた弾が抜けて 1 発ずれる
    expect(g.bulletsInFlight).toBe(1)
    g.advance(FIXED_DT, HIGH)
    expect(g.bulletsInFlight).toBe(1)
    for (let i = 0; i < Math.round(BULLET_LIFETIME / FIXED_DT) + 2; i++) {
      g.advance(FIXED_DT, HIGH)
    }
    expect(g.bulletsInFlight).toBe(0)
  })

  it('海面に当たると消える', () => {
    const { gun: g, rng } = gun()
    // 低いところから真下へ撃つ
    const low = new Vec3(0, 40, 0)
    fireOne(g, rng, low, new Vec3(0, -1, 0), RIGHT, new Vec3(0, 0, -1))
    for (let i = 0; i < 20; i++) g.advance(FIXED_DT, HIGH)
    expect(g.bulletsInFlight).toBe(0)
  })

  it('地形を渡すと山にも当たる', () => {
    const { gun: g, rng } = gun()
    const ground = { heightAt: () => 1500 }
    const low = new Vec3(0, 1560, 0)
    fireOne(g, rng, low, new Vec3(0, -1, 0), RIGHT, new Vec3(0, 0, -1))
    for (let i = 0; i < 20; i++) g.advance(FIXED_DT, 2300, ground)
    expect(g.bulletsInFlight).toBe(0)
  })

  it('高いところでは地形を引かない。groundLimit より上なら消えない', () => {
    const { gun: g, rng } = gun()
    let asked = 0
    const ground = {
      heightAt: () => {
        asked++
        return 0
      },
    }
    fireOne(g, rng)
    for (let i = 0; i < 30; i++) g.advance(FIXED_DT, 2300, ground)
    expect(asked).toBe(0)
    expect(g.bulletsInFlight).toBe(1)
  })
})

describe('散布', () => {
  it('弾が 1 本の線に重ならない', () => {
    const { gun: g, rng } = gun()
    hold(g, rng, 0.3)
    const dirs: Vec3[] = []
    for (let i = 0; i < g.bulletCapacity; i++) {
      const b = g.bulletAt(i)
      if (b.life <= 0) continue
      dirs.push(b.velocity.clone().normalize())
    }
    expect(dirs.length).toBeGreaterThan(20)
    // 機軸との角度に幅がある
    const angles = dirs.map((d) => Math.acos(Math.min(1, -d.z)))
    const spread = Math.max(...angles) - Math.min(...angles)
    expect(spread).toBeGreaterThan(0)
    // 散布の設定より大きく外れない
    expect(Math.max(...angles)).toBeLessThan(DISPERSION * 2.5)
  })

  it('同じシードからは同じ散布になる', () => {
    const trace = (): number[] => {
      const { gun: g, rng } = gun()
      hold(g, rng, 0.3)
      const out: number[] = []
      for (let i = 0; i < g.bulletCapacity; i++) {
        const b = g.bulletAt(i)
        if (b.life <= 0) continue
        out.push(b.velocity.x, b.velocity.y, b.velocity.z)
      }
      return out
    }
    expect(trace()).toEqual(trace())
  })
})

describe('閉形式', () => {
  it('速度は v₀ / (1 + k v₀ t)', () => {
    expect(bulletSpeedAfter(0)).toBe(MUZZLE_SPEED)
    expect(bulletSpeedAfter(1)).toBeCloseTo(
      MUZZLE_SPEED / (1 + DRAG_K * MUZZLE_SPEED),
      9,
    )
    // 実測（この式を回した値）
    expect(bulletSpeedAfter(1)).toBeCloseTo(651, 0)
    expect(bulletSpeedAfter(2.5)).toBeCloseTo(419, 0)
  })

  it('飛距離は ln(1 + k v₀ t) / k', () => {
    expect(bulletRangeAfter(0)).toBe(0)
    expect(bulletRangeAfter(1)).toBeCloseTo(812, 0)
    expect(bulletRangeAfter(2.5)).toBeCloseTo(1589, 0)
  })

  it('距離から時間を逆に解ける。往復して戻る', () => {
    for (const range of [100, 300, 800, 1500]) {
      const t = bulletTimeToRange(range)
      expect(bulletRangeAfter(t), `${range} m`).toBeCloseTo(range, 6)
    }
  })

  it('300 m は 0.32 秒。狙いの補正が要る大きさ', () => {
    const t = bulletTimeToRange(300)
    expect(t).toBeCloseTo(0.32, 2)
    expect(0.5 * GRAVITY * t * t).toBeCloseTo(0.5, 1)
  })

  it('単調。遠いほど遅く、時間がかかる', () => {
    let previousSpeed = MUZZLE_SPEED
    let previousRange = 0
    for (let t = 0.1; t <= 2.5; t += 0.1) {
      const v = bulletSpeedAfter(t)
      const x = bulletRangeAfter(t)
      expect(v).toBeLessThan(previousSpeed)
      expect(x).toBeGreaterThan(previousRange)
      previousSpeed = v
      previousRange = x
    }
  })
})
