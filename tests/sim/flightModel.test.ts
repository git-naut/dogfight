import { describe, it, expect } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { airDensity, dynamicPressure, GRAVITY } from '@sim/isa'
import {
  AIRCRAFT,
  CL_MAX,
  INDUCED_DRAG_FACTOR,
  angleOfAttack,
  applyAoaLimiter,
  availableThrust,
  bankAngle,
  controlAuthority,
  dragCoefficient,
  dragMagnitude,
  gLimitedPitchRate,
  lagFactor,
  liftCoefficient,
  liftDirection,
  liftMagnitude,
  sideslipAngle,
  trimCondition,
} from '@sim/flightModel'

const DEG = Math.PI / 180

describe('機体諸元', () => {
  it('アスペクト比が翼幅と翼面積から導かれている', () => {
    // 翼幅 11.43 m、翼面積 37.16 m²
    expect(AIRCRAFT.aspectRatio).toBeCloseTo((11.43 * 11.43) / 37.16, 10)
    expect(AIRCRAFT.aspectRatio).toBeGreaterThan(3.5)
    expect(AIRCRAFT.aspectRatio).toBeLessThan(3.6)
  })

  it('誘導抗力係数が 1/(π·AR·e) と一致する', () => {
    const expected =
      1 / (Math.PI * AIRCRAFT.aspectRatio * AIRCRAFT.oswaldEfficiency)
    expect(INDUCED_DRAG_FACTOR).toBeCloseTo(expected, 12)
    expect(INDUCED_DRAG_FACTOR).toBeCloseTo(0.1132, 3)
  })

  it('翼面荷重が戦闘機の妥当な範囲に入る', () => {
    const wingLoading = (AIRCRAFT.mass * GRAVITY) / AIRCRAFT.wingArea
    // F/A-18C の戦闘重量ではおよそ 4,400 N/m²。F-16 級の 3,300 より高い
    expect(wingLoading).toBeGreaterThan(4100)
    expect(wingLoading).toBeLessThan(4700)
  })

  it('推力重量比が戦闘機の妥当な範囲に入る', () => {
    // F/A-18C は戦闘重量で 0.96。1 を割るのが実機どおり。F-16 は 1.28 だった
    const ratio = AIRCRAFT.maxThrust / (AIRCRAFT.mass * GRAVITY)
    expect(ratio).toBeGreaterThan(0.9)
    expect(ratio).toBeLessThan(1.05)
  })
})

describe('揚力係数', () => {
  it('失速角までは迎角に比例する', () => {
    for (const deg of [0, 2, 5, 10, 20, 27]) {
      const a = deg * DEG
      expect(liftCoefficient(a)).toBeCloseTo(AIRCRAFT.liftSlope * a, 12)
    }
  })

  it('頭打ちの迎角で最大になり、失速角まで一定', () => {
    expect(liftCoefficient(AIRCRAFT.clPeakAngle)).toBeCloseTo(CL_MAX, 12)
    expect(liftCoefficient(AIRCRAFT.stallAngle)).toBeCloseTo(CL_MAX, 12)
    expect(liftCoefficient(32 * DEG)).toBeCloseTo(CL_MAX, 12)
    // LEX で渦揚力が伸びる戦闘機の妥当な範囲。平坦部なしに失速角を
    // 38 度まで伸ばすと 2.66 になり実機から外れる
    expect(CL_MAX).toBeCloseTo(1.899, 2)
    expect(CL_MAX).toBeGreaterThan(1.8)
    expect(CL_MAX).toBeLessThan(2.0)
  })

  it('迎角制限が平坦部の内側にある（制限角まで引いても揚力が落ちない）', () => {
    expect(AIRCRAFT.aoaLimit).toBeGreaterThan(AIRCRAFT.clPeakAngle)
    expect(AIRCRAFT.aoaLimit).toBeLessThan(AIRCRAFT.stallAngle)
  })

  it('失速角を超えると揚力係数が下がる', () => {
    expect(liftCoefficient(40 * DEG)).toBeLessThan(liftCoefficient(38 * DEG))
    expect(liftCoefficient(44 * DEG)).toBeLessThan(liftCoefficient(40 * DEG))
  })

  it('下げ止まり以降は一定', () => {
    const floor = CL_MAX * AIRCRAFT.postStallRetention
    expect(liftCoefficient(48 * DEG)).toBeCloseTo(floor, 12)
    expect(liftCoefficient(60 * DEG)).toBeCloseTo(floor, 12)
    expect(liftCoefficient(90 * DEG)).toBeCloseTo(floor, 12)
  })

  it('負の迎角に対して対称', () => {
    for (const deg of [1, 10, 27, 38, 44, 60]) {
      expect(liftCoefficient(-deg * DEG)).toBeCloseTo(-liftCoefficient(deg * DEG), 12)
    }
  })

  it('迎角ゼロで揚力ゼロ', () => {
    expect(liftCoefficient(0)).toBe(0)
  })
})

