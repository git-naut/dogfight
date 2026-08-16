import { describe, it, expect } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { Aircraft, createAircraftSample, setBodyRates } from '@sim/aircraft'
import { makeInput, type InputState } from '@sim/input'
import { FIXED_DT } from '@sim/loop'
import { airDensity } from '@sim/isa'
import { AIRCRAFT, trimCondition } from '@sim/flightModel'
import { Rng } from '@sim/rng'

const DEG = Math.PI / 180
const SECOND = Math.round(1 / FIXED_DT)

/** 水平定常飛行に釣り合った機体を作る。速度は -Z（真北）向き。 */
function trimmed(speed = 250, altitude = 2000): { craft: Aircraft; input: InputState } {
  const { alpha, throttle } = trimCondition(speed, airDensity(altitude))
  const craft = new Aircraft({
    position: new Vec3(0, altitude, 0),
    velocity: new Vec3(0, 0, -speed),
    // 機首を迎角ぶん上げる。速度は水平なので迎角がそのまま alpha になる
    orientation: new Quat().setFromAxisAngle(new Vec3(1, 0, 0), alpha),
    throttle,
  })
  return { craft, input: makeInput({ throttle }) }
}

function run(craft: Aircraft, input: InputState, steps: number, options = {}): void {
  for (let i = 0; i < steps; i++) craft.step(input, FIXED_DT, options)
}

/** 速度ベクトルの水平方位 rad。 */
function heading(craft: Aircraft): number {
  return Math.atan2(craft.velocity.x, -craft.velocity.z)
}

describe('操縦の向き', () => {
  it('setBodyRates が直感的な指令を body 角速度へ写す', () => {
    // 符号反転で -0 が出るため、値の一致は approxEquals で見る
    const out = new Vec3()
    // 機首上げは +X まわり
    expect(setBodyRates(out, 1, 0, 0).approxEquals(new Vec3(1, 0, 0))).toBe(true)
    // 右ロールは -Z まわり
    expect(setBodyRates(out, 0, 1, 0).approxEquals(new Vec3(0, 0, -1))).toBe(true)
    // 右ヨーは -Y まわり
    expect(setBodyRates(out, 0, 0, 1).approxEquals(new Vec3(0, -1, 0))).toBe(true)
  })

  it('ピッチ入力を正にすると機首が上がる', () => {
    const { craft, input } = trimmed()
    const before = craft.orientation.forward().y
    run(craft, { ...input, pitch: 1 }, SECOND)
    expect(craft.orientation.forward().y).toBeGreaterThan(before + 0.1)
  })

  it('ピッチ入力を負にすると機首が下がる', () => {
    const { craft, input } = trimmed()
    const before = craft.orientation.forward().y
    run(craft, { ...input, pitch: -1 }, SECOND)
    expect(craft.orientation.forward().y).toBeLessThan(before - 0.1)
  })

  it('ロール入力を正にすると右へバンクする', () => {
    const { craft, input } = trimmed()
    run(craft, { ...input, roll: 1 }, Math.round(SECOND * 0.3))
    expect(craft.bank).toBeGreaterThan(20 * DEG)
  })

  it('ロール入力を負にすると左へバンクする', () => {
    const { craft, input } = trimmed()
    run(craft, { ...input, roll: -1 }, Math.round(SECOND * 0.3))
    expect(craft.bank).toBeLessThan(-20 * DEG)
  })

  it('ヨー入力を正にすると機首が右を向く', () => {
    const { craft, input } = trimmed()
    const before = heading(craft)
    run(craft, { ...input, yaw: 1 }, SECOND * 2)
    expect(heading(craft)).toBeGreaterThan(before + 0.01)
  })
})

