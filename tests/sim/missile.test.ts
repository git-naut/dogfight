import { describe, it, expect } from 'vitest'
import {
  ARM_TIME,
  BURN_TIME,
  FUZE_RADIUS,
  MAX_LATERAL_G,
  MISSILE_MASS,
  MISSILE_SEEKER_ANGLE,
  Missile,
  NAV_CONSTANT,
  PROPELLANT_MASS,
  closingSpeed,
  proportionalNavigation,
  setOrientationFromForward,
  zeroEffortMiss,
} from '@sim/weapons/missile'
import { Target } from '@sim/target'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { GRAVITY } from '@sim/isa'

/**
 * ミサイルと比例航法。
 *
 * Phase 5 の中心。**航法定数の意味を検証に落とし込む**のがこのファイルの
 * 主眼で、「N = 3.5 なら当たる」だけでなく「N = 1.5 では当たらない」を
 * 同じ物理で並べて書く。片方だけだと、当たったのが誘導のおかげなのか
 * ただ正面へ飛んだからなのか区別が付かない。
 */

const ORIGIN = new Vec3(0, 3000, 0)
const v = (x: number, y: number, z: number): Vec3 => new Vec3(x, y, z)

interface Engagement {
  /** 最接近距離 m */
  minRange: number
  /** 命中したか */
  hit: boolean
  /** 経過秒 */
  elapsed: number
  missile: Missile
  target: Target
}

/**
 * 発射して決着まで回す。
 *
 * @param navConstant 航法定数。既定は本番の値
 */
function engage(options: {
  navConstant?: number
  targetOffset?: Vec3
  targetSpeed?: number
  turnRate?: number
  launchVelocity?: Vec3
  seconds?: number
}): Engagement {
  const target = new Target(
    {
      offset: options.targetOffset ?? v(0, 0, -4000),
      speed: options.targetSpeed ?? 240,
      ...(options.turnRate !== undefined ? { turnRate: options.turnRate } : {}),
    },
    ORIGIN,
  )
  const missile = new Missile(
    options.navConstant !== undefined ? { navConstant: options.navConstant } : {},
  )
  missile.launch(ORIGIN, options.launchVelocity ?? v(0, 0, -250), new Quat(), 0)

  let minRange = Infinity
  let steps = 0
  const limit = Math.round((options.seconds ?? 40) / FIXED_DT)
  while (missile.alive && steps < limit) {
    target.step(FIXED_DT)
    missile.step(FIXED_DT, target)
    const range = missile.position.distanceTo(target.position)
    if (range < minRange) minRange = range
    steps++
  }
  return { minRange, hit: missile.hitTarget, elapsed: steps * FIXED_DT, missile, target }
}

describe('比例航法の式', () => {
  it('加速度指令がミサイル速度に直交する', () => {
    // 外積の性質そのもの。この直交性があるので、指令が速度の大きさを変えない
    const cases = [
      { mp: v(0, 0, 0), mv: v(0, 0, -300), tp: v(500, 100, -3000), tv: v(0, 0, -240) },
      { mp: v(-100, 50, 200), mv: v(120, -30, -400), tp: v(900, 300, -2000), tv: v(-80, 10, -200) },
      { mp: v(10, 10, 10), mv: v(0, 250, 0), tp: v(0, 4000, 100), tv: v(30, 0, 0) },
    ]
    for (const [i, c] of cases.entries()) {
      const a = proportionalNavigation(c.mp, c.mv, c.tp, c.tv, NAV_CONSTANT)
      const cos = a.dot(c.mv) / (a.length() * c.mv.length())
      expect(Math.abs(cos), `${i} 番`).toBeLessThan(1e-9)
    }
  })

  it('視線の回転がなければ指令が 0。衝突進路はそのまま', () => {
    // 真正面へ、相対速度が視線と平行。回転率 0 なので何もしない
    const a = proportionalNavigation(v(0, 0, 0), v(0, 0, -600), v(0, 0, -3000), v(0, 0, -240), NAV_CONSTANT)
    expect(a.length()).toBeLessThan(1e-9)
  })

  it('航法定数に比例する', () => {
    const args = [v(0, 0, 0), v(0, 0, -600), v(800, 0, -3000), v(0, 0, -240)] as const
    const a3 = proportionalNavigation(args[0], args[1], args[2], args[3], 3).clone()
    const a6 = proportionalNavigation(args[0], args[1], args[2], args[3], 6)
    expect(a6.length()).toBeCloseTo(a3.length() * 2, 6)
  })

  it('視線が回る向きへ回り込む', () => {
    // 標的が右（+X）にいて右へ流れている。指令は右向きの成分を持つ
    const a = proportionalNavigation(v(0, 0, 0), v(0, 0, -600), v(500, 0, -3000), v(200, 0, -240), NAV_CONSTANT)
    expect(a.x).toBeGreaterThan(0)
  })

  it('距離が同じでも横切る速さが大きいほど強い指令', () => {
    const slow = proportionalNavigation(v(0, 0, 0), v(0, 0, -600), v(0, 0, -3000), v(50, 0, -240), NAV_CONSTANT).clone()
    const fast = proportionalNavigation(v(0, 0, 0), v(0, 0, -600), v(0, 0, -3000), v(200, 0, -240), NAV_CONSTANT)
    expect(fast.length()).toBeGreaterThan(slow.length())
  })
})

