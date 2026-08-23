import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { FIXED_DT } from '@sim/loop'
import { Aircraft } from '@sim/aircraft'
import { makeInput } from '@sim/input'
import { GRAVITY } from '@sim/isa'
import {
  GAMMA_TAU,
  PUSH_LIMIT,
  ROLL_BAND,
  STEER_THRESHOLD,
  climbAngleOf,
  levelAndClimb,
  rollRateOf,
  steerToward,
  type Flyer,
  type Steering,
} from '@sim/ai/steering'

/**
 * 指令加速度から操縦への写し方。
 *
 * **符号を式の見た目で確かめてはいけない。**Phase 4 でエルロンの符号を
 * 二重に反転させ、左右のエルロンが揃って上がった。気づいたのは後縁の点が
 * どちらへ動くかを手で計算したとき。
 *
 * だからここでは 2 段で見る。まず指令に対する `pitch` と `roll` の符号を
 * 固定する。そのあと**実際に `Aircraft` を回して、速度が指令の向きへ
 * 曲がることを確かめる。**符号が逆なら反対へ曲がるので必ず落ちる。
 */

/** 水平飛行で 250 m/s。姿勢は無回転（機首 −Z、上 +Y、右 +X） */
function level(overrides: Partial<Flyer> = {}): Flyer {
  return {
    orientation: new Quat(),
    velocity: new Vec3(0, 0, -250),
    bank: 0,
    speed: 250,
    angularVelocity: new Vec3(),
    ...overrides,
  }
}

function steer(command: Vec3, flyer: Flyer = level()): Steering {
  return steerToward(command, flyer, { pitch: 0, roll: 0 })
}

/** 十分に大きい横方向の要求。保持側へ混ざらない大きさ */
const BIG = STEER_THRESHOLD * 20