describe('水平定常飛行', () => {
  it('トリム条件を与えると 10 秒間 高度も速度も保つ', () => {
    const speed = 250
    const altitude = 1000
    const { craft, input } = trimmed(speed, altitude)

    run(craft, input, SECOND * 10)

    expect(Math.abs(craft.altitude - altitude)).toBeLessThan(50)
    expect(Math.abs(craft.speed - speed)).toBeLessThan(10)
    expect(craft.loadFactor).toBeCloseTo(1, 1)
  })

  it('60 秒でも破綻しない', () => {
    const { craft, input } = trimmed(250, 3000)
    run(craft, input, SECOND * 60)
    expect(craft.crashed).toBe(false)
    expect(Math.abs(craft.altitude - 3000)).toBeLessThan(300)
    expect(craft.position.isFinite()).toBe(true)
  })

  it('スロットルを絞ると減速して高度が落ちる', () => {
    const { craft, input } = trimmed(250, 3000)
    run(craft, { ...input, throttle: 0 }, SECOND * 15)
    expect(craft.speed).toBeLessThan(250)
    expect(craft.altitude).toBeLessThan(3000)
  })

  it('スロットルを開けると加速する', () => {
    const { craft, input } = trimmed(250, 3000)
    run(craft, { ...input, throttle: 1 }, SECOND * 10)
    expect(craft.speed).toBeGreaterThan(300)
  })
})

describe('旋回', () => {
  /** フルピッチで引いたときの旋回半径 m を測る。 */
  function turnRadius(speed: number): number {
    const { craft, input } = trimmed(speed, 4000)
    // 過渡を抜けるまで少し回してから計測する
    run(craft, { ...input, pitch: 1 }, Math.round(SECOND * 1.5))

    const before = craft.velocity.clone().normalize()
    const speedAtStart = craft.speed
    const window = SECOND
    run(craft, { ...input, pitch: 1 }, window)
    const after = craft.velocity.clone().normalize()

    const swept = Math.acos(Math.min(1, Math.max(-1, before.dot(after))))
    const omega = swept / (window * FIXED_DT)
    return speedAtStart / omega
  }

  it('速度が上がるほど旋回半径が広がる', () => {
    const r200 = turnRadius(200)
    const r300 = turnRadius(300)
    const r400 = turnRadius(400)
    expect(r300).toBeGreaterThan(r200)
    expect(r400).toBeGreaterThan(r300)
  })

  it('旋回半径が戦闘機として妥当な大きさになる', () => {
    // 200 m/s で 9G 相当なら 400〜700 m
    const r = turnRadius(200)
    expect(r).toBeGreaterThan(350)
    expect(r).toBeLessThan(800)
  })

  it('旋回すると誘導抗力で減速する', () => {
    const { craft, input } = trimmed(300, 5000)
    const before = craft.speed
    run(craft, { ...input, pitch: 1 }, SECOND * 5)
    expect(craft.speed).toBeLessThan(before - 20)
  })

  it('荷重倍数が G 制限を大きく超えない', () => {
    const { craft, input } = trimmed(300, 6000)
    let peak = 0
    for (let i = 0; i < SECOND * 6; i++) {
      craft.step({ ...input, pitch: 1 }, FIXED_DT)
      peak = Math.max(peak, craft.loadFactor)
    }
    expect(peak).toBeLessThan(AIRCRAFT.gLimit * 1.15)
  })
})

describe('迎角制限と失速', () => {
  it('制限器が有効なら低速でフルに引いても制限角を超えない', () => {
    const { craft, input } = trimmed(150, 4000)
    let peak = 0
    for (let i = 0; i < SECOND * 8; i++) {
      craft.step({ ...input, pitch: 1 }, FIXED_DT)
      peak = Math.max(peak, craft.angleOfAttack)
    }
    // 一次遅れのぶんだけ僅かに越えうるので 1 度の余裕を見る
    expect(peak).toBeLessThan(AIRCRAFT.aoaLimit + 1 * DEG)
  })

  it('制限器が有効なら失速しない', () => {
    const { craft, input } = trimmed(160, 5000)
    let stalled = false
    for (let i = 0; i < SECOND * 8; i++) {
      craft.step({ ...input, pitch: 1 }, FIXED_DT)
      stalled = stalled || craft.stalled
    }
    expect(stalled).toBe(false)
  })

  it('制限器を切ると失速する', () => {
    const { craft, input } = trimmed(150, 5000)
    let stalled = false
    for (let i = 0; i < SECOND * 10; i++) {
      craft.step({ ...input, pitch: 1 }, FIXED_DT, { aoaLimiter: false })
      stalled = stalled || craft.stalled
    }
    expect(stalled).toBe(true)
  })
})