describe('接近速度', () => {
  it('正面から追うと正', () => {
    expect(closingSpeed(v(0, 0, 0), v(0, 0, -600), v(0, 0, -3000), v(0, 0, -240))).toBeCloseTo(360, 6)
  })

  it('相手のほうが速ければ負', () => {
    expect(closingSpeed(v(0, 0, 0), v(0, 0, -200), v(0, 0, -3000), v(0, 0, -400))).toBeCloseTo(-200, 6)
  })

  it('真横へ動くだけなら 0', () => {
    expect(closingSpeed(v(0, 0, 0), v(0, 0, 0), v(0, 0, -1000), v(300, 0, 0))).toBeCloseTo(0, 6)
  })
})

describe('零化距離', () => {
  it('衝突進路なら 0', () => {
    // まっすぐ向かい合っていれば、このまま飛べば当たる
    expect(zeroEffortMiss(v(0, 0, 0), v(0, 0, -600), v(0, 0, -3000), v(0, 0, -240))).toBeCloseTo(0, 6)
  })

  it('外している進路では正', () => {
    expect(
      zeroEffortMiss(v(0, 0, 0), v(0, 0, -600), v(800, 0, -3000), v(0, 0, -240)),
    ).toBeGreaterThan(100)
  })

  it('比例航法が零化距離を縮める', () => {
    // 発射直後と中盤で比べる。誘導が効いていれば減る
    const target = new Target({ offset: v(900, 0, -5000), speed: 240 }, ORIGIN)
    const missile = new Missile()
    missile.launch(ORIGIN, v(0, 0, -250), new Quat(), 0)

    const zemAt = (): number =>
      zeroEffortMiss(missile.position, missile.velocity, target.position, target.velocity)

    // 誘導が立ち上がるまで少し進める
    for (let i = 0; i < 30; i++) {
      target.step(FIXED_DT)
      missile.step(FIXED_DT, target)
    }
    const early = zemAt()

    for (let i = 0; i < 120 * 4; i++) {
      target.step(FIXED_DT)
      missile.step(FIXED_DT, target)
    }
    expect(zemAt()).toBeLessThan(early)
  })
})

/** 視線回転率の大きさ rad/s */
function losRate(missile: Missile, target: Target): number {
  const r = target.position.clone().sub(missile.position)
  const rel = target.velocity.clone().sub(missile.velocity)
  return r.clone().crossVectors(r, rel).length() / r.lengthSq()
}

/**
 * 残り距離が threshold を切った時点の視線回転率を集める。
 *
 * 終末の挙動を距離で切って見る。時間で切ると N ごとに飛行時間が違って
 * 比べられない。
 */
function losRateAtRanges(navConstant: number, ranges: number[]): number[] {
  const target = new Target({ offset: v(900, 0, -5000), speed: 240 }, ORIGIN)
  const missile = new Missile({ navConstant })
  missile.launch(ORIGIN, v(0, 0, -250), new Quat(), 0)

  const found = new Array<number>(ranges.length).fill(NaN)
  let steps = 0
  while (missile.alive && steps < 120 * 40) {
    target.step(FIXED_DT)
    missile.step(FIXED_DT, target)
    const range = missile.position.distanceTo(target.position)
    const rate = losRate(missile, target)
    for (let i = 0; i < ranges.length; i++) {
      if (Number.isNaN(found[i]!) && range <= ranges[i]!) found[i] = rate
    }
    steps++
  }
  return found
}

