import { describe, it, expect } from 'vitest'
import {
  FEET_PER_METER,
  KNOTS_PER_METER_PER_SECOND,
  computeReadout,
  createHudReadout,
  toCompassDegrees,
  toFeet,
  toKnots,
  formatClock,
} from '@hud/readout'
import { createAircraftSample } from '@sim/aircraft'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'

/**
 * HUD の数値。
 *
 * **単位の変換は表示層だけで行う**という規約（`CLAUDE.md`）を、ここで
 * 数値として固定する。sim はメートルと秒とラジアンのまま。
 */

const DEG = Math.PI / 180

function sampleAt(options: {
  speed?: number
  altitude?: number
  agl?: number
  heading?: number
  pitch?: number
  bank?: number
  velocity?: Vec3
}) {
  const s = createAircraftSample()
  s.speed = options.speed ?? 250
  s.altitude = options.altitude ?? 3000
  s.agl = options.agl ?? options.altitude ?? 3000
  s.bank = options.bank ?? 0

  // 方位 → 迎角 → バンク の順。target.ts と同じ組み方
  s.orientation
    .setFromAxisAngle(new Vec3(0, 1, 0), -(options.heading ?? 0))
    .multiply(new Quat().setFromAxisAngle(new Vec3(1, 0, 0), options.pitch ?? 0))
  s.velocity.copy(options.velocity ?? new Vec3(0, 0, -(options.speed ?? 250)))
  return s
}

describe('単位の変換', () => {
  it('ノットは 1852 m/h から導く', () => {
    expect(KNOTS_PER_METER_PER_SECOND).toBeCloseTo(1.9438444924406046, 12)
    expect(toKnots(0)).toBe(0)
    // 100 kt はちょうど 51.444 m/s
    expect(toKnots(1852 / 3600)).toBeCloseTo(1, 12)
  })

  it('フィートは国際フィート 0.3048 m から導く', () => {
    expect(FEET_PER_METER).toBeCloseTo(3.280839895013123, 12)
    expect(toFeet(0.3048)).toBeCloseTo(1, 12)
    expect(toFeet(3000)).toBeCloseTo(9842.5197, 3)
  })

  it('負の値も素通しする。降下率などに使えるように', () => {
    expect(toFeet(-100)).toBeCloseTo(-328.084, 3)
  })
})

describe('方位の表示', () => {
  it('0..360 へ写す', () => {
    expect(toCompassDegrees(0)).toBe(0)
    expect(toCompassDegrees(Math.PI / 2)).toBeCloseTo(90, 9)
    expect(toCompassDegrees(Math.PI)).toBeCloseTo(180, 9)
  })

  it('負の方位を 360 側へ回す。-10 度は 350 度', () => {
    expect(toCompassDegrees(-10 * DEG)).toBeCloseTo(350, 9)
  })

  it('何周しても 0..360 に収まる', () => {
    for (const turns of [-3, -1, 2, 5]) {
      const v = toCompassDegrees(0.3 + turns * Math.PI * 2)
      expect(v, `${turns} 周`).toBeGreaterThanOrEqual(0)
      expect(v, `${turns} 周`).toBeLessThan(360)
      expect(v, `${turns} 周`).toBeCloseTo((0.3 * 180) / Math.PI, 6)
    }
  })
})