describe('風見安定と協調旋回', () => {
  it('横向きの速度を与えると横滑りが減衰する', () => {
    const { craft, input } = trimmed(250, 5000)
    // 機体右方向へ 40 m/s 押し出す
    craft.velocity.addScaledVector(craft.orientation.right(), 40)
    craft.step(input, FIXED_DT)

    const initial = Math.abs(craft.sideslip)
    expect(initial).toBeGreaterThan(5 * DEG)

    run(craft, input, SECOND * 3)
    expect(Math.abs(craft.sideslip)).toBeLessThan(initial * 0.2)
  })

  it('横滑りを消しても迎角は残る（揚力が死なない）', () => {
    const { craft, input } = trimmed(250, 5000)
    const trimAlpha = craft.angleOfAttack
    craft.velocity.addScaledVector(craft.orientation.right(), 40)

    run(craft, input, SECOND * 4)

    expect(Math.abs(craft.sideslip)).toBeLessThan(2 * DEG)
    // 迎角はトリム付近を保っている
    expect(craft.angleOfAttack).toBeGreaterThan(trimAlpha * 0.3)
    expect(craft.altitude).toBeGreaterThan(4500)
  })

  it('バンクを保つと機首方位が変わり、横滑りは小さいまま', () => {
    const { craft, input } = trimmed(250, 6000)
    const startHeading = heading(craft)
    const targetBank = 50 * DEG

    let maxSideslip = 0
    for (let i = 0; i < SECOND * 6; i++) {
      // バンク保持の簡易コントローラ
      const roll = Math.max(-1, Math.min(1, (targetBank - craft.bank) * 3))
      // 旋回で高度が落ちないよう引く
      const pitch = 0.35
      craft.step({ ...input, roll, pitch }, FIXED_DT)
      if (i > SECOND) maxSideslip = Math.max(maxSideslip, Math.abs(craft.sideslip))
    }

    const swept = Math.abs(heading(craft) - startHeading)
    expect(craft.bank).toBeGreaterThan(40 * DEG)
    expect(swept).toBeGreaterThan(0.5) // 30 度以上まわった
    expect(maxSideslip).toBeLessThan(6 * DEG)
  })
})

describe('スロットル', () => {
  it('目標へ一次遅れで追従し、行き過ぎない', () => {
    const { craft, input } = trimmed(250, 3000)
    const start = craft.throttle
    let peak = start

    for (let i = 0; i < SECOND * 5; i++) {
      craft.step({ ...input, throttle: 1 }, FIXED_DT)
      peak = Math.max(peak, craft.throttle)
    }

    expect(craft.throttle).toBeGreaterThan(0.99)
    expect(peak).toBeLessThanOrEqual(1 + 1e-12)
  })

  it('1 ステップで飛びつかない', () => {
    const { craft, input } = trimmed(250, 3000)
    const start = craft.throttle
    craft.step({ ...input, throttle: 1 }, FIXED_DT)
    expect(craft.throttle).toBeLessThan(start + 0.05)
    expect(craft.throttle).toBeGreaterThan(start)
  })
})

describe('地面', () => {
  it('降下し続けると墜落し、そこで停止する', () => {
    const { craft, input } = trimmed(250, 300)
    run(craft, { ...input, pitch: -1 }, SECOND * 20)

    expect(craft.crashed).toBe(true)
    expect(craft.position.y).toBe(0)
    expect(craft.speed).toBe(0)
  })

  it('墜落後はステップしても状態が変わらない', () => {
    const { craft, input } = trimmed(200, 100)
    run(craft, { ...input, pitch: -1 }, SECOND * 20)
    expect(craft.crashed).toBe(true)

    const snapshot = craft.position.clone()
    run(craft, input, SECOND * 5)
    expect(craft.position.approxEquals(snapshot)).toBe(true)
  })
})

