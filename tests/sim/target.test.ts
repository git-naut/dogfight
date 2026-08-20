import { describe, it, expect } from 'vitest'
import { Target, createTargetSample, steadyTurnBank, type TargetSpec } from '@sim/target'
import { FIXED_DT } from '@sim/loop'
import { GRAVITY } from '@sim/isa'
import { Vec3 } from '@sim/vec3'

/**
 * 標的機。
 *
 * 力学は載せないが運動学は正しくないと、比例航法の検証が成り立たない。
 * とくに旋回。**旋回する的がないと視線の回転率がほぼ 0 になり、比例航法が
 * 「まっすぐ追う」のと区別が付かない。**この 1 点のために標的機を入れている。
 */

const ORIGIN = new Vec3(0, 2000, 0)

function target(spec: Partial<TargetSpec> = {}): Target {
  return new Target(
    { offset: new Vec3(0, 0, -4000), speed: 240, ...spec },
    ORIGIN,
  )
}

/** dt 秒ぶん進める */
function run(t: Target, seconds: number): void {
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) t.step(FIXED_DT)
}

describe('標的機の配置', () => {
  it('自機のスポーン地点からの相対で置かれる', () => {
    const t = target({ offset: new Vec3(300, 100, -4000) })
    expect(t.position.x).toBe(300)
    expect(t.position.y).toBe(2100)
    expect(t.position.z).toBe(-4000)
  })

  it('機首は -Z を向く。自機と同じ向きで前方に湧く', () => {
    const forward = target().orientation.forward()
    expect(forward.z).toBeLessThan(-0.99)
    expect(Math.abs(forward.x)).toBeLessThan(1e-6)
  })

  it('機首は経路よりトリム迎角ぶん上を向く', () => {
    const t = target()
    const forward = t.orientation.forward()
    const velocityDir = t.velocity.clone().normalize()
    // 機首のほうが上。速度は水平
    expect(forward.y).toBeGreaterThan(velocityDir.y)
    expect(Math.abs(velocityDir.y)).toBeLessThan(1e-9)
    expect(t.angleOfAttack).toBeGreaterThan(0)
  })
})

describe('直進する標的機', () => {
  it('速度が一定で高度を保つ', () => {
    const t = target()
    run(t, 20)
    expect(t.velocity.length()).toBeCloseTo(240, 9)
    expect(t.position.y).toBeCloseTo(2000, 9)
  })

  it('20 秒で 4,800 m 前へ進む', () => {
    const t = target()
    run(t, 20)
    expect(t.position.z).toBeCloseTo(-4000 - 4800, 6)
    expect(t.position.x).toBeCloseTo(0, 9)
  })

  it('バンクしない', () => {
    expect(target().bank).toBe(0)
  })

  it('姿勢が変わらない', () => {
    const t = target()
    const before = t.orientation.clone()
    run(t, 10)
    expect(t.orientation.approxEquals(before, 1e-9)).toBe(true)
  })
})