describe('航法定数の意味を検証に落とす', () => {
  /**
   * 非機動の目標に対する視線回転率は λ̇ ∝ t_go^(N−2) で推移する。
   * N > 2 なら終末へ向かって 0 に収束し、N < 2 なら発散する。
   */
  const RANGES = [2000, 1000, 500, 200]

  it('N = 1 は距離を詰めるほど視線回転率が増える。これが発散', () => {
    const rates = losRateAtRanges(1, RANGES)
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]!, `${RANGES[i]} m`).toBeGreaterThan(rates[i - 1]!)
    }
    // 実測 26.91 → 53.51 mrad/s
    expect(rates[0]!).toBeGreaterThan(0.02)
    expect(rates[rates.length - 1]! / rates[0]!).toBeGreaterThan(1.5)
  })

  it('N = 3.5 は 0 へ収束する。2,000 m の時点で N = 1 の 100 分の 1', () => {
    const slow = losRateAtRanges(1, RANGES)
    const fast = losRateAtRanges(3.5, RANGES)
    // 実測 26.91 対 0.26 mrad/s
    expect(fast[0]!).toBeLessThan(slow[0]! / 50)
    // 中盤でも 1 mrad/s を割る
    expect(fast[1]!).toBeLessThan(0.002)
  })

  it('N を上げるほど中盤の視線回転率が小さい', () => {
    const at1000 = [1, 1.5, 2, 3.5].map((n) => losRateAtRanges(n, [1000])[0]!)
    for (let i = 1; i < at1000.length; i++) {
      expect(at1000[i]!, `N=${[1, 1.5, 2, 3.5][i]}`).toBeLessThan(at1000[i - 1]!)
    }
  })

  it('横切りの大きい構図では N < 2 が外れる', () => {
    // **易しい構図では N = 1 でも当たる。**このミサイルは目標より 3 倍速く
    // 信管半径が 8 m あるので、終末の数十ミリ秒で発散しても間に合う。
    // 差が出るのは横切りの大きい構図。実測 N=1 で 417 m、N=1.5 で 27 m
    const crossing = v(3000, 200, -2000)
    const n1 = engage({ navConstant: 1, targetOffset: crossing })
    const n15 = engage({ navConstant: 1.5, targetOffset: crossing })
    const n2 = engage({ navConstant: 2, targetOffset: crossing })
    const n35 = engage({ navConstant: 3.5, targetOffset: crossing })

    expect(n1.hit, 'N=1').toBe(false)
    expect(n1.minRange).toBeGreaterThan(200)
    expect(n15.hit, 'N=1.5').toBe(false)
    expect(n2.hit, 'N=2').toBe(true)
    expect(n35.hit, 'N=3.5').toBe(true)
  })

  it('易しい構図なら低い N でも当たる。当たったこと自体は誘導の証明にならない', () => {
    // この事実を書いておかないと、「当たった」を誘導が効いた根拠に
    // 使ってしまう。正面 4 km の的には N = 1 でも当たる
    const r = engage({ navConstant: 1, targetOffset: v(0, 0, -4000) })
    expect(r.hit).toBe(true)
  })

  it('本番の N = 3.5 は直進の的に当たる', () => {
    const r = engage({})
    expect(r.hit).toBe(true)
    expect(r.minRange).toBeLessThanOrEqual(FUZE_RADIUS + 8)
  })

  it('旋回する的にも当たる。視線が速く回る構図', () => {
    const r = engage({ targetOffset: v(0, 0, -5000), turnRate: 0.08 })
    expect(r.hit).toBe(true)
    expect(r.minRange).toBeLessThanOrEqual(FUZE_RADIUS + 8)
  })

  it('横から出しても回り込んで当たる', () => {
    const r = engage({ targetOffset: v(3000, 200, -2000) })
    expect(r.hit).toBe(true)
  })
})