describe('抗力係数', () => {
  it('揚力ゼロのとき有害抗力だけになる', () => {
    expect(dragCoefficient(0)).toBeCloseTo(AIRCRAFT.cd0, 12)
  })

  it('誘導抗力が揚力係数の 2 乗に比例する', () => {
    const base = dragCoefficient(0.5) - AIRCRAFT.cd0
    const doubled = dragCoefficient(1.0) - AIRCRAFT.cd0
    expect(doubled / base).toBeCloseTo(4, 10)
  })

  it('抗力が速度の 2 乗に比例する（同じ揚力係数のとき）', () => {
    const rho = 1.225
    const cl = 0.4
    const cd = dragCoefficient(cl)
    const at100 = dragMagnitude(dynamicPressure(rho, 100), cd)
    const at200 = dragMagnitude(dynamicPressure(rho, 200), cd)
    expect(at200 / at100).toBeCloseTo(4, 10)
  })

  it('揚力も速度の 2 乗に比例する', () => {
    const rho = 1.225
    const at100 = liftMagnitude(dynamicPressure(rho, 100), 0.4)
    const at300 = liftMagnitude(dynamicPressure(rho, 300), 0.4)
    expect(at300 / at100).toBeCloseTo(9, 10)
  })
})

describe('姿勢から導く角度', () => {
  it('速度と機首が揃っていれば迎角ゼロ', () => {
    const vDir = new Vec3(0, 0, -1)
    const up = new Vec3(0, 1, 0)
    expect(angleOfAttack(vDir, up)).toBeCloseTo(0, 12)
  })

  it('機首が流れより上を向いていれば迎角は正', () => {
    // 機体は水平のまま、速度が斜め下へ向かっている状態
    const vDir = new Vec3(0, -Math.sin(10 * DEG), -Math.cos(10 * DEG))
    const up = new Vec3(0, 1, 0)
    expect(angleOfAttack(vDir, up)).toBeCloseTo(10 * DEG, 10)
  })

  it('機首が流れより下を向いていれば迎角は負', () => {
    const vDir = new Vec3(0, Math.sin(7 * DEG), -Math.cos(7 * DEG))
    const up = new Vec3(0, 1, 0)
    expect(angleOfAttack(vDir, up)).toBeCloseTo(-7 * DEG, 10)
  })

  it('右から風を受けていれば横滑り角は正', () => {
    const vDir = new Vec3(Math.sin(5 * DEG), 0, -Math.cos(5 * DEG))
    const right = new Vec3(1, 0, 0)
    expect(sideslipAngle(vDir, right)).toBeCloseTo(5 * DEG, 10)
  })

  it('水平ならバンク角ゼロ、右に倒せば正', () => {
    expect(bankAngle(new Vec3(0, 1, 0), new Vec3(1, 0, 0))).toBeCloseTo(0, 12)
    // 右に 90 度ロール: up が +X、right が -Y
    expect(bankAngle(new Vec3(1, 0, 0), new Vec3(0, -1, 0))).toBeCloseTo(
      Math.PI / 2,
      12,
    )
    // 左に 90 度ロール
    expect(bankAngle(new Vec3(-1, 0, 0), new Vec3(0, 1, 0))).toBeCloseTo(
      -Math.PI / 2,
      12,
    )
  })
})

