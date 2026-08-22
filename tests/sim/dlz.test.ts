import { describe, it, expect } from 'vitest'
import { createDlz, integrateMissile, maxRange, minimumRange, solveDlz } from '@sim/weapons/dlz'
import { ARM_TIME, BURN_TIME, MISSILE_LIFETIME, Missile } from '@sim/weapons/missile'
import { Target } from '@sim/target'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'

/**
 * DLZ。
 *
 * **実測と突き合わせるのがこのファイルの主眼。**閉形式で近似すると
 * 「それらしい値」が出て検算できない。前方積分の結果が、実際に撃った
 * ときの命中の限界と合うことを見る。
 */

const ORIGIN = new Vec3(0, 3000, 0)

/** 実際に撃って当たるか */
function hits(rangeM: number, targetSpeed: number, headOn: boolean): boolean {
  const target = new Target(
    { offset: new Vec3(0, 0, -rangeM), speed: targetSpeed },
    ORIGIN,
  )
  // 反転して向かってくる相手（方位 180 度）
  if (headOn) (target as unknown as { heading: number }).heading = Math.PI
  const missile = new Missile()
  missile.launch(ORIGIN, new Vec3(0, 0, -250), new Quat(), 0)
  let steps = 0
  while (missile.alive && steps < 120 * 70) {
    target.step(FIXED_DT)
    missile.step(FIXED_DT, target)
    steps++
  }
  return missile.hitTarget
}

/** 実際に当たる最大の距離を二分法で探す */
function findLimit(targetSpeed: number, headOn: boolean): number {
  let lo = 500
  let hi = 45_000
  for (let i = 0; i < 15; i++) {
    const mid = (lo + hi) / 2
    if (hits(mid, targetSpeed, headOn)) lo = mid
    else hi = mid
  }
  return lo
}

describe('前方積分', () => {
  it('燃焼中に伸び、燃え尽きたら鈍る', () => {
    const at2 = integrateMissile(250, 3000, 2)
    const at5 = integrateMissile(250, 3000, BURN_TIME)
    const at10 = integrateMissile(250, 3000, 10)

    expect(at5.speed).toBeGreaterThan(at2.speed)
    expect(at10.speed).toBeLessThan(at5.speed)
    // 距離は伸び続ける
    expect(at10.distance).toBeGreaterThan(at5.distance)
  })

  it('ミサイルの実物と 3% 以内で合う', () => {
    // 誘導なしで直進させたミサイルの飛距離と比べる
    const missile = new Missile()
    missile.launch(ORIGIN, new Vec3(0, 0, -250), new Quat(), -1)
    const seconds = 10
    for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) missile.step(FIXED_DT, null)

    const flown = missile.position.distanceTo(ORIGIN)
    const predicted = integrateMissile(250, 3000, seconds).distance
    expect(Math.abs(predicted - flown) / flown).toBeLessThan(0.03)
  })

  it('高度が上がると空気が薄く、同じ時間で遠くまで飛ぶ', () => {
    const low = integrateMissile(250, 500, 20).distance
    const high = integrateMissile(250, 8000, 20).distance
    expect(high).toBeGreaterThan(low)
  })

  it('飛距離が時間に対して単調に伸びる', () => {
    let previous = 0
    for (const seconds of [1, 2, 5, 10, 20, 40, 60]) {
      const distance = integrateMissile(250, 3000, seconds).distance
      expect(distance, `${seconds}s`).toBeGreaterThan(previous)
      previous = distance
    }
  })
})

describe('rMax は実測と合う', () => {
  it('追う構図。実測 12,126 m に対して 0.5% 以内', () => {
    // 自機 250 m/s・目標 240 m/s が同じ向き。接近速度 10 m/s
    const dlz = solveDlz({
      launchSpeed: 250,
      altitude: 3000,
      targetSpeed: 240,
      closingSpeed: 10,
    })
    const measured = findLimit(240, false)
    expect(dlz.rMax / measured).toBeGreaterThan(0.95)
    expect(dlz.rMax / measured).toBeLessThan(1.05)
  })

  it('正面の構図。追う構図より 3 倍以上遠い', () => {
    const head = solveDlz({
      launchSpeed: 250,
      altitude: 3000,
      targetSpeed: 240,
      closingSpeed: 490,
    })
    const measured = findLimit(240, true)
    expect(head.rMax / measured).toBeGreaterThan(0.95)
    expect(head.rMax / measured).toBeLessThan(1.05)

    const chase = solveDlz({
      launchSpeed: 250,
      altitude: 3000,
      targetSpeed: 240,
      closingSpeed: 10,
    })
    expect(head.rMax).toBeGreaterThan(chase.rMax * 3)
  })

  it('渡すのはミサイルから見た目標の速さ。自機との接近速度ではない', () => {
    // **ここを取り違えて 2.2 倍ずれた。**ミサイルの初速には母機の速度が
    // 入っているので、接近速度をそのまま渡すと二重に数える
    const wrong = maxRange(250, 3000, -10)
    const right = maxRange(250, 3000, 240)
    expect(wrong).toBeGreaterThan(right * 2)
    // 正しいほうが実測に合う
    expect(right / findLimit(240, false)).toBeLessThan(1.05)
  })
})