describe('steerToward', () => {
  it('速度に沿った成分は落とす。旋回には使えない', () => {
    // 真後ろへ加速したい（減速）。旋回の指令にはならない
    const s = steer(new Vec3(0, 0, BIG))
    expect(s.pitch).toBeCloseTo(0, 12)
    expect(s.roll).toBeCloseTo(0, 12)
  })

  it('右へ加速したいなら右へロールする', () => {
    expect(steer(new Vec3(BIG, 0, 0)).roll).toBeGreaterThan(0)
  })

  it('左へ加速したいなら左へロールする', () => {
    expect(steer(new Vec3(-BIG, 0, 0)).roll).toBeLessThan(0)
  })

  it('真横の指令ではまだ引かない。ロールで向きを合わせるのが先', () => {
    const s = steer(new Vec3(BIG, 0, 0))
    // 機体の上（+Y）成分が 0 なので引く量も 0
    expect(s.pitch).toBeCloseTo(0, 12)
    // ロールは飽和している（角度誤差 90 度 > ROLL_BAND）
    expect(s.roll).toBe(1)
  })

  it('上へ加速したいなら引く', () => {
    const s = steer(new Vec3(0, BIG, 0))
    expect(s.pitch).toBeGreaterThan(0)
    expect(s.roll).toBeCloseTo(0, 12)
  })

  it('下へ加速したいなら押すが、上限で絞る', () => {
    expect(steer(new Vec3(0, -BIG, 0)).pitch).toBe(-PUSH_LIMIT)
  })

  /**
   * 目標のバンク角は定常旋回のつり合いから出る。
   *
   *   φ_target = atan2(a_h, a_v + g)
   *
   * 分母に重力が入るので、指令の向きの角度そのものより浅くなる。水平飛行で
   * 揚力が 1 G を支えているぶん、同じ横加速度を出すのに倒す角度が小さい。
   */
  it('目標のバンク角が定常旋回のつり合いと一致する', () => {
    const half = ROLL_BAND / 2
    const lateralDemand = Math.sin(half) * BIG
    const verticalDemand = Math.cos(half) * BIG
    const s = steer(new Vec3(lateralDemand, verticalDemand, 0))
    const bankTarget = Math.atan2(lateralDemand, verticalDemand + GRAVITY)
    expect(s.roll).toBeCloseTo(bankTarget / ROLL_BAND, 9)
    // 指令の向きの角度（0.3 rad）より浅い
    expect(bankTarget).toBeLessThan(half)
    expect(s.roll).toBeLessThan(1)
  })

  it('横の要求が 0 なら翼を水平に保つ', () => {
    const s = steer(new Vec3(0, BIG, 0), level({ bank: 0.7 }))
    // 目標は atan2(0, ...) = 0 なので、いまのバンクを戻す向きへ
    expect(s.roll).toBeLessThan(-0.9)
  })

  it('ロールの角速度で減衰する', () => {
    const command = new Vec3(BIG, BIG, 0)
    const still = steer(command)
    // 右ロール 2 rad/s。setBodyRates は z を負にするので反転して入れる
    const rolling = steer(command, level({ angularVelocity: new Vec3(0, 0, -2) }))
    expect(rolling.roll).toBeLessThan(still.roll)
  })

  it('速度が出ていなければ何も指令しない', () => {
    const s = steer(
      new Vec3(0, BIG, 0),
      level({ velocity: new Vec3(0, 0, -0.5), speed: 0.5 }),
    )
    expect(s.pitch).toBe(0)
    expect(s.roll).toBe(0)
  })

  /**
   * 要求が小さいときは水平飛行の保持へ寄る。
   *
   * これがないとロールが振れ続ける。相手が正面にいると横成分がほとんど 0 に
   * なり、`atan2` の向きが定まらない。実測でバンクが ±46 度を 2 秒ごとに
   * 往復した。
   */
  it('要求がほぼ 0 のとき、バンクを水平へ戻す', () => {
    // 右へ 40 度バンクしていて、指令はほとんど無い
    const s = steer(new Vec3(0.01, 0.01, 0), level({ bank: 0.7 }))
    expect(s.roll).toBeLessThan(-0.5)
  })

  it('要求がほぼ 0 のとき、降下していれば引き戻す', () => {
    const down = new Vec3(0, -100, -229)
    const s = steer(new Vec3(0.01, 0.01, 0), level({ velocity: down }))
    expect(climbAngleOf(down)).toBeLessThan(-0.4)
    expect(s.pitch).toBeGreaterThan(0)
  })

  it('要求が閾値を超えれば操縦側が支配する', () => {
    // 右へ 40 度バンクしたまま、右へ強い要求。保持側なら左ロールになる
    const s = steer(new Vec3(BIG, 0, 0), level({ bank: 0.7 }))
    expect(s.roll).toBeGreaterThan(0.9)
  })

  it('重みは連続。閾値の前後で跳ねない', () => {
    const flyer = level({ bank: 0.7 })
    const at = (m: number): number =>
      steer(new Vec3(m * Math.SQRT1_2, m * Math.SQRT1_2, 0), flyer).roll
    const below = at(STEER_THRESHOLD * 0.98)
    const above = at(STEER_THRESHOLD * 1.02)
    expect(Math.abs(above - below)).toBeLessThan(0.05)
  })
})

/**
 * 機体を実際に回して、指令の向きへ曲がることを確かめる。
 *
 * 符号を 1 つでも間違えると反対へ曲がる。式ではなく挙動で固める。
 */
describe('指令の向きへ曲がる', () => {
  /** 指令を与え続けて 3 秒回し、速度の向きの変化を返す */
  function fly(command: Vec3): { start: Vec3; end: Vec3; craft: Aircraft } {
    const craft = new Aircraft({
      position: new Vec3(0, 5000, 0),
      velocity: new Vec3(0, 0, -250),
      throttle: 0.6,
    })
    const start = new Vec3().copy(craft.velocity).multiplyScalar(1 / craft.speed)
    const steering: Steering = { pitch: 0, roll: 0 }
    for (let i = 0; i < 3 * 120; i++) {
      steerToward(command, craft, steering)
      craft.step(
        makeInput({ pitch: steering.pitch, roll: steering.roll, throttle: 1 }),
        FIXED_DT,
      )
    }
    const end = new Vec3().copy(craft.velocity).multiplyScalar(1 / craft.speed)
    return { start, end, craft }
  }

  it('右への指令で右（+X）へ曲がる', () => {
    const { start, end } = fly(new Vec3(BIG, 0, 0))
    expect(end.x).toBeGreaterThan(0.3)
    expect(start.x).toBeCloseTo(0, 6)
  })

  it('左への指令で左（−X）へ曲がる', () => {
    expect(fly(new Vec3(-BIG, 0, 0)).end.x).toBeLessThan(-0.3)
  })

  it('上への指令で上（+Y）へ曲がる', () => {
    expect(fly(new Vec3(0, BIG, 0)).end.y).toBeGreaterThan(0.3)
  })

  it('斜め上右への指令で両方の成分が正になる', () => {
    const { end } = fly(new Vec3(BIG, BIG, 0))
    expect(end.x).toBeGreaterThan(0.2)
    expect(end.y).toBeGreaterThan(0.05)
  })

  it('指令が無ければ水平を保つ。バンクが振れない', () => {
    const { craft } = fly(new Vec3(0, 0, 0))
    expect(Math.abs(craft.bank)).toBeLessThan(0.05)
    expect(Math.abs(climbAngleOf(craft.velocity))).toBeLessThan(0.05)
  })
})