describe('旋回する標的機', () => {
  /** 旋回率 rad/s。半径 R = v / ω なので 240 m/s・0.06 rad/s で 4,000 m */
  const OMEGA = 0.06

  it('正の旋回率で右へ回る', () => {
    const t = target({ turnRate: OMEGA })
    run(t, 2)
    // 右は +X
    expect(t.position.x).toBeGreaterThan(0)
  })

  it('負の旋回率で左へ回る', () => {
    const t = target({ turnRate: -OMEGA })
    run(t, 2)
    expect(t.position.x).toBeLessThan(0)
  })

  it('旋回半径が v / ω で、中心からの距離が 60 秒ずれない', () => {
    // 速度 × dt で積分すると円が外へ膨らむ。厳密に弦で積分しているので
    // 中心からの距離が保たれる。前進 Euler では 4 分の 1 周で 1.8 m 育った
    const t = target({ turnRate: OMEGA })
    const radius = 240 / OMEGA
    // 中心は開始位置の真右
    const cx = t.position.x + radius
    const cz = t.position.z

    let worst = 0
    for (let i = 0; i < 120 * 60; i++) {
      t.step(FIXED_DT)
      const r = Math.hypot(t.position.x - cx, t.position.z - cz)
      worst = Math.max(worst, Math.abs(r - radius))
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('4 分の 1 周で右へ R、前へ R 進む', () => {
    const t = target({ turnRate: OMEGA })
    const start = t.position.clone()
    const radius = 240 / OMEGA
    // 方位がちょうど 90 度になる歩数。端数が出ないよう刻みを選ぶ
    const steps = Math.round(Math.PI / 2 / (OMEGA * FIXED_DT))
    const dt = Math.PI / 2 / OMEGA / steps
    for (let i = 0; i < steps; i++) t.step(dt)

    expect(t.position.x - start.x).toBeCloseTo(radius, 6)
    expect(t.position.z - start.z).toBeCloseTo(-radius, 6)
  })

  it('旋回中も速度と高度を保つ', () => {
    const t = target({ turnRate: OMEGA })
    run(t, 30)
    expect(t.velocity.length()).toBeCloseTo(240, 9)
    expect(t.position.y).toBeCloseTo(2000, 9)
  })

  it('バンク角が tan φ = v ω / g になる', () => {
    const t = target({ turnRate: OMEGA })
    expect(Math.tan(t.bank)).toBeCloseTo((240 * OMEGA) / GRAVITY, 12)
    // 240 m/s・0.06 rad/s で 55.8 度
    expect((t.bank * 180) / Math.PI).toBeCloseTo(55.77, 1)
  })

  it('右旋回で右にバンクする', () => {
    expect(target({ turnRate: OMEGA }).bank).toBeGreaterThan(0)
    expect(target({ turnRate: -OMEGA }).bank).toBeLessThan(0)
  })

  it('バンクしても速度は水平のまま。機首軸まわりの回転なので前方向を動かさない', () => {
    const t = target({ turnRate: OMEGA })
    run(t, 5)
    expect(Math.abs(t.velocity.y)).toBeLessThan(1e-9)
  })
})

describe('steadyTurnBank', () => {
  it('旋回しなければ 0', () => {
    expect(steadyTurnBank(240, 0)).toBe(0)
  })

  it('速度が上がると同じ旋回率でも深く倒れる', () => {
    expect(steadyTurnBank(300, 0.06)).toBeGreaterThan(steadyTurnBank(200, 0.06))
  })

  it('質量にも揚力にも依存しない。速度と旋回率だけで決まる', () => {
    // 式に質量が入っていないことを、値そのもので固定する
    expect(steadyTurnBank(200, 0.05)).toBeCloseTo(Math.atan((200 * 0.05) / GRAVITY), 12)
  })
})

describe('補間', () => {
  it('alpha 0 が前ステップ、1 が現ステップ', () => {
    const t = target()
    run(t, 1)
    const before = t.position.clone()
    t.step(FIXED_DT)

    const out = createTargetSample()
    t.sample(0, out)
    expect(out.position.approxEquals(before, 1e-9)).toBe(true)
    t.sample(1, out)
    expect(out.position.approxEquals(t.position, 1e-9)).toBe(true)
  })

  it('中間は前後の間に入る', () => {
    const t = target()
    run(t, 1)
    const before = t.position.z
    t.step(FIXED_DT)
    const out = createTargetSample()
    t.sample(0.5, out)
    expect(out.position.z).toBeLessThan(before)
    expect(out.position.z).toBeGreaterThan(t.position.z)
  })
})

describe('決定論', () => {
  it('同じ初期条件から同じ軌跡が出る', () => {
    const trace = (): number[] => {
      const t = target({ turnRate: 0.06 })
      const out: number[] = []
      for (let i = 0; i < 600; i++) {
        t.step(FIXED_DT)
        out.push(t.position.x, t.position.y, t.position.z)
      }
      return out
    }
    expect(trace()).toEqual(trace())
  })
})
