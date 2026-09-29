import { describe, expect, it } from 'vitest'
import { brightestDisk, centroid, coreLuminance, hotSpots, judgeExplosion, rimDip } from '../../tools/explosion-judge.mjs'

/**
 * 爆発の形の判定（段 29）。
 *
 * 計画書の判定は「中心を通る線の線形輝度の分布に、火と空のあいだの
 * 局所極小（黒煙の縁）が出ること」。中心から外へたどり、空へ抜けるまでの
 * 最小が空より 10% 以上暗ければ縁があるとみなす
 */
describe('黒煙の縁', () => {
  it('火から空へ単調に落ちるなら縁は無い', () => {
    // 芯 1.0 → 空 0.2。途中で空より暗くならない
    const r = rimDip([1, 0.8, 0.6, 0.4, 0.25, 0.2, 0.2], 0.2)
    expect(r.found).toBe(false)
  })

  it('空より 10% 以上暗い谷があれば縁がある', () => {
    const r = rimDip([1, 0.7, 0.3, 0.12, 0.15, 0.2, 0.2], 0.2)
    expect(r.found).toBe(true)
    expect(r.min).toBeCloseTo(0.12)
    expect(r.depth).toBeCloseTo(0.4)
  })

  it('空より少しだけ暗い谷（10% 未満）は縁と読まない', () => {
    // 雑音や空の縞で 5% 下がっただけ
    expect(rimDip([1, 0.5, 0.19, 0.2, 0.2], 0.2).found).toBe(false)
  })

  it('空を 1 画素も抜けない分布は縁を判定できない', () => {
    // 線の端まで火か煙。外側の空が見えていない
    const r = rimDip([1, 0.9, 0.8, 0.7], 0.2)
    expect(r.found).toBe(false)
    expect(r.reachedSky).toBe(false)
  })
})

describe('塊の重心', () => {
  it('塊の画素の平均の位置', () => {
    const w = 5
    const m = new Uint8Array(w * 3)
    m[1 * w + 1] = m[1 * w + 3] = 1
    expect(centroid(m, w)).toEqual({ x: 2, y: 1, pixels: 2 })
  })

  it('空なら null', () => {
    expect(centroid(new Uint8Array(9), 3)).toBeNull()
  })
})

describe('爆発の形の判定（芯と縁の組）', () => {
  const gray = (v: number) => [v, v, v] as [number, number, number]

  it('芯が空より暗ければ、谷があっても縁と読まない', () => {
    // **赤い火球は線形輝度で空より暗い。**段 29 で最初に測ったとき、火球そのものを
    // 「空より 43〜52% 暗い谷」と読んだ
    const j = judgeExplosion([0.3, 0.25, 0.2, 0.4, 0.5, 0.5], [0.3, 0.25, 0.2, 0.4, 0.5, 0.5].map(gray), 0.5)
    expect(j.hotCore).toBe(false)
    expect(j.ok).toBe(false)
    expect(j.why).toBe('芯が立っていない')
  })

  it('芯が白く飛び、外に黒い縁があれば両立', () => {
    const p = [1.2, 0.9, 0.3, 0.2, 0.45, 0.5, 0.5]
    const j = judgeExplosion(p, p.map(gray), 0.5)
    expect(j.hotCore).toBe(true)
    expect(j.ok).toBe(true)
    expect(j.why).toBe('両立')
  })

  it('芯は立ったが縁が無い', () => {
    const p = [1.2, 0.9, 0.7, 0.55, 0.5, 0.5]
    expect(judgeExplosion(p, p.map(gray), 0.5).why).toBe('縁が無い')
  })

  it('空より少し暗いだけの谷は縁と読まない（25% 未満）', () => {
    // **白い芯を入れた最初の版で、桃色がかったにじみ（空より 13% 暗い）を縁と読んだ**
    const p = [1.2, 0.9, 0.43, 0.5, 0.5]
    expect(judgeExplosion(p, p.map(gray), 0.5).why).toBe('縁が無い')
  })

  it('赤い輪は黒煙の縁ではない', () => {
    // 暗くても色味が強ければ火。黒煙は色味が薄い
    const p = [1.2, 0.9, 0.3, 0.5, 0.5]
    const colors: [number, number, number][] = [gray(1.2), gray(0.9), [0.6, 0.15, 0.1], gray(0.5), gray(0.5)]
    const j = judgeExplosion(p, colors, 0.5)
    expect(j.ok).toBe(false)
    expect(j.why).toBe('縁が赤い（火であって煙ではない）')
  })

  it('芯は空の 1.3 倍から', () => {
    const lo = [0.64, 0.2, 0.5, 0.5]
    const hi = [0.66, 0.2, 0.5, 0.5]
    expect(judgeExplosion(lo, lo.map(gray), 0.5).hotCore).toBe(false)
    expect(judgeExplosion(hi, hi.map(gray), 0.5).hotCore).toBe(true)
  })
})