describe('揚力の向き', () => {
  it('速度と直交する', () => {
    const vDir = new Vec3(0.2, -0.3, -0.9).normalize()
    const up = new Vec3(0.1, 0.98, 0.05).normalize()
    const dir = liftDirection(vDir, up)
    expect(dir.length()).toBeCloseTo(1, 12)
    expect(Math.abs(dir.dot(vDir))).toBeLessThan(1e-12)
  })

  it('機体上方向の側を向く', () => {
    const vDir = new Vec3(0, 0, -1)
    const up = new Vec3(0, 1, 0)
    expect(liftDirection(vDir, up).approxEquals(new Vec3(0, 1, 0), 1e-12)).toBe(true)
  })

  it('速度と機体上方向が平行ならゼロを返す（NaN を出さない）', () => {
    const dir = liftDirection(new Vec3(0, 1, 0), new Vec3(0, 1, 0))
    expect(dir.isFinite()).toBe(true)
    expect(dir.length()).toBe(0)
  })
})

describe('操縦の制限', () => {
  it('舵の効きが動圧に比例し、上下限で頭打ちになる', () => {
    const q = (v: number) => dynamicPressure(1.225, v)
    expect(controlAuthority(q(120))).toBeCloseTo(1, 12)
    expect(controlAuthority(q(240))).toBe(1) // 上限で頭打ち
    expect(controlAuthority(q(60))).toBeCloseTo(0.25, 10) // 動圧は 1/4
    expect(controlAuthority(0)).toBe(AIRCRAFT.minControlAuthority)
  })

  it('G 制限のピッチ率が速度に反比例する', () => {
    const at200 = gLimitedPitchRate(200)
    const at400 = gLimitedPitchRate(400)
    expect(at400).toBeCloseTo(at200 / 2, 10)
  })

  it('G 制限のピッチ率が √(n²-1)·g/v と一致する', () => {
    const v = 250
    const expected = (Math.sqrt(AIRCRAFT.gLimit ** 2 - 1) * GRAVITY) / v
    expect(gLimitedPitchRate(v)).toBeCloseTo(expected, 12)
    // 250 m/s で 7.5G なら毎秒 17 度前後。F-16 の 9G では 20 度だった
    expect(gLimitedPitchRate(250) / DEG).toBeGreaterThan(16)
    expect(gLimitedPitchRate(250) / DEG).toBeLessThan(18)
  })

  it('停止寸前でも G 制限が発散しない', () => {
    expect(gLimitedPitchRate(0)).toBe(AIRCRAFT.maxPitchRate)
    expect(Number.isFinite(gLimitedPitchRate(0.001))).toBe(true)
  })

  it('迎角制限器は余裕があるとき指令を通す', () => {
    expect(applyAoaLimiter(1, 0)).toBeCloseTo(1, 12)
    expect(applyAoaLimiter(1, 5 * DEG)).toBeCloseTo(1, 12)
  })

  it('迎角制限器は制限角で指令をゼロにする', () => {
    expect(applyAoaLimiter(1, AIRCRAFT.aoaLimit)).toBeCloseTo(0, 12)
    expect(applyAoaLimiter(1, AIRCRAFT.aoaLimit + 0.1)).toBeCloseTo(0, 12)
  })

  it('迎角制限器は手前で徐々に絞る', () => {
    // 制限角 35 度の 3 割手前から絞り始める
    const near = applyAoaLimiter(1, 31 * DEG)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(1)
  })

  it('迎角制限器は戻す方向の操作を妨げない', () => {
    // 制限角に張り付いていても機首下げは効く
    expect(applyAoaLimiter(-1, AIRCRAFT.aoaLimit)).toBeCloseTo(-1, 12)
    // 負側の制限に張り付いていても機首上げは効く
    expect(applyAoaLimiter(1, AIRCRAFT.aoaLimitNegative)).toBeCloseTo(1, 12)
    expect(applyAoaLimiter(-1, AIRCRAFT.aoaLimitNegative)).toBeCloseTo(0, 12)
  })
})

