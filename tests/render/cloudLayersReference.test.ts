import { describe, it, expect } from 'vitest'
import {
  HIGH_LAYER_ALTITUDE,
  LOW_LAYER_ALTITUDE,
  WEB_OCEAN_COVERAGE,
  WEB_OCEAN_VEIL,
  cloudFbm,
  gnoise,
  highEdge,
  layerSunTransmittance,
  lowDensity,
  lowEdge,
  veilFor,
} from '@render/sky/cloudLayersReference'

/**
 * 層の雲の CPU 参照（段 S4c、web-ocean の `SKY_CLOUD_FUNCS`）。GPU との突き合わせは node-path
 * （`?oceanprobe=1`）。ここは参照そのものの性質を縛る
 */

describe('ノイズ', () => {
  it('格子点で 0、値はおおよそ −1〜1、同じ点は同じ値', () => {
    expect(gnoise(3, -7)).toBe(0)
    let max = 0
    for (let i = 0; i < 2_000; i++) {
      const v = gnoise(i * 0.137 - 50, i * 0.291 + 13)
      max = Math.max(max, Math.abs(v))
    }
    expect(max).toBeGreaterThan(0.3)
    expect(max).toBeLessThan(1)
    expect(gnoise(1.234, -5.678)).toBe(gnoise(1.234, -5.678))
  })

  it('負の格子でも周期が無い（u32 への巻き戻しが効いている）', () => {
    // i32 の負を u32 へ巻くので、正と負の同じ大きさの格子は別の勾配を持つ
    expect(gnoise(-3.5, 2.25)).not.toBeCloseTo(gnoise(3.5, 2.25), 6)
  })
})

describe('画素の大きさで細かい段を消す fbm', () => {
  it('画素が粗いと細かい段が消え、0.08 未満なら全段が効く', () => {
    const p: [number, number] = [4.2, -1.3]
    const fine = cloudFbm(p[0], p[1], 0, 7, 0)
    const coarse = cloudFbm(p[0], p[1], 10, 7, 0)
    // 最初の段の重みも 1 − smoothstep(0.08, 0.28, 10) = 0 で、全部消える
    expect(coarse).toBe(0)
    expect(fine).not.toBe(0)
  })

  it('段を足すほど細かい成分が加わる', () => {
    const a = cloudFbm(0.7, 2.9, 0, 3, 0)
    const b = cloudFbm(0.7, 2.9, 0, 7, 0)
    expect(a).not.toBe(b)
    expect(Math.abs(b - a)).toBeLessThan(0.3)
  })
})

describe('縁と雲量', () => {
  it('雲量を Δ 上げると縁はちょうど Δ 上がる', () => {
    const e1 = lowEdge(3.3, -8.1, 0.1, 7, 0.3, 100)
    const e2 = lowEdge(3.3, -8.1, 0.1, 7, 0.5, 100)
    expect(e2 - e1).toBeCloseTo(0.2, 12)
    const h1 = highEdge(3.3, -8.1, 0.1, 6, 0.2, 100)
    const h2 = highEdge(3.3, -8.1, 0.1, 6, 0.3, 100)
    expect(h2 - h1).toBeCloseTo(0.1, 12)
  })

  it('雲量 0.4 で積雲が空の一部を覆う（全部でも 0 でもない）', () => {
    let covered = 0
    const n = 2_000
    for (let i = 0; i < n; i++) {
      const x = ((i * 0.7548776662466927) % 1) * 60 - 30
      const y = ((i * 0.5698402909980532) % 1) * 60 - 30
      if (lowDensity(x, y, 0, 7, 0.4, 0) > 0.002) covered++
    }
    expect(covered / n).toBeGreaterThan(0.1)
    expect(covered / n).toBeLessThan(0.9)
  })

  it('高層雲の量は雲量に比例し、web-ocean の既定（0.40）で 0.36、快晴で 0', () => {
    expect(veilFor(WEB_OCEAN_COVERAGE)).toBeCloseTo(WEB_OCEAN_VEIL, 12)
    expect(veilFor(0)).toBe(0)
    expect(veilFor(2)).toBeCloseTo(WEB_OCEAN_VEIL / WEB_OCEAN_COVERAGE, 12)
  })
})

describe('層を横切る太陽の線の透過率（雲の影）', () => {
  const sun = { x: 0.3, y: 0.8, z: -0.52 }
  it('快晴では 1、雲があれば 1 以下', () => {
    expect(layerSunTransmittance(100, 0, 200, sun, 0, 0, 4)).toBe(1)
    let shaded = 0
    for (let i = 0; i < 200; i++) {
      const t = layerSunTransmittance(i * 157, 0, i * -91, sun, 0.6, 0, 4)
      expect(t).toBeLessThanOrEqual(1)
      if (t < 0.9) shaded++
    }
    expect(shaded).toBeGreaterThan(10)
  })

  it('太陽が沈んでいれば 1、両方の層より上なら 1', () => {
    expect(layerSunTransmittance(0, 0, 0, { x: 0, y: -0.1, z: 1 }, 0.8, 0, 4)).toBe(1)
    expect(layerSunTransmittance(0, (HIGH_LAYER_ALTITUDE + 0.1) * 1000, 0, sun, 0.8, 0, 4)).toBe(1)
    expect(LOW_LAYER_ALTITUDE).toBeLessThan(HIGH_LAYER_ALTITUDE)
  })
})