describe('芯の明るさ', () => {
  it('中心のまわりの円の平均で読む。細い光の線 1 本に引っぱられない', () => {
    // **中心の 1 画素で読むと、曳光弾の線を芯と読んだ**（段 29b、0.52 秒の黒い煙で
    // 「芯が空の 1.48 倍」と出た）
    const w = 21
    const lum = new Float64Array(w * w).fill(0.1)
    for (let y = 0; y < w; y++) lum[y * w + 10] = 1 // 縦の光の線
    const v = coreLuminance(lum, w, w, 10, 10, 4)
    expect(v).toBeLessThan(0.3)
  })

  it('一様に明るい芯はそのまま読む', () => {
    const w = 11
    const lum = new Float64Array(w * w).fill(0.8)
    expect(coreLuminance(lum, w, w, 5, 5, 3)).toBeCloseTo(0.8)
  })

  it('画面の端では内側だけで平均する', () => {
    const w = 5
    const lum = new Float64Array(w * w).fill(0.5)
    expect(coreLuminance(lum, w, w, 0, 0, 3)).toBeCloseTo(0.5)
  })
})

describe('芯の位置', () => {
  it('塊の中でいちばん明るい円を芯とする。重心ではない', () => {
    // **重心は芯から外れる。**段 29b の 0.03 秒で、差分の塊の重心が火球の中心から
    // 10 画素上の空との境目に落ち、白く飛んだ芯を「空の 1.02 倍」と読んだ
    const w = 40
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w).fill(1)
    for (let y = 26; y <= 32; y++) for (let x = 16; x <= 22; x++) lum[y * w + x] = 1
    const d = brightestDisk(lum, mask, w, w, 3)
    expect(Math.abs(d.x - 19)).toBeLessThanOrEqual(1)
    expect(Math.abs(d.y - 29)).toBeLessThanOrEqual(1)
    expect(d.value).toBeGreaterThan(0.9)
  })

  it('細い光の線は芯にしない', () => {
    const w = 40
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w).fill(1)
    for (let y = 0; y < w; y++) lum[y * w + 5] = 1 // 曳光弾の線
    for (let y = 18; y <= 24; y++) for (let x = 28; x <= 34; x++) lum[y * w + x] = 0.8
    const d = brightestDisk(lum, mask, w, w, 3)
    expect(d.x).toBeGreaterThan(25)
  })

  it('塊の外は探さない', () => {
    const w = 20
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w)
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) mask[y * w + x] = 1
    for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) lum[y * w + x] = 1
    const d = brightestDisk(lum, mask, w, w, 2)
    expect(d.x).toBeLessThan(10)
    expect(d.y).toBeLessThan(10)
  })
})

describe('火から煤へ落ちる途中', () => {
  it('火が空の明るさを横切る画素で打ち切らない', () => {
    // **段 29b の 0.14 秒で、火の橙が空の 0.96 倍を横切った 1 画素を「空に着いた」と
    // 読み、その先の煤（空の 0.28 倍）を見なかった**
    const sky = 0.617
    const profile = [0.94, 0.9, 0.77, 0.68, 0.59, 0.51, 0.47, 0.28, 0.17, 0.17, 0.29, 0.59, 0.62, 0.62]
    const r = rimDip(profile, sky, 0.25)
    expect(r.found).toBe(true)
    expect(r.min).toBeCloseTo(0.17)
  })

  it('火から空へそのまま抜けたら谷は無い', () => {
    const r = rimDip([1.2, 0.9, 0.7, 0.62, 0.61, 0.62, 0.62], 0.62, 0.25)
    expect(r.found).toBe(false)
    expect(r.reachedSky).toBe(true)
  })
})

describe('熱い中心の数', () => {
  const disk = (lum: Float64Array, w: number, cx: number, cy: number, r: number, v: number) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) lum[y * w + x] = v
    }
  }

  it('重なった 2 つの火の玉は、明るさの山が 2 つある', () => {
    // **明るい塊の数では数えられない。**火の玉が重なると明るい所がつながる
    const w = 60
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w).fill(1)
    disk(lum, w, 22, 30, 8, 0.7)
    disk(lum, w, 38, 30, 8, 0.7)
    disk(lum, w, 22, 30, 3, 1.0)
    disk(lum, w, 38, 30, 3, 1.0)
    expect(hotSpots(lum, mask, w, w, 2, 0.8, 6).length).toBe(2)
  })

  it('1 つの火の玉は 1 つ', () => {
    const w = 60
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w).fill(1)
    disk(lum, w, 30, 30, 10, 0.7)
    disk(lum, w, 30, 30, 4, 1.0)
    expect(hotSpots(lum, mask, w, w, 2, 0.8, 6).length).toBe(1)
  })

  it('細い光の線は数えない', () => {
    const w = 40
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w).fill(1)
    for (let y = 0; y < w; y++) lum[y * w + 10] = 1
    expect(hotSpots(lum, mask, w, w, 2, 0.8, 6).length).toBe(0)
  })

  it('平らに明るい所は、山を 1 つだけ数える', () => {
    // 同じ値が並ぶ所で、並んだ画素をそれぞれ山と数えない
    const w = 40
    const lum = new Float64Array(w * w).fill(0.2)
    const mask = new Uint8Array(w * w).fill(1)
    disk(lum, w, 20, 20, 8, 1.0)
    expect(hotSpots(lum, mask, w, w, 2, 0.8, 6).length).toBe(1)
  })
})