describe('一次遅れ', () => {
  it('時定数ぶん経つと 63% 進む', () => {
    expect(lagFactor(0.12, 0.12)).toBeCloseTo(1 - Math.E ** -1, 12)
  })

  it('刻み幅を変えても同じ時間で同じ位置に収束する', () => {
    const tau = 0.3
    const run = (dt: number, seconds: number) => {
      let x = 0
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        x += (1 - x) * lagFactor(dt, tau)
      }
      return x
    }
    const coarse = run(1 / 30, 1)
    const fine = run(1 / 480, 1)
    expect(Math.abs(coarse - fine)).toBeLessThan(0.01)
    expect(fine).toBeCloseTo(1 - Math.E ** (-1 / tau), 3)
  })

  it('時定数ゼロなら即座に追従する', () => {
    expect(lagFactor(0.01, 0)).toBe(1)
  })
})

describe('推力', () => {
  it('高度が上がると空気が薄くなり推力が落ちる', () => {
    const sea = availableThrust(1, airDensity(0))
    const high = availableThrust(1, airDensity(10_000))
    expect(sea).toBeCloseTo(AIRCRAFT.maxThrust, 6)
    expect(high).toBeLessThan(sea * 0.4)
  })

  it('スロットルに比例する', () => {
    const rho = airDensity(0)
    expect(availableThrust(0.5, rho)).toBeCloseTo(availableThrust(1, rho) / 2, 6)
  })
})

describe('水平定常飛行のトリム', () => {
  const speed = 250
  const altitude = 1000
  const rho = airDensity(altitude)

  it('揚力が重量と釣り合う', () => {
    const { alpha } = trimCondition(speed, rho)
    const q = dynamicPressure(rho, speed)
    const lift = liftMagnitude(q, liftCoefficient(alpha))
    const weight = AIRCRAFT.mass * GRAVITY
    expect(Math.abs(lift - weight) / weight).toBeLessThan(1e-9)
  })

  it('推力が抗力と釣り合う', () => {
    const { alpha, throttle } = trimCondition(speed, rho)
    const q = dynamicPressure(rho, speed)
    const drag = dragMagnitude(q, dragCoefficient(liftCoefficient(alpha)))
    const thrust = availableThrust(throttle, rho)
    expect(Math.abs(thrust - drag) / drag).toBeLessThan(1e-9)
  })

  it('高度 1000 m・速度 250 m/s の迎角が 1.8 度前後', () => {
    // 翼面荷重が F-16 級の 3,330 から 4,395 N/m² へ上がったぶん、
    // 同じ条件でも迎角が 1.37 度から増える
    const { alpha } = trimCondition(speed, rho)
    expect(alpha / DEG).toBeCloseTo(1.81, 1)
  })

  it('同じ条件のスロットルが 2 割半', () => {
    const { throttle } = trimCondition(speed, rho)
    expect(throttle).toBeGreaterThan(0.2)
    expect(throttle).toBeLessThan(0.3)
  })

  it('速度が上がるとトリム迎角が下がる', () => {
    expect(trimCondition(400, rho).alpha).toBeLessThan(trimCondition(200, rho).alpha)
  })

  it('高度が上がるとトリム迎角が上がる', () => {
    expect(trimCondition(speed, airDensity(9000)).alpha).toBeGreaterThan(
      trimCondition(speed, airDensity(0)).alpha,
    )
  })
})

describe('コーナー速度', () => {
  it('9G と最大揚力の交点が 170 m/s 前後になる', () => {
    // 揚力で出せる荷重倍数が gLimit に達する速度を二分探索で求める
    const rho = airDensity(1000)
    const weight = AIRCRAFT.mass * GRAVITY
    const loadFactor = (v: number) =>
      liftMagnitude(dynamicPressure(rho, v), CL_MAX) / weight

    let lo = 50
    let hi = 400
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (loadFactor(mid) < AIRCRAFT.gLimit) lo = mid
      else hi = mid
    }

    // 実機 F-16 のコーナー速度（およそ 350 KIAS ≒ 180 m/s）と同程度
    expect(lo).toBeGreaterThan(155)
    expect(lo).toBeLessThan(190)
  })
})
