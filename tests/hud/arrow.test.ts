import { describe, expect, it } from 'vitest'
import { offscreenDirection } from '@hud/arrow'

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
