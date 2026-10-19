import { describe, it, expect } from 'vitest'
import { BANNER_DESTROYED_FRAMES, BANNER_HIT_FRAMES, killBannerText } from '@hud/banner'
import { FIXED_DT } from '@sim/loop'

/**
 * 撃墜の結果の帯（段 B3、段 C1 で録画に合わせ直した、ADR 0024）。録画を 1 コマずつ 4 か所読んだ値:
 * HIT 7〜13 コマ（0.23〜0.43 秒）、すき間なし、DESTROYED 29〜30 コマ（0.97〜1.00 秒）
 */
describe('撃墜の帯', () => {
  it('HIT は 0.33 秒（録画 0.23〜0.43 秒の内）、DESTROYED は 1.0 秒（録画 0.97〜1.00 秒）', () => {
    expect(BANNER_HIT_FRAMES * FIXED_DT).toBeCloseTo(1 / 3, 12)
    expect(BANNER_DESTROYED_FRAMES * FIXED_DT).toBeCloseTo(1, 12)
  })

  it('撃墜は HIT のあと、すき間なしに DESTROYED へ替わり、消える', () => {
    const k = 500
    expect(killBannerText(k, k, k - 1)).toBe('')
    expect(killBannerText(k, k, k)).toBe('HIT')
    expect(killBannerText(k, k, k + BANNER_HIT_FRAMES - 1)).toBe('HIT')
    expect(killBannerText(k, k, k + BANNER_HIT_FRAMES)).toBe('DESTROYED')
    expect(killBannerText(k, k, k + BANNER_HIT_FRAMES + BANNER_DESTROYED_FRAMES - 1)).toBe('DESTROYED')
    expect(killBannerText(k, k, k + BANNER_HIT_FRAMES + BANNER_DESTROYED_FRAMES)).toBe('')
  })

  it('落ちない当たりは HIT だけ', () => {
    expect(killBannerText(100, -1, 100)).toBe('HIT')
    expect(killBannerText(100, -1, 100 + BANNER_HIT_FRAMES)).toBe('')
  })

  it('当たりも撃墜も無ければ空', () => {
    expect(killBannerText(-1, -1, 0)).toBe('')
  })
})
