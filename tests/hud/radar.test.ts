import { describe, expect, it } from 'vitest'
import { RADAR_BOX, radarBearing, radarPoint, radarRange } from '@hud/radar'

/**
 * レーダー（段 34、段 B5 で録画に合わせて作り替えた）。**左右や前後を取り違えると、敵がいない方へ
 * 旋回させる。**期待値は定数から作らず、手で出した数で書く（範囲 4,000 m で 2,000 m 先は 0.5）
 */
const DEG = Math.PI / 180

describe('radarPoint', () => {
  it('北を向いているとき、前（−Z）は上、東（+X）は右、後ろは下。距離は比例', () => {
    const ahead = radarPoint(0, -2000, 0, 4000)
    expect(ahead.x).toBeCloseTo(0, 9)
    expect(ahead.y).toBeCloseTo(-0.5, 9)
    const east = radarPoint(2000, 0, 0, 4000)
    expect(east.x).toBeCloseTo(0.5, 9)
    expect(east.y).toBeCloseTo(0, 9)
    const behind = radarPoint(0, 1000, 0, 4000)
    expect(behind.y).toBeCloseTo(0.25, 9)
  })

  it('東を向いているとき、東（+X）が上、北（−Z）は左', () => {
    const east = radarPoint(2000, 0, 90 * DEG, 4000)
    expect(east.x).toBeCloseTo(0, 9)
    expect(east.y).toBeCloseTo(-0.5, 9)
    const north = radarPoint(0, -2000, 90 * DEG, 4000)
    expect(north.x).toBeCloseTo(-0.5, 9)
    expect(north.y).toBeCloseTo(0, 9)
  })

  it('前は後ろより遠くまで枠に入る（自機が上から 66.4% にいる、録画どおり）', () => {
    // いちばん外の円の 1.3 倍は、前なら枠の中、後ろなら外
    expect(radarPoint(0, -5200, 0, 4000).clamped).toBe(false)
    expect(radarPoint(0, 5200, 0, 4000).clamped).toBe(true)
    expect(RADAR_BOX.top).toBeCloseTo(-0.664 / 0.493, 9)
    expect(RADAR_BOX.bottom).toBeCloseTo(0.336 / 0.493, 9)
  })

  it('枠の外は、自機からの向きを保って枠の縁へ寄せる', () => {
    // 真後ろの遠い相手は、下の縁の真ん中
    const back = radarPoint(0, 40000, 0, 4000)
    expect(back.clamped).toBe(true)
    expect(back.x).toBeCloseTo(0, 9)
    expect(back.y).toBeCloseTo(RADAR_BOX.bottom, 9)
    // 右前 45 度の遠い相手は、向きが 45 度のまま、右か上の縁に乗る
    const far = radarPoint(40000, -40000, 0, 4000)
    expect(far.clamped).toBe(true)
    expect(Math.abs(far.x + far.y)).toBeLessThan(1e-9)
    expect(far.x).toBeCloseTo(RADAR_BOX.right, 9)
  })
})

describe('radarRange（縮尺の段、段 B5）', () => {
  it('いちばん近い相手が外の円に入る、いちばん小さい段を選ぶ', () => {
    expect(radarRange(500)).toBe(2000)
    expect(radarRange(2000)).toBe(2000)
    expect(radarRange(2001)).toBe(4000)
    expect(radarRange(9000)).toBe(16000)
    expect(radarRange(31000)).toBe(32000)
  })

  it('いちばん大きい段を超えたら、いちばん大きい段。相手がいなければ 8 km', () => {
    expect(radarRange(90000)).toBe(32000)
    expect(radarRange(null)).toBe(8000)
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