describe('単調性', () => {
  it('接近速度が上がると rMax が伸びる', () => {
    let previous = -1
    for (const closing of [-100, 0, 100, 300, 490]) {
      const dlz = solveDlz({
        launchSpeed: 250,
        altitude: 3000,
        targetSpeed: 240,
        closingSpeed: closing,
      })
      expect(dlz.rMax, `接近 ${closing}`).toBeGreaterThan(previous)
      previous = dlz.rMax
    }
  })

  it('高度が上がると rMax が伸びる。空気が薄いので抗力が減る', () => {
    let previous = 0
    for (const altitude of [500, 3000, 8000, 12000]) {
      const dlz = solveDlz({
        launchSpeed: 250,
        altitude,
        targetSpeed: 240,
        closingSpeed: 10,
      })
      expect(dlz.rMax, `高度 ${altitude}`).toBeGreaterThan(previous)
      previous = dlz.rMax
    }
  })

  it('母機が速いほど rMax が伸びる。追う構図では接近速度も一緒に上がる', () => {
    // **接近速度を固定して母機だけ速くしても伸びない。**`away` は
    // `launchSpeed − closingSpeed` なので、母機を速くすると目標が離れる
    // 速さも同じだけ増える。実際の交戦では両方が動く
    let previous = 0
    for (const launchSpeed of [150, 180, 250, 380]) {
      // 目標 240 m/s が同じ向きに飛ぶ構図。接近速度はその差になる
      const dlz = solveDlz({
        launchSpeed,
        altitude: 3000,
        targetSpeed: 240,
        closingSpeed: launchSpeed - 240,
      })
      expect(dlz.rMax, `母機 ${launchSpeed}`).toBeGreaterThan(previous)
      previous = dlz.rMax
    }
  })

  it('発射直後の遅さで打ち切らない', () => {
    // 母機 150 m/s から 240 m/s で逃げる相手へ撃つ。初速は目標より遅いが、
    // 燃焼で追い越す。**打ち切りを「速度が目標を割ったら」にすると 0 になる**
    const dlz = solveDlz({
      launchSpeed: 150,
      altitude: 3000,
      targetSpeed: 240,
      closingSpeed: -90,
    })
    expect(dlz.rMax).toBeGreaterThan(9000)
    // 実測 10,160 m
    expect(dlz.rMax / findLimit(240, false)).toBeGreaterThan(0.5)
  })

  it('目標が速いほど rNe が縮む', () => {
    const slow = solveDlz({ launchSpeed: 250, altitude: 3000, targetSpeed: 180, closingSpeed: 10 })
    const fast = solveDlz({ launchSpeed: 250, altitude: 3000, targetSpeed: 340, closingSpeed: 10 })
    expect(fast.rNe).toBeLessThan(slow.rNe)
  })
})

describe('3 つの半径の順序', () => {
  it('rMin < rNe <= rMax が常に成り立つ', () => {
    const out = createDlz()
    for (const closing of [-200, -50, 0, 50, 200, 400, 600]) {
      for (const altitude of [200, 3000, 9000]) {
        for (const targetSpeed of [150, 240, 340]) {
          solveDlz({ launchSpeed: 250, altitude, targetSpeed, closingSpeed: closing }, out)
          const label = `接近 ${closing} / 高度 ${altitude} / 目標 ${targetSpeed}`
          expect(out.rMin, label).toBeLessThanOrEqual(out.rNe)
          expect(out.rNe, label).toBeLessThanOrEqual(out.rMax)
          expect(out.rMin, label).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('rNe は rMax 以下。反転して逃げるほうが厳しい', () => {
    const dlz = solveDlz({
      launchSpeed: 250,
      altitude: 3000,
      targetSpeed: 240,
      closingSpeed: 490,
    })
    expect(dlz.rNe).toBeLessThan(dlz.rMax)
  })

  it('器を使い回す', () => {
    const out = createDlz()
    expect(solveDlz({ launchSpeed: 250, altitude: 3000, targetSpeed: 240, closingSpeed: 10 }, out)).toBe(out)
  })
})

describe('rMin', () => {
  it('安全解除のあいだに閉じる距離より近いと撃てない', () => {
    // 安全解除 0.5 秒。接近速度 490 m/s なら 245 m 閉じる
    expect(minimumRange(490)).toBeGreaterThan(ARM_TIME * 490)
  })

  it('接近が速いほど遠い', () => {
    expect(minimumRange(490)).toBeGreaterThan(minimumRange(100))
    expect(minimumRange(100)).toBeGreaterThan(minimumRange(0))
  })

  it('離れていく相手にも下限が残る', () => {
    expect(minimumRange(-200)).toBeGreaterThan(0)
    expect(minimumRange(-200)).toBe(minimumRange(0))
  })
})

describe('前提', () => {
  it('寿命の内側でしか届かない', () => {
    // 60 秒ぶんの飛距離が上限。それ以上は積分しても伸びない
    const flight = integrateMissile(250, 3000, MISSILE_LIFETIME)
    const dlz = solveDlz({
      launchSpeed: 250,
      altitude: 3000,
      targetSpeed: 240,
      closingSpeed: 10,
    })
    expect(dlz.rMax).toBeLessThan(flight.distance)
  })

  it('止まっている的なら飛距離ぶん届く', () => {
    const flight = integrateMissile(250, 3000, MISSILE_LIFETIME)
    expect(maxRange(250, 3000, 0)).toBeCloseTo(flight.distance, 0)
  })
})
