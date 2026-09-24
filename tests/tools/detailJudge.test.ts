import { describe, expect, it } from 'vitest'
import {
  diffMask,
  erode,
  judge,
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

describe('3 条件の判定', () => {
  const base = { pixels: 100, median: 0.1, p99: 0.4, detail: 50 }

  it('中央値が +10% を越えたら鏡', () => {
    const j = judge(base, { ...base, median: 0.12, p99: 0.8, detail: 80 })
    expect(j.ok).toBe(false)
    expect(j.why).toContain('鏡')
  })

  it('p99 が +30% に届かなければハイライトが立たない', () => {
    const j = judge(base, { ...base, p99: 0.5, detail: 80 })
    expect(j.ok).toBe(false)
    expect(j.why).toBe('ハイライトが立たない')
  })

  it('ディテールが増えなければ模様が乗らない', () => {
    const j = judge(base, { ...base, p99: 0.6 })
    expect(j.ok).toBe(false)
    expect(j.why).toBe('模様が乗らない')
  })

  it('3 つ揃えば両立', () => {
    const j = judge(base, { ...base, median: 0.105, p99: 0.6, detail: 51 })
    expect(j.ok).toBe(true)
    expect(j.medianRise).toBeCloseTo(5)
    expect(j.p99Rise).toBeCloseTo(50)
    expect(j.detailGain).toBe(1)
  })

  it('減光は鏡と区別できる', () => {
    // **両方下がる。**中央値だけ見れば「鏡になっていない」で通ってしまう
    const j = judge(base, { ...base, median: 0.08, p99: 0.3, detail: 80 })
    expect(j.ok).toBe(false)
    expect(j.why).toBe('ハイライトが立たない')
  })
})
