import { describe, expect, it } from 'vitest'
import { BALL_INSET, SHAPE_AMPLITUDE } from '../../src/render/weapons/fireballShape'

describe('火の玉の板の形', () => {
  it('輪郭のうねりが −1 でも、輪郭が板の端より内側で閉じる', () => {
    // **板の端（中心からの距離 1）で輪郭が閉じないと、四角い縁でまっすぐ切れる**
    // （段 29b の基準画像 `hud-mission-failed`）。輪郭は `距離 × BALL_INSET +
    // ノイズ × SHAPE_AMPLITUDE = 1` の所にある
    const farthest = (1 + SHAPE_AMPLITUDE) / BALL_INSET
    expect(farthest).toBeLessThan(1)
  })
})