describe('levelAndClimb', () => {
  const out: Steering = { pitch: 0, roll: 0 }

  it('右バンクなら左へロールして戻す', () => {
    levelAndClimb(level({ bank: 0.7 }), 0, GAMMA_TAU, out)
    expect(out.roll).toBeLessThan(0)
  })

  it('左バンクなら右へロールして戻す', () => {
    levelAndClimb(level({ bank: -0.7 }), 0, GAMMA_TAU, out)
    expect(out.roll).toBeGreaterThan(0)
  })

  it('水平なら舵を当てない', () => {
    levelAndClimb(level(), 0, GAMMA_TAU, out)
    expect(out.roll).toBeCloseTo(0, 12)
    expect(out.pitch).toBeCloseTo(0, 12)
  })

  it('目標より下を向いていれば引く', () => {
    const down = new Vec3(0, -74, -239)
    levelAndClimb(level({ velocity: down }), 0.2, GAMMA_TAU, out)
    expect(out.pitch).toBeGreaterThan(0)
  })

  it('目標より上を向いていれば押す', () => {
    const up = new Vec3(0, 120, -220)
    levelAndClimb(level({ velocity: up }), 0, GAMMA_TAU, out)
    expect(out.pitch).toBeLessThan(0)
  })

  it('バンク 90 度では引いても機首が上がらないので指令しない', () => {
    const down = new Vec3(0, -74, -239)
    levelAndClimb(level({ velocity: down, bank: Math.PI / 2 }), 0.2, GAMMA_TAU, out)
    expect(Math.abs(out.pitch)).toBeLessThan(1e-9)
  })

  it('背面では押す指令になる。世界座標では上向きに逃げる', () => {
    const down = new Vec3(0, -74, -239)
    levelAndClimb(level({ velocity: down, bank: Math.PI }), 0.2, GAMMA_TAU, out)
    expect(out.pitch).toBeLessThan(0)
  })

  /** 立て直しが実際に高度を戻すことを、機体を回して確かめる */
  it('降下している機体を 6 秒で水平以上へ戻す', () => {
    const craft = new Aircraft({
      position: new Vec3(0, 4000, 0),
      // 20 度の降下で 220 m/s
      velocity: new Vec3(0, -Math.sin(0.35) * 220, -Math.cos(0.35) * 220),
      orientation: new Quat().setFromAxisAngle(new Vec3(1, 0, 0), -0.35),
      throttle: 0.6,
    })
    const steering: Steering = { pitch: 0, roll: 0 }
    expect(climbAngleOf(craft.velocity)).toBeLessThan(-0.3)
    for (let i = 0; i < 6 * 120; i++) {
      levelAndClimb(craft, (20 * Math.PI) / 180, GAMMA_TAU, steering)
      craft.step(
        makeInput({ pitch: steering.pitch, roll: steering.roll, throttle: 1 }),
        FIXED_DT,
      )
    }
    expect(craft.crashed).toBe(false)
    expect(climbAngleOf(craft.velocity)).toBeGreaterThan(0.15)
  })
})

describe('rollRateOf', () => {
  it('角速度 z の符号を反転して右ロールを正にする', () => {
    expect(rollRateOf(level({ angularVelocity: new Vec3(0, 0, -3) }))).toBe(3)
    expect(rollRateOf(level({ angularVelocity: new Vec3(0, 0, 3) }))).toBe(-3)
  })
})
