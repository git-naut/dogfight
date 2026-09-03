import { describe, expect, it } from 'vitest'
import {
  SPRITE_PROBE_FALLOFF,
  SPRITE_PROBE_OPACITY,
  SPRITE_PROBE_SIDE,
  spriteDrawnPixels,
  spriteProbeCrossesCoreCut,
} from '@render/weapons/spriteProbe'
import { ALPHA_CUT, CORE_CUT } from '@render/weapons/radialSprite'

/**
 * 円形スプライトの突き合わせに使う固定入力。
 *
 * **濃さが `CORE_CUT` を跨がないと、芯の枝が全部捨てられる。**空の絵どうしを
 * 比べても一致するので、移植を間違えても気づけない。
 */
describe('スプライトの固定入力', () => {
  it('濃さが芯の境目を跨ぐ', () => {
    expect(spriteProbeCrossesCoreCut()).toBe(true)
    expect(SPRITE_PROBE_OPACITY).toBeGreaterThan(CORE_CUT)
  })

  it('濃さが捨てる下限より上にある', () => {
    expect(SPRITE_PROBE_OPACITY).toBeGreaterThan(ALPHA_CUT)
  })

  it('落ち方が 1 でない', () => {
    // 1 だと `pow` が恒等になり、指数の写し間違いが見えない
    expect(SPRITE_PROBE_FALLOFF).not.toBe(1)
  })

  it('焼く大きさが偶数', () => {
    // 中心が 2x2 のテクセルに割れる。奇数だと中心の 1 画素だけが特別になる
    expect(SPRITE_PROBE_SIDE % 2).toBe(0)
  })
})

describe('描かれた画素の数', () => {
  const rgba = (alphas: number[]): Uint8Array => {
    const out = new Uint8Array(alphas.length * 4)
    for (let i = 0; i < alphas.length; i++) out[i * 4 + 3] = alphas[i]!
    return out
  }

  it('アルファが 0 でない画素を数える', () => {
    expect(spriteDrawnPixels(rgba([0, 1, 255, 0]))).toBe(2)
  })

  it('全部捨てられていれば 0', () => {
    expect(spriteDrawnPixels(rgba([0, 0, 0]))).toBe(0)
  })

  it('空なら 0', () => {
    expect(spriteDrawnPixels(new Uint8Array(0))).toBe(0)
  })
})