describe('モータと抗力', () => {
  it('燃焼中に加速して、燃え尽きたら減速に転じる', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)

    const speedAt = (seconds: number): number => {
      const target = Math.round(seconds / FIXED_DT)
      while (Math.round(m.age / FIXED_DT) < target && m.alive) m.step(FIXED_DT, null)
      return m.velocity.length()
    }
    const at1 = speedAt(1)
    const at5 = speedAt(BURN_TIME)
    const at8 = speedAt(8)

    expect(at1).toBeGreaterThan(250)
    expect(at5).toBeGreaterThan(at1)
    expect(at8).toBeLessThan(at5)
  })

  it('燃焼終了でマッハ 2.4 を超える。公表値 2.5 の逆算が合っている', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    for (let i = 0; i < Math.round(BURN_TIME / FIXED_DT); i++) m.step(FIXED_DT, null)
    // 実測 2.46
    expect(m.mach).toBeGreaterThan(2.4)
    expect(m.mach).toBeLessThan(2.6)
  })

  it('推進剤を消費して軽くなる', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    expect(m.mass).toBe(MISSILE_MASS)
    for (let i = 0; i < Math.round(BURN_TIME / FIXED_DT); i++) m.step(FIXED_DT, null)
    expect(m.mass).toBeCloseTo(MISSILE_MASS - PROPELLANT_MASS, 1)
  })

  it('燃え尽きたあとは質量が変わらない', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    for (let i = 0; i < Math.round((BURN_TIME + 3) / FIXED_DT); i++) m.step(FIXED_DT, null)
    expect(m.mass).toBeCloseTo(MISSILE_MASS - PROPELLANT_MASS, 1)
  })

  it('誘導していれば高度を保つ。揚力のない弾体が落ちきらない', () => {
    // 実測。重力の打ち消しを入れる前は 12 秒で 927 m 落ちた
    const r = engage({ targetOffset: v(0, 0, -6000) })
    expect(r.hit).toBe(true)
    expect(Math.abs(r.missile.position.y - r.target.position.y)).toBeLessThan(50)
  })

  it('誘導していなければ落ちる。打ち消しは誘導の一部', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    for (let i = 0; i < 120 * 8; i++) m.step(FIXED_DT, null)
    expect(ORIGIN.y - m.position.y).toBeGreaterThan(100)
  })
})

describe('シーカーと信管', () => {
  it('視野の外へ出ると誘導が止まる', () => {
    const m = new Missile()
    // 真後ろにいる相手。ミサイルの進行方向から 180 度
    const behind = new Target({ offset: v(0, 0, 3000), speed: 240 }, ORIGIN)
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), 0)
    m.step(FIXED_DT, behind)
    expect(m.guiding).toBe(false)
    // 相手の添字は消さない。近接信管は失探後も働く
    expect(m.targetIndex).toBe(0)
  })

  it('視野の内側なら誘導する', () => {
    const m = new Missile()
    const ahead = new Target({ offset: v(0, 0, -3000), speed: 240 }, ORIGIN)
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), 0)
    m.step(FIXED_DT, ahead)
    expect(m.guiding).toBe(true)
  })

  it('シーカーの視野は 60 度', () => {
    expect((MISSILE_SEEKER_ANGLE * 180) / Math.PI).toBeCloseTo(60, 6)
  })

  it('安全解除の前は起爆しない', () => {
    // 発射位置のすぐ隣に相手を置く
    const m = new Missile()
    const close = new Target({ offset: v(3, 0, -3), speed: 240 }, ORIGIN)
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), 0)
    m.step(FIXED_DT, close)
    expect(m.age).toBeLessThan(ARM_TIME)
    expect(m.state).toBe('flying')
  })

  it('近接信管は掃引で見る。1 ステップで殺傷半径を跨いでも捉える', () => {
    // マッハ 2.5 で正面から向かい合うと 1 ステップで 8.6 m 以上進む。
    // 距離が閾値を割った瞬間で判定すると通過してしまう
    const r = engage({ targetOffset: v(0, 0, -8000), targetSpeed: 300 })
    expect(r.hit).toBe(true)
  })

  it('落ちた相手には起爆しない', () => {
    const target = new Target({ offset: v(0, 0, -2000), speed: 240 }, ORIGIN)
    target.damage(999)
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), 0)
    for (let i = 0; i < 120 * 10 && m.alive; i++) {
      m.step(FIXED_DT, target)
    }
    expect(m.hitTarget).toBe(false)
  })

  it('起爆した位置が相手の近くにある', () => {
    const r = engage({})
    expect(r.hit).toBe(true)
    expect(r.missile.detonation.distanceTo(r.target.position)).toBeLessThan(FUZE_RADIUS + 10)
  })
})

