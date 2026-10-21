import { describe, expect, it } from 'vitest'
import { locatorShape, locatorWidth, offscreenDirection } from '@hud/arrow'

/**
 * 画面の外の相手を指す矢印（段 35）。**後ろの点は折り返して出るので、向きを反転する。**
 * 取り違えると、真後ろの敵を指すはずの矢印が前を指す
 */
const W = 1280
const H = 720

describe('offscreenDirection', () => {
  it('画面の中に写っていれば矢印は要らない', () => {
    expect(offscreenDirection({ x: 700, y: 300, inFront: true }, W, H)).toBeNull()
  })

  it('右の外にいれば右を指す', () => {
    const d = offscreenDirection({ x: 2000, y: 360, inFront: true }, W, H)!
    expect(d.x).toBeCloseTo(1, 9)
    expect(d.y).toBeCloseTo(0, 9)
  })

  it('カメラの後ろの点は折り返しているので反対を指す', () => {
    // 右後ろの相手は、投影すると左へ折り返して出る
    const d = offscreenDirection({ x: 200, y: 360, inFront: false }, W, H)!
    expect(d.x).toBeCloseTo(1, 9)
    expect(d.y).toBeCloseTo(0, 9)
  })

  it('真後ろで中心に重なったら下を指す', () => {
    const d = offscreenDirection({ x: 640, y: 360, inFront: false }, W, H)!
    expect(d.x).toBe(0)
    expect(d.y).toBe(1)
  })
})

describe('ターゲットロケーター（段 D8）', () => {
  it('底の幅は 1 km で 30、8 km で 14 画素、間は一様に細くなる', () => {
    expect(locatorWidth(500)).toBe(30)
    expect(locatorWidth(1000)).toBe(30)
    expect(locatorWidth(8000)).toBe(14)
    expect(locatorWidth(20000)).toBe(14)
    expect(locatorWidth(4500)).toBeCloseTo(22, 9)
    let last = Infinity
    for (let d = 0; d <= 10000; d += 250) {
      expect(locatorWidth(d)).toBeLessThanOrEqual(last)
      last = locatorWidth(d)
    }
  })

  it('底は中心から 85、先端は 200 画素。録画の長さ 115 画素', () => {
    const s = locatorShape({ x: 0, y: -1 }, 1000, 960, 540, 1)
    expect(s.tipX).toBeCloseTo(960, 9)
    expect(s.tipY).toBeCloseTo(540 - 200, 9)
    // 底の左右の幅は 30
    expect(Math.hypot(s.leftX - s.rightX, s.leftY - s.rightY)).toBeCloseTo(30, 9)
    // くぼみは底から先端の側へ 14
    expect(s.notchY).toBeCloseTo(540 - 85 - 14, 9)
  })

  it('縮尺に比例し、向きに沿う', () => {
    const d = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const s = locatorShape(d, 8000, 0, 0, 2)
    expect(Math.hypot(s.tipX, s.tipY)).toBeCloseTo(400, 9)
    expect(Math.hypot(s.leftX - s.rightX, s.leftY - s.rightY)).toBeCloseTo(28, 9)
  })
})
