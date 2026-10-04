import { describe, expect, it } from 'vitest'
import { radarBearing, radarPoint } from '@hud/radar'

/**
 * レーダーの向き（段 34）。**左右や前後を取り違えると、敵がいない方へ旋回させる。**
 * 期待値は定数から作らず、範囲 6,000 m を固定の数で書く
 */
const DEG = Math.PI / 180

describe('radarPoint', () => {
  it('北を向いているとき、前（−Z）は上、東（+X）は右', () => {
    const ahead = radarPoint(0, -3000, 0)
    expect(ahead.x).toBeCloseTo(0, 9)
    expect(ahead.y).toBeCloseTo(-0.5, 9)
    const east = radarPoint(3000, 0, 0)
    expect(east.x).toBeCloseTo(0.5, 9)
    expect(east.y).toBeCloseTo(0, 9)
    const behind = radarPoint(0, 3000, 0)
    expect(behind.y).toBeCloseTo(0.5, 9)
  })

  it('東を向いているとき、東（+X）が上、北（−Z）は左', () => {
    const east = radarPoint(3000, 0, 90 * DEG)
    expect(east.x).toBeCloseTo(0, 9)
    expect(east.y).toBeCloseTo(-0.5, 9)
    const north = radarPoint(0, -3000, 90 * DEG)
    expect(north.x).toBeCloseTo(-0.5, 9)
    expect(north.y).toBeCloseTo(0, 9)
  })

  it('範囲の外は向きを保って縁へ寄せる', () => {
    const far = radarPoint(12000, -12000, 0)
    expect(far.clamped).toBe(true)
    expect(far.x).toBeCloseTo(1, 9)
    expect(far.y).toBeCloseTo(-1, 9)
    const near = radarPoint(0, -5999, 0)
    expect(near.clamped).toBe(false)
  })
})

describe('radarBearing', () => {
  it('北を向いていれば N は上、E は右', () => {
    const n = radarBearing(0, 0)
    expect(n.x).toBeCloseTo(0, 9)
    expect(n.y).toBeCloseTo(-1, 9)
    const e = radarBearing(90 * DEG, 0)
    expect(e.x).toBeCloseTo(1, 9)
    expect(e.y).toBeCloseTo(0, 9)
  })

  it('東を向いていれば N は左', () => {
    const n = radarBearing(0, 90 * DEG)
    expect(n.x).toBeCloseTo(-1, 9)
    expect(n.y).toBeCloseTo(0, 9)
  })
})
