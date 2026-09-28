import { describe, expect, it } from 'vitest'
import { centroid, judgeExplosion, rimDip } from '../../tools/explosion-judge.mjs'

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
  it('芯が空より暗ければ、谷があっても縁と読まない', () => {
    // **赤い火球は線形輝度で空より暗い。**段 29 で最初に測ったとき、火球そのものを
    // 「空より 43〜52% 暗い谷」と読んだ
    const j = judgeExplosion([0.3, 0.25, 0.2, 0.4, 0.5, 0.5], 0.5)
    expect(j.hotCore).toBe(false)
    expect(j.ok).toBe(false)
    expect(j.why).toBe('芯が立っていない')
  })

  it('芯が白く飛び、外に黒い縁があれば両立', () => {
    const j = judgeExplosion([1.2, 0.9, 0.3, 0.2, 0.45, 0.5, 0.5], 0.5)
    expect(j.hotCore).toBe(true)
    expect(j.ok).toBe(true)
    expect(j.why).toBe('両立')
  })

  it('芯は立ったが縁が無い', () => {
    const j = judgeExplosion([1.2, 0.9, 0.7, 0.55, 0.5, 0.5], 0.5)
    expect(j.hotCore).toBe(true)
    expect(j.ok).toBe(false)
    expect(j.why).toBe('縁が無い')
  })

  it('芯は空の 1.3 倍から', () => {
    expect(judgeExplosion([0.64, 0.2, 0.5, 0.5], 0.5).hotCore).toBe(false)
    expect(judgeExplosion([0.66, 0.2, 0.5, 0.5], 0.5).hotCore).toBe(true)
  })
})
