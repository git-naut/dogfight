import { describe, expect, it } from 'vitest'
import {
  diffMask,
  erode,
  highlightStats,
  judge,
  judgeGloss,
  maskedMedian,
  largestComponent,
  luminance,
  maskStats,
} from '../../tools/detail-judge.mjs'

/** 1 画素 RGBA の並びを作る */
function rgba(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  values.forEach((v, i) => {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  })
  return out
}

describe('機体マスク', () => {
  it('雑音の 1 階調はマスクに入れない', () => {
    // **SwiftShader は撮り直すだけで 1 動く。**入れると画面中に点が散る
    const a = rgba([10, 10, 10])
    const b = rgba([11, 12, 10])
    expect(Array.from(diffMask(a, b, 3, 1))).toEqual([0, 1, 0])
  })

  it('どれか 1 つのチャンネルが動けば入れる', () => {
    const a = rgba([10])
    const b = rgba([10])
    b[2] = 30
    expect(Array.from(diffMask(a, b, 1, 1))).toEqual([1])
  })

  it('縮めると窓が収まる画素だけが残る', () => {
    // 11x11 の中央に 7x7 の塊。半径 2 で縮めると中央の 3x3 だけが残る
    const w = 11
    const mask = new Uint8Array(w * w)
    for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) mask[y * w + x] = 1
    const out = erode(mask, w, w, 2)
    expect(out.reduce((s: number, v: number) => s + v, 0)).toBe(9)
    expect(out[5 * w + 5]).toBe(1)
    expect(out[4 * w + 4]).toBe(1)
    expect(out[3 * w + 3]).toBe(0)
  })

  it('最大の塊だけを残す', () => {
    // **機体を消すと雲の描かれ方も少し変わる。**aircraft-close では機体の
    // 上の空に小さな塊が出た。機体と関係のない画素を統計に入れない
    const w = 8
    const mask = new Uint8Array(w * 2)
    mask.set([1, 1, 1, 0, 0, 1, 0, 0], 0)
    mask.set([1, 1, 0, 0, 0, 1, 0, 0], w)
    const out = largestComponent(mask, w, 2)
    expect(Array.from(out.slice(0, w))).toEqual([1, 1, 1, 0, 0, 0, 0, 0])
    expect(Array.from(out.slice(w))).toEqual([1, 1, 0, 0, 0, 0, 0, 0])
  })

  it('斜めにしか接しない画素は別の塊', () => {
    const out = largestComponent(new Uint8Array([1, 1, 0, 0, 0, 1]), 3, 2)
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 0, 0])
  })

  it('画面の端に接する画素は残さない', () => {
    // 窓がはみ出すと箱平均を取れない
    const w = 5
    const out = erode(new Uint8Array(w * w).fill(1), w, w, 2)
    expect(out.reduce((s: number, v: number) => s + v, 0)).toBe(1)
  })
})

describe('マスクの中の統計', () => {
  const w = 9
  const all = new Uint8Array(w * w)
  for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) all[y * w + x] = 1

  it('平らな面は局所ディテールが 0', () => {
    const lum = new Float64Array(w * w).fill(0.2)
    const s = maskStats(lum, all, w, 0.01, 2)
    expect(s.pixels).toBe(25)
    expect(s.median).toBeCloseTo(0.2)
    expect(s.detail).toBe(0)
  })

  it('市松模様は局所ディテールとして数える', () => {
    const lum = new Float64Array(w * w)
    for (let p = 0; p < lum.length; p++) lum[p] = ((p % w) + Math.floor(p / w)) % 2 ? 0.3 : 0.1
    expect(maskStats(lum, all, w, 0.01, 2).detail).toBe(25)
  })

  it('マスクの外は数えない', () => {
    const lum = new Float64Array(w * w).fill(0.2)
    lum[0] = 1
    const s = maskStats(lum, all, w, 0.01, 2)
    expect(s.p99).toBeCloseTo(0.2)
  })

  it('線形輝度は sRGB の逆ガンマを掛けてから混ぜる', () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(1)
    expect(luminance(0, 0, 0)).toBe(0)
    // sRGB の 128 は線形でおよそ 0.216。そのまま割ると 0.502 になる
    expect(luminance(128, 128, 128)).toBeCloseTo(0.2159, 3)
  })
})

describe('2 条件の判定', () => {
  const base = { pixels: 100, median: 0.1, p99: 0.4, detail: 50 }

  it('中央値が +10% を越えたら鏡', () => {
    const j = judge(base, { ...base, median: 0.12, p99: 0.8, detail: 80 })
    expect(j.ok).toBe(false)
    expect(j.why).toContain('鏡')
  })

  it('中央値が −10% を下回ったら暗くなった', () => {
    // **下がる側も縛る。**粗さの中心を 0.45 へ下げた版は 3 構図で −16〜−18%
    const j = judge(base, { ...base, median: 0.083, detail: 80 })
    expect(j.ok).toBe(false)
    expect(j.why).toContain('暗く')
  })

  it('ディテールが増えなければ模様が乗らない', () => {
    const j = judge(base, { ...base, median: 0.101 })
    expect(j.ok).toBe(false)
    expect(j.why).toBe('模様が乗らない')
  })

  it('2 つ揃えば両立。p99 は判定に使わない', () => {
    // p99 は記録だけ（`docs/decisions/0013-surface-detail.md`）
    const j = judge(base, { ...base, median: 0.105, p99: 0.4, detail: 51 })
    expect(j.ok).toBe(true)
    expect(j.medianRise).toBeCloseTo(5)
    expect(j.p99Rise).toBeCloseTo(0)
    expect(j.detailGain).toBe(1)
  })

  it('±10% の内側は通す', () => {
    // 境目ちょうどは比べない。0.11 / 0.1 - 1 は浮動小数点で 10% を僅かに越える
    expect(judge(base, { ...base, median: 0.1099, detail: 51 }).ok).toBe(true)
    expect(judge(base, { ...base, median: 0.0901, detail: 51 }).ok).toBe(true)
  })
})

