import { describe, it, expect } from 'vitest'
import {
  SHADOW_HISTOGRAM_BINS,
  histogramL1,
  shadowHistogram,
} from '@render/clouds/geometry'

/**
 * 雲影マップの分布を数える関数を縛る。
 *
 * **GLSL 版と TSL 版が同じこの関数を通る**ことが要点。片方だけ別の数え方を
 * すると、突き合わせが嘘をつく。段 12 の合格条件（L1 距離 0.01 未満）は
 * この関数の出力どうしで測る。
 */
function rgba(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  for (let i = 0; i < values.length; i++) {
    out[i * 4] = values[i]!
    out[i * 4 + 1] = values[i]!
    out[i * 4 + 2] = values[i]!
    out[i * 4 + 3] = 255
  }
  return out
}

describe('雲影の分布', () => {
  it('ビンの数と合計が決まっている', () => {
    const h = shadowHistogram(rgba([0, 128, 255, 64]))
    expect(h.length).toBe(SHADOW_HISTOGRAM_BINS)
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  it('0 は最初のビン、255 は最後のビンへ入る', () => {
    // **上端の丸めを外すと 255 が範囲外のビンへ行く。**実際に踏みやすい
    expect(shadowHistogram(rgba([0]))[0]).toBe(1)
    expect(shadowHistogram(rgba([255]))[SHADOW_HISTOGRAM_BINS - 1]).toBe(1)
  })

  it('R チャンネルだけ見る', () => {
    // 雲影は灰色なので 3 成分は同じ。別の値が混ざっても R で決まる
    const mixed = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255])
    expect(shadowHistogram(mixed)[SHADOW_HISTOGRAM_BINS - 1]).toBe(1)
  })

  it('空なら全部 0', () => {
    expect(shadowHistogram(new Uint8Array(0)).every((v) => v === 0)).toBe(true)
  })

  it('同じ分布どうしの L1 距離は 0', () => {
    const h = shadowHistogram(rgba([0, 64, 128, 192, 255]))
    expect(histogramL1(h, h)).toBe(0)
  })

  it('端どうしの L1 距離は 2', () => {
    // 正規化してあるので値域は 0..2。合格条件 0.01 がどれくらい厳しいかの目安
    const dark = shadowHistogram(rgba([0, 0, 0, 0]))
    const bright = shadowHistogram(rgba([255, 255, 255, 255]))
    expect(histogramL1(dark, bright)).toBeCloseTo(2, 12)
  })

  it('長さが違えば無限大を返す', () => {
    expect(histogramL1([0.5, 0.5], [1])).toBe(Number.POSITIVE_INFINITY)
  })

  it('1 テクセルだけ動かすと L1 距離がその割合の 2 倍になる', () => {
    // 検査が働くことの確認。256 個のうち 1 個を別のビンへ移す
    const base = new Array<number>(256).fill(0)
    const moved = [...base]
    moved[0] = 255
    const a = shadowHistogram(rgba(base))
    const b = shadowHistogram(rgba(moved))
    expect(histogramL1(a, b)).toBeCloseTo(2 / 256, 12)
  })
})