describe('数値の健全性', () => {
  it('10 万ステップ回しても発散しない', () => {
    const { craft, input } = trimmed(300, 8000)
    const rng = new Rng(1234)

    for (let i = 0; i < 100_000; i++) {
      // 3 秒ごとに操作を変える
      if (i % (SECOND * 3) === 0) {
        input.pitch = rng.range(-1, 1)
        input.roll = rng.range(-1, 1)
        input.yaw = rng.range(-0.3, 0.3)
        input.throttle = rng.range(0.3, 1)
      }
      craft.step(input, FIXED_DT)
      if (craft.crashed) {
        // 墜落したら高空へ戻して続行する
        craft.crashed = false
        craft.position.set(0, 8000, 0)
        craft.velocity.set(0, 0, -300)
        craft.orientation.identity()
      }
    }

    expect(craft.position.isFinite()).toBe(true)
    expect(craft.velocity.isFinite()).toBe(true)
    expect(craft.orientation.isFinite()).toBe(true)
    expect(Math.abs(craft.orientation.length() - 1)).toBeLessThan(1e-9)
    expect(Number.isFinite(craft.angleOfAttack)).toBe(true)
    expect(Number.isFinite(craft.loadFactor)).toBe(true)
  })

  it('速度ゼロから始めても NaN を出さない', () => {
    const craft = new Aircraft({ position: new Vec3(0, 1000, 0) })
    run(craft, makeInput({ throttle: 1, pitch: 1 }), SECOND * 5)
    expect(craft.position.isFinite()).toBe(true)
    expect(craft.velocity.isFinite()).toBe(true)
    expect(Number.isFinite(craft.angleOfAttack)).toBe(true)
  })

  it('同じ初期状態と同じ入力列から同じ結果が出る', () => {
    const build = () => trimmed(280, 5000)
    const a = build()
    const b = build()
    const rng = () => new Rng(777)
    const rngA = rng()
    const rngB = rng()

    for (let i = 0; i < SECOND * 20; i++) {
      const inA = { ...a.input, pitch: rngA.range(-1, 1), roll: rngA.range(-1, 1) }
      const inB = { ...b.input, pitch: rngB.range(-1, 1), roll: rngB.range(-1, 1) }
      a.craft.step(inA, FIXED_DT)
      b.craft.step(inB, FIXED_DT)
    }

    expect(a.craft.position.toArray()).toEqual(b.craft.position.toArray())
    expect(a.craft.velocity.toArray()).toEqual(b.craft.velocity.toArray())
    expect(a.craft.orientation.toArray()).toEqual(b.craft.orientation.toArray())
    expect(a.craft.throttle).toBe(b.craft.throttle)
  })
})

describe('描画用の補間', () => {
  it('alpha=0 は前ステップ、alpha=1 は現ステップ', () => {
    const { craft, input } = trimmed(250, 3000)
    const before = craft.position.clone()
    craft.step({ ...input, pitch: 0.5 }, FIXED_DT)
    const after = craft.position.clone()

    const out = createAircraftSample()
    craft.sample(0, out)
    expect(out.position.approxEquals(before, 1e-9)).toBe(true)

    craft.sample(1, out)
    expect(out.position.approxEquals(after, 1e-9)).toBe(true)
  })

  it('中間の alpha では前後の間に入る', () => {
    const { craft, input } = trimmed(250, 3000)
    const before = craft.position.clone()
    craft.step(input, FIXED_DT)
    const after = craft.position.clone()

    const out = createAircraftSample()
    craft.sample(0.5, out)

    const expected = before.clone().lerp(after, 0.5)
    expect(out.position.approxEquals(expected, 1e-9)).toBe(true)
    expect(out.orientation.isFinite()).toBe(true)
  })

  it('派生値も一緒に運ばれる', () => {
    const { craft, input } = trimmed(250, 3000)
    run(craft, input, 10)
    const out = createAircraftSample()
    craft.sample(1, out)

    expect(out.speed).toBeCloseTo(craft.speed, 12)
    expect(out.altitude).toBeCloseTo(craft.altitude, 12)
    expect(out.angleOfAttack).toBeCloseTo(craft.angleOfAttack, 12)
    expect(out.throttle).toBeCloseTo(craft.throttle, 12)
    expect(out.crashed).toBe(craft.crashed)
  })
})
