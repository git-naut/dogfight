import { describe, it, expect } from 'vitest'
import { ALERT, MAIN, RADAR_FILL, RADAR_FRAME, RADAR_LINE, SILHOUETTE_RGBA, TARGET_WHITE } from '@hud/palette'
import { centeredBaseline } from '@hud/layout'

/**
 * HUD の色の表（段 D3、ADR 0031）。表の色を録画の背景に通常の重ね方で重ね、録画の芯の色に近いことを
 * 見る。録画の値は `~/.claude/plans/dogfight-ac7-ref/measure/hud_palette*.json` とコマ 600 の芯
 */
type Rgb = [number, number, number]

function parse(rgba: string): [number, number, number, number] {
  const m = /rgba\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(rgba)
  if (m === null) throw new Error(rgba)
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

function over(top: [number, number, number, number], bg: Rgb): Rgb {
  const a = top[3]
  return [0, 1, 2].map((i) => bg[i]! * (1 - a) + top[i]! * a) as Rgb
}

function near(actual: Rgb, recorded: Rgb, tol: number, what: string) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - recorded[i]!), `${what} の ${'RGB'[i]}: ${actual.map(Math.round)} / 録画 ${recorded}`).toBeLessThanOrEqual(tol)
  }
}

describe('HUD の色の表', () => {
  it('警告（STALL）は、録画の背景 136,138,147 の上で録画の芯 198,162,176 に合う', () => {
    near(over(parse(ALERT), [136, 138, 147]), [198, 162, 176], 3, 'STALL')
  })

  it('レーダーの中の線は、レーダーの地の上で録画の芯 70,204,60 に合う', () => {
    // 地は背景（録画 166,166,152）の上に重ねた色。線はその上に重ねる
    const fill = over(parse(RADAR_FILL), [166, 166, 152])
    near(over(parse(RADAR_LINE), fill), [70, 204, 60], 12, 'レーダーの線')
  })

  it('レーダーの枠は録画の芯 216,254,218 に近い明るさ（白に近い緑）', () => {
    const fill = over(parse(RADAR_FILL), [166, 166, 152])
    near(over(parse(RADAR_FRAME), fill), [216, 254, 218], 15, 'レーダーの枠')
  })

  it('輪郭は主の緑より濃い緑（録画 154,255,151、主は 204,255,213）', () => {
    const main = parse(MAIN)
    expect(SILHOUETTE_RGBA[0]).toBeLessThan(main[0] - 30)
    expect(SILHOUETTE_RGBA[2]).toBeLessThan(main[2] - 30)
  })

  it('目標の白は、雲（214,211,200）の上で録画の芯 247,247,233 に近い', () => {
    near(over(parse(TARGET_WHITE), [214, 211, 200]), [247, 247, 233], 16, '目標の白')
  })

  it('SPEED・ALT の数字は字形の上下の中央を箱の中央に置く', () => {
    expect(centeredBaseline(539, 20, 0)).toBe(549)
  })
})
