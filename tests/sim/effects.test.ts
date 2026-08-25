import { describe, it, expect } from 'vitest'
import {
  EXPLOSION_LIFETIME,
  EXPLOSION_POOL,
  Effects,
  FIREBALL_GROWTH,
  SHARD_COUNT,
  fireballOpacity,
  fireballRadius,
  coreOpacity,
  smokeOpacity,
  CORE_HOLD,
  SMOKE_DELAY,
} from '@sim/effects'
import { Rng } from '@sim/rng'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { runScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'

/**
 * 爆発。
 *
 * **sim が「いつ・どこで・どの強さで」を持つ。**描画は経過秒から絵を作る
 * だけ。描画側に状態を置くとキャプチャモードで何も出ない。
 *
 * 寿命の判定はフレーム番号で行う。`time += dt` の積算は禁止（`CLAUDE.md`）。
 */

const SEC = 120
const ORIGIN = new Vec3(0, 3000, 0)
const STILL = new Vec3(0, 0, 0)

function effects(): { effects: Effects; rng: Rng } {
  return { effects: new Effects(), rng: new Rng(20260816) }
}

describe('爆発を起こす', () => {
  it('起こすと数が増える', () => {
    const { effects: e, rng } = effects()
    expect(e.length).toBe(0)
    e.spawn(ORIGIN, STILL, 1, 0, rng)
    expect(e.length).toBe(1)
    expect(e.explosionCount).toBe(1)
  })

  it('位置と速度と強さを覚える', () => {
    const { effects: e, rng } = effects()
    const velocity = new Vec3(0, 0, -240)
    e.spawn(ORIGIN, velocity, 0.75, 42, rng)

    const x = e.explosionAt(0)
    expect(x.position.approxEquals(ORIGIN, 1e-9)).toBe(true)
    expect(x.velocity.approxEquals(velocity, 1e-9)).toBe(true)
    expect(x.strength).toBe(0.75)
    expect(x.frame).toBe(42)
  })

  it('破片が球面に一様に散る', () => {
    const { effects: e, rng } = effects()
    e.spawn(ORIGIN, STILL, 1, 0, rng)
    const x = e.explosionAt(0)
    expect(x.shards).toHaveLength(SHARD_COUNT)

    // すべて単位ベクトル
    for (const shard of x.shards) {
      expect(shard.direction.length()).toBeCloseTo(1, 9)
      expect(shard.speed).toBeGreaterThan(0)
    }
    // 上下に偏っていない。極角を一様に取ると極へ寄る
    const meanY = x.shards.reduce((s, v) => s + v.direction.y, 0) / SHARD_COUNT
    expect(Math.abs(meanY)).toBeLessThan(0.5)
  })

  it('強さが小さいと破片も遅い', () => {
    const weak = effects()
    weak.effects.spawn(ORIGIN, STILL, 0.2, 0, weak.rng)
    const strong = effects()
    strong.effects.spawn(ORIGIN, STILL, 1, 0, strong.rng)

    const speedOf = (e: Effects): number =>
      e.explosionAt(0).shards.reduce((s, v) => s + v.speed, 0) / SHARD_COUNT
    expect(speedOf(weak.effects)).toBeLessThan(speedOf(strong.effects))
  })

  it('プールを超えたら古いほうから上書きする', () => {
    const { effects: e, rng } = effects()
    for (let i = 0; i < EXPLOSION_POOL + 3; i++) e.spawn(ORIGIN, STILL, 1, i, rng)
    expect(e.length).toBe(EXPLOSION_POOL)
    expect(e.explosionCount).toBe(EXPLOSION_POOL + 3)
    // 0 が最新
    expect(e.explosionAt(0).frame).toBe(EXPLOSION_POOL + 2)
  })

  it('同じシードから同じ破片が出る', () => {
    const trace = (): number[] => {
      const { effects: e, rng } = effects()
      e.spawn(ORIGIN, STILL, 1, 0, rng)
      return e.explosionAt(0).shards.flatMap((s) => [
        s.direction.x,
        s.direction.y,
        s.direction.z,
        s.speed,
      ])
    }
    expect(trace()).toEqual(trace())
  })
})

describe('寿命', () => {
  it('起きた直後は生きている', () => {
    const { effects: e, rng } = effects()
    e.spawn(ORIGIN, STILL, 1, 100, rng)
    expect(e.aliveAt(100, FIXED_DT)).toBe(1)
  })

  it('寿命を過ぎたら数えない', () => {
    const { effects: e, rng } = effects()
    e.spawn(ORIGIN, STILL, 1, 0, rng)
    const dead = Math.ceil(EXPLOSION_LIFETIME / FIXED_DT) + 1
    expect(e.aliveAt(dead - 20, FIXED_DT)).toBe(1)
    expect(e.aliveAt(dead, FIXED_DT)).toBe(0)
  })

  it('複数を別々に数える', () => {
    const { effects: e, rng } = effects()
    e.spawn(ORIGIN, STILL, 1, 0, rng)
    e.spawn(ORIGIN, STILL, 1, 200, rng)
    expect(e.aliveAt(200, FIXED_DT)).toBe(2)
    // 1 個目だけ寿命が尽きる時点
    const gone = Math.ceil(EXPLOSION_LIFETIME / FIXED_DT) + 1
    expect(e.aliveAt(gone, FIXED_DT)).toBe(1)
  })

  it('リセットで消える', () => {
    const { effects: e, rng } = effects()
    e.spawn(ORIGIN, STILL, 1, 0, rng)
    e.reset()
    expect(e.length).toBe(0)
    expect(e.explosionCount).toBe(0)
    expect(e.aliveAt(0, FIXED_DT)).toBe(0)
  })
})

describe('火球の形', () => {
  it('立ち上がってから緩やかに広がる', () => {
    const early = fireballRadius(0.05, 1)
    const peak = fireballRadius(FIREBALL_GROWTH, 1)
    const late = fireballRadius(2, 1)
    expect(early).toBeLessThan(peak)
    expect(peak).toBeLessThan(late)
    // 立ち上がりのほうが速い
    expect(peak - early).toBeGreaterThan(late - peak)
  })

  it('強いほど大きい', () => {
    expect(fireballRadius(0.3, 1)).toBeGreaterThan(fireballRadius(0.3, 0.5))
  })

  it('負の経過は 0', () => {
    expect(fireballRadius(-1, 1)).toBe(0)
    expect(fireballOpacity(-1)).toBe(0)
    expect(smokeOpacity(-1)).toBe(0)
  })

  it('火球は速く消え、煙が残る', () => {
    // 0.8 秒で火球はほぼ消えるが煙は濃い
    expect(fireballOpacity(0.8)).toBeLessThan(0.1)
    expect(smokeOpacity(0.8)).toBeGreaterThan(0.5)
  })

  /**
   * **煙は火球より遅れて立つ。**実物の爆発は火球が先。
   *
   * 遅らせる前は経過 0.14 秒で不透明度 0.74 になり、半径 24 m の灰色の膜が
   * 空を覆って火球を沈めていた（実測。`?explosions=0` との引き算で
   * 外接 54x50 画素、火球が見えない）。0.3 秒遅らせたら 38x37 になった。
   */
  it('煙は火球より遅れて立つ', () => {
    // 火球が膨らみ切るころまでは出ない
    expect(smokeOpacity(0.1)).toBe(0)
    expect(smokeOpacity(SMOKE_DELAY)).toBe(0)
    // そのあと濃くなる
    expect(smokeOpacity(0.5)).toBeGreaterThan(0.2)
    expect(smokeOpacity(0.8)).toBeGreaterThan(0.6)
  })

  /**
   * 芯は火球より長く不透明を保つ。
   *
   * **`fireballOpacity` をそのまま使うと芯にならない。**経過 0.14 秒で
   * 0.61 になり、4 割が背景と混ざって白い靄に見えた（実測）。
   */
  it('芯は保持のあいだ不透明のまま', () => {
    expect(coreOpacity(0.05)).toBeCloseTo(1, 5)
    expect(coreOpacity(CORE_HOLD)).toBeCloseTo(1, 5)
    // 保持のあとは急に消える
    expect(coreOpacity(CORE_HOLD + 0.12)).toBeCloseTo(0, 5)
    // 同じ時刻で火球より濃い
    expect(coreOpacity(0.14)).toBeGreaterThan(fireballOpacity(0.14))
  })

  it('どちらも寿命で 0 になる', () => {
    expect(fireballOpacity(EXPLOSION_LIFETIME)).toBe(0)
    expect(smokeOpacity(EXPLOSION_LIFETIME)).toBe(0)
  })

  it('火球は単調に減る', () => {
    let previous = fireballOpacity(0.05)
    for (let t = 0.06; t < EXPLOSION_LIFETIME; t += 0.05) {
      const value = fireballOpacity(t)
      expect(value).toBeLessThanOrEqual(previous + 1e-9)
      previous = value
    }
  })

  it('不透明度は 0..1 に収まる', () => {
    for (let t = 0; t < EXPLOSION_LIFETIME; t += 0.02) {
      expect(fireballOpacity(t), `${t}`).toBeGreaterThanOrEqual(0)
      expect(fireballOpacity(t), `${t}`).toBeLessThanOrEqual(1)
      expect(smokeOpacity(t), `${t}`).toBeGreaterThanOrEqual(0)
      expect(smokeOpacity(t), `${t}`).toBeLessThanOrEqual(1)
    }
  })
})

describe('台本越し', () => {
  it('機銃の撃墜で 1 個出る', () => {
    // 実測 0.95 秒。耐久 60 へ上げたぶん遅くなった（20 のころは 0.50 秒）
    const before = runScript(SCRIPTS['gun-pass'], SEC * 0.7)
    expect(before.combat.kills).toBe(0)
    expect(before.combat.explosionCount).toBe(0)

    const w = runScript(SCRIPTS['gun-pass'], SEC * 1)
    expect(w.combat.kills).toBe(1)
    expect(w.combat.explosionCount).toBe(1)
    expect(w.combat.explosionsAliveAt(w.frame, FIXED_DT)).toBe(1)
  })

  it('ミサイルの命中で 2 個出る。弾頭の炸裂と撃墜', () => {
    const w = runScript(SCRIPTS['missile-shot'], SEC * 9.5)
    expect(w.combat.kills).toBe(1)
    expect(w.combat.explosionCount).toBe(2)
  })

  it('外れたら 1 個も出ない', () => {
    const w = runScript(SCRIPTS['missile-miss'], SEC * 62)
    expect(w.combat.kills).toBe(0)
    expect(w.combat.explosionCount).toBe(0)
  })

  it('撃たなければ出ない', () => {
    const w = runScript(SCRIPTS['target-ahead'], SEC * 5)
    expect(w.combat.explosionCount).toBe(0)
  })

  it('寿命が過ぎると生きている数が 0 に戻る', () => {
    const soon = runScript(SCRIPTS['gun-pass'], SEC * 1)
    expect(soon.combat.explosionsAliveAt(soon.frame, FIXED_DT)).toBe(1)
    // 撃墜は 0.6 秒。寿命 3.5 秒なので 5 秒後には消えている
    const later = runScript(SCRIPTS['gun-pass'], SEC * 5)
    expect(later.combat.explosionCount).toBe(1)
    expect(later.combat.explosionsAliveAt(later.frame, FIXED_DT)).toBe(0)
  })

  it('2 回再生しても同じ爆発が出る', () => {
    const trace = (): number[] => {
      const w = runScript(SCRIPTS['gun-pass'], SEC * 1)
      const x = w.combat.explosions.explosionAt(0)
      return [x.frame, x.strength, ...x.position.toArray(), ...x.shards[0]!.direction.toArray()]
    }
    expect(trace()).toEqual(trace())
  })
})