describe('computeReadout', () => {
  it('速度と高度を換算する', () => {
    const out = computeReadout(sampleAt({ speed: 250, altitude: 3000 }), createHudReadout())
    expect(out.speedKt).toBeCloseTo(486, 0)
    expect(out.altitudeFt).toBeCloseTo(9843, 0)
  })

  it('対地高度も換算する。低空では海抜と大きく違う', () => {
    const out = computeReadout(
      sampleAt({ altitude: 3000, agl: 800 }),
      createHudReadout(),
    )
    expect(out.aglFt).toBeCloseTo(2625, 0)
    expect(out.altitudeFt).not.toBeCloseTo(out.aglFt, 0)
  })

  it('機首が -Z なら方位 0', () => {
    const out = computeReadout(sampleAt({}), createHudReadout())
    expect(out.headingDeg).toBeCloseTo(0, 6)
    expect(out.nose.z).toBeLessThan(-0.99)
  })

  it('右へ 90 度回すと方位 90', () => {
    const out = computeReadout(sampleAt({ heading: 90 * DEG }), createHudReadout())
    expect(out.headingDeg).toBeCloseTo(90, 6)
  })

  it('左へ 10 度回すと方位 350。負で出さない', () => {
    const out = computeReadout(sampleAt({ heading: -10 * DEG }), createHudReadout())
    expect(out.headingDeg).toBeCloseTo(350, 6)
  })

  it('機首を上げると仰角が正', () => {
    const out = computeReadout(sampleAt({ pitch: 20 * DEG }), createHudReadout())
    expect(out.pitchDeg).toBeCloseTo(20, 6)
  })

  it('バンクは sim の値をそのまま度へ', () => {
    const out = computeReadout(sampleAt({ bank: -1.1 }), createHudReadout())
    expect(out.bankDeg).toBeCloseTo((-1.1 * 180) / Math.PI, 9)
  })

  it('フライトパスは速度の向き。機首とは迎角ぶんずれる', () => {
    // 機首は 10 度上、速度は水平
    const s = sampleAt({ pitch: 10 * DEG, velocity: new Vec3(0, 0, -250) })
    const out = computeReadout(s, createHudReadout())
    expect(out.flightPath.y).toBeCloseTo(0, 9)
    expect(out.nose.y).toBeCloseTo(Math.sin(10 * DEG), 6)
    // 機首のほうが上を向いている
    expect(out.nose.y).toBeGreaterThan(out.flightPath.y)
  })

  it('速度がほぼ 0 なら機首の向きへ倒す', () => {
    // 0 ベクトルを投影すると同次座標が 0 になり、画面の中心に張り付く。
    // 止まった瞬間にマーカーが跳ぶので、機首へ寄せる
    const s = sampleAt({ pitch: 15 * DEG, velocity: new Vec3(0, 0, 0) })
    const out = computeReadout(s, createHudReadout())
    expect(out.flightPath.x).toBeCloseTo(out.nose.x, 12)
    expect(out.flightPath.y).toBeCloseTo(out.nose.y, 12)
    expect(out.flightPath.z).toBeCloseTo(out.nose.z, 12)
  })

  it('フライトパスは単位ベクトル', () => {
    const out = computeReadout(
      sampleAt({ velocity: new Vec3(30, -12, -300) }),
      createHudReadout(),
    )
    expect(out.flightPath.length()).toBeCloseTo(1, 12)
  })

  it('器を使い回す。毎フレーム作らない', () => {
    const out = createHudReadout()
    expect(computeReadout(sampleAt({}), out)).toBe(out)
  })

  it('失速と墜落をそのまま渡す', () => {
    const s = sampleAt({})
    s.stalled = true
    s.crashed = true
    const out = computeReadout(s, createHudReadout())
    expect(out.stalled).toBe(true)
    expect(out.crashed).toBe(true)
  })
})

describe('formatClock', () => {
  it('分と秒に分ける', () => {
    // 120 フレーム = 1 秒
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(120)).toBe('0:01')
    expect(formatClock(60 * 120)).toBe('1:00')
    expect(formatClock(300 * 120)).toBe('5:00')
  })

  it('秒は 2 桁に揃える', () => {
    expect(formatClock(5 * 120)).toBe('0:05')
    expect(formatClock(65 * 120)).toBe('1:05')
  })

  /**
   * **切り上げる。**残り 0.5 秒を「0:00」と出すと、まだ時間があるのに
   * 終わったように見える。0 になるのは本当に尽きたときだけにしたい。
   */
  it('端数は切り上げる', () => {
    expect(formatClock(1)).toBe('0:01')
    expect(formatClock(119)).toBe('0:01')
    expect(formatClock(121)).toBe('0:02')
  })

  it('負の値は 0 として扱う', () => {
    expect(formatClock(-100)).toBe('0:00')
  })
})
