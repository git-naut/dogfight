import { describe, expect, it } from 'vitest'
import { radarBearing, radarPoint, radarRadius } from '@hud/radar'

/**
 * レーダーの向き（段 34）。**左右や前後を取り違えると、敵がいない方へ旋回させる。**
 * 期待値は定数から作らず、範囲 12,000 m・平方根で縮める式から手で出した数で書く
 * （3,000 m は √0.25 = 0.5）
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

  it('範囲の外は向きを保って円の縁へ寄せる', () => {
    // 右前 45 度の 17 km。円の縁（半径 1）の 45 度の位置
    const far = radarPoint(12000, -12000, 0)
    expect(far.clamped).toBe(true)
    expect(far.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(far.y).toBeCloseTo(-Math.SQRT1_2, 9)
    const near = radarPoint(0, -11999, 0)
    expect(near.clamped).toBe(false)
  })

  it('距離は平方根で縮める。空戦の距離の相手が中心に潰れない', () => {
    // 計画書の段 31。比例なら 500 / 12000 = 4% だが、平方根で 20%
    expect(radarRadius(500)).toBeCloseTo(0.2041, 4)
    expect(radarRadius(3000)).toBeCloseTo(0.5, 9)
    expect(radarRadius(12000)).toBe(1)
    expect(radarRadius(30000)).toBe(1)
    expect(radarPoint(0, -500, 0).y).toBeCloseTo(-0.2041, 4)
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