describe('ハイライトの形', () => {
  // 10x6 の機体。外板は 0.1、中央値の 1.8 倍（0.18）を越える画素をハイライトと読む
  const w = 10
  const h = 6
  const mask = new Uint8Array(w * h).fill(1)

  it('横に長い塊の縦横比を返す', () => {
    const lum = new Float64Array(w * h).fill(0.1)
    for (let x = 2; x < 8; x++) lum[2 * w + x] = lum[3 * w + x] = 0.5
    const s = highlightStats(lum, mask, w, h, 0.1)
    expect(s.pixels).toBe(12)
    expect(s.aspect).toBe(3)
    expect(s.box).toEqual({ x: 2, y: 2, w: 6, h: 2 })
  })

  it('縦に長くても長辺÷短辺', () => {
    const lum = new Float64Array(w * h).fill(0.1)
    for (let y = 0; y < 6; y++) lum[y * w + 4] = 0.5
    expect(highlightStats(lum, mask, w, h, 0.1).aspect).toBe(6)
  })

  it('最大の塊だけを見る', () => {
    // 点が 1 つ離れていても、形は大きい塊で決まる
    const lum = new Float64Array(w * h).fill(0.1)
    for (let x = 0; x < 4; x++) lum[x] = 0.5
    lum[5 * w + 9] = 0.5
    const s = highlightStats(lum, mask, w, h, 0.1)
    expect(s.pixels).toBe(4)
    expect(s.aspect).toBe(4)
  })

  it('中央値の 1.8 倍に届かない明るさはハイライトではない', () => {
    const lum = new Float64Array(w * h).fill(0.1)
    lum[0] = 0.17
    expect(highlightStats(lum, mask, w, h, 0.1).pixels).toBe(0)
  })

  it('ハイライトが無ければ縦横比は 0', () => {
    // **NaN にしない。**比べるときに NaN は何とも等しくないので素通りする
    const s = highlightStats(new Float64Array(w * h).fill(0.1), mask, w, h, 0.1)
    expect(s.aspect).toBe(0)
    expect(s.box).toBeNull()
  })

  it('マスクの外は数えない', () => {
    const lum = new Float64Array(w * h).fill(0.1)
    lum[0] = 0.9
    const m = new Uint8Array(w * h).fill(1)
    m[0] = 0
    expect(highlightStats(lum, m, w, h, 0.1).pixels).toBe(0)
  })
})

describe('艶の判定', () => {
  const skin = { pixels: 100, median: 0.1, p99: 0.4, detail: 50 }
  const none = { pixels: 0, aspect: 0, box: null, blob: new Uint8Array(0) }
  const hi = (pixels: number) => ({ ...none, pixels, aspect: 1, box: { x: 0, y: 0, w: 1, h: 1 } })

  it('変わった場所が明るくなり、外板が動かなければ両立', () => {
    // 段 26 の実測でいちばん弱い逆光が +4%
    const j = judgeGloss(skin, { ...skin, median: 0.101 }, 0.3, 0.312, none, none)
    expect(j.ok).toBe(true)
    expect(j.regionRise).toBeCloseTo(4)
  })

  it('塊の数は判定に使わず記録だけ', () => {
    // **追従カメラのキャノピーは 100 画素ほど。**塊が立ったのは 6 構図中 1
    const j = judgeGloss(skin, skin, 0.1, 0.12, hi(6), hi(6))
    expect(j.ok).toBe(true)
    expect(j.gain).toBe(0)
  })

  it('変わった場所が +3% に届かなければ艶が出ていない', () => {
    const j = judgeGloss(skin, skin, 0.3, 0.305, none, hi(12))
    expect(j.ok).toBe(false)
    expect(j.why).toBe('艶が出ない')
  })

  it('変わった場所が無ければ艶が出ていない', () => {
    // **NaN を通さない。**NaN との比較はすべて false
    expect(judgeGloss(skin, skin, NaN, NaN, none, none).ok).toBe(false)
  })

  it('外板の中央値が ±10% を越えたら外板まで動いた', () => {
    // **キャノピーだけに効くはず。**外板が動いたなら差す相手を間違えている
    expect(judgeGloss(skin, { ...skin, median: 0.12 }, 0.1, 0.2, none, none).why).toContain('外板')
    expect(judgeGloss(skin, { ...skin, median: 0.08 }, 0.1, 0.2, none, none).why).toContain('外板')
  })

  it('マスクの中の中央値', () => {
    const lum = new Float64Array([0.1, 0.9, 0.3, 0.5])
    expect(maskedMedian(lum, new Uint8Array([1, 0, 1, 1]))).toBeCloseTo(0.3)
    expect(maskedMedian(lum, new Uint8Array(4))).toBeNaN()
  })
})