describe('横加速度の上限', () => {
  it('指令が上限でクランプされる', () => {
    // 至近で真横へ動く相手。素の指令は上限を大きく超える
    const raw = proportionalNavigation(
      v(0, 0, 0),
      v(0, 0, -800),
      v(0, 0, -100),
      v(600, 0, 0),
      NAV_CONSTANT,
    )
    expect(raw.length()).toBeGreaterThan(MAX_LATERAL_G * GRAVITY)

    // ミサイルを通すとクランプされる。速度の変化から加速度を測る
    const m = new Missile()
    const crossing = new Target({ offset: v(0, 0, -100), speed: 600 }, ORIGIN)
    m.launch(ORIGIN, v(0, 0, -800), new Quat(), 0)
    const before = m.velocity.clone()
    m.step(FIXED_DT, crossing)
    const delta = m.velocity.clone().sub(before).multiplyScalar(1 / FIXED_DT)
    // 重力と推力と抗力も混ざるので、上限より少し大きいところで見る
    expect(delta.length()).toBeLessThan(MAX_LATERAL_G * GRAVITY * 1.5)
  })

  it('上限は 30 G', () => {
    expect(MAX_LATERAL_G).toBe(30)
  })
})

describe('姿勢', () => {
  it('機首が速度の向きを向く', () => {
    const r = engage({ targetOffset: v(2000, 0, -3000) })
    const nose = r.missile.orientation.forward()
    const direction = r.missile.velocity.clone().normalize()
    expect(nose.dot(direction)).toBeGreaterThan(0.999)
  })

  it('setOrientationFromForward が向きを合わせる', () => {
    for (const dir of [v(0, 0, -1), v(1, 0, 0), v(0, 1, 0), v(0.3, -0.5, 0.8).normalize()]) {
      const q = setOrientationFromForward(dir, new Quat())
      const nose = q.forward()
      expect(nose.x, `${dir.toArray()}`).toBeCloseTo(dir.x, 9)
      expect(nose.y).toBeCloseTo(dir.y, 9)
      expect(nose.z).toBeCloseTo(dir.z, 9)
    }
  })

  it('真後ろでも壊れない', () => {
    const q = setOrientationFromForward(v(0, 0, 1), new Quat())
    const nose = q.forward()
    expect(nose.z).toBeCloseTo(1, 6)
  })
})

describe('煙の履歴', () => {
  it('飛んだぶんだけ点が増える', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    expect(m.trailLength).toBe(0)
    for (let i = 0; i < 40; i++) m.step(FIXED_DT, null)
    expect(m.trailLength).toBe(10)
  })

  it('燃焼中は濃く、燃え尽きたら薄い', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    for (let i = 0; i < 120; i++) m.step(FIXED_DT, null)
    expect(m.trailPoint(0).smoke).toBe(1)

    for (let i = 0; i < 120 * BURN_TIME; i++) m.step(FIXED_DT, null)
    expect(m.trailPoint(0).smoke).toBeLessThan(1)
    expect(m.trailPoint(0).smoke).toBeGreaterThan(0)
  })

  it('撃ち直すと前の煙が消える', () => {
    const m = new Missile()
    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    for (let i = 0; i < 120; i++) m.step(FIXED_DT, null)
    expect(m.trailLength).toBeGreaterThan(20)

    m.launch(ORIGIN, v(0, 0, -250), new Quat(), -1)
    expect(m.trailLength).toBe(0)
  })
})

describe('決定論', () => {
  it('同じ初期条件から同じ軌跡が出る', () => {
    const trace = (): number[] => {
      const r = engage({ targetOffset: v(700, 100, -4000), turnRate: 0.05 })
      return [r.minRange, r.elapsed, r.missile.position.x, r.missile.position.y, r.missile.position.z]
    }
    expect(trace()).toEqual(trace())
  })
})
