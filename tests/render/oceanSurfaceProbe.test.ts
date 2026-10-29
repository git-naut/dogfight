import { describe, it, expect } from 'vitest'
import {
  OCEAN_SURFACE_PROBE_CELLS,
  OCEAN_SURFACE_PROBE_COUNT,
  OCEAN_SURFACE_PROBE_SPANS,
  buildOceanMips,
  compareOceanSurface,
  oceanMomentField,
  oceanSurfaceProbePoints,
  sampleOceanCpu,
} from '@render/ocean/oceanProbe'
import { oceanCascadeLod, oceanCascadeSkipped } from '@render/ocean/oceanLayout'
import { oceanParamsFor } from '@render/ocean/reference'

/**
 * 海面のテクスチャの突き合わせの CPU 側（段 S4a-1、`oceanProbe.ts`）。
 *
 * GPU と比べる相手なので、ここが誤っていると node-path の突き合わせが空回りする。
 * ミップは 2 × 2 の平均、引き方は repeat の双線形と段の間の線形（three のサンプラ）
 */

/** 1 カスケード・一辺 n の場。texel (x, y) の 4 成分を f で埋める */
function field(n: number, f: (x: number, y: number, ch: number) => number): Float64Array {
  const out = new Float64Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let ch = 0; ch < 4; ch++) out[(y * n + x) * 4 + ch] = f(x, y, ch)
    }
  }
  return out
}

describe('ミップ', () => {
  it('段 l は段 l−1 の 2 × 2 の平均で、最後は 1 × 1 の平均', () => {
    const n = 8
    const base = field(n, (x, y, ch) => x + 10 * y + 100 * ch)
    const mips = buildOceanMips(base, n, 1)
    expect(mips).toHaveLength(4)
    // 段 1 の (0, 0) は (0,0)(1,0)(0,1)(1,1) の平均 = (0 + 1 + 10 + 11) / 4
    expect(mips[1]![0]).toBeCloseTo(5.5, 12)
    // 段 1 の (2, 1) は x 4..5、y 2..3 の平均 = 4.5 + 25
    expect(mips[1]![(1 * 4 + 2) * 4]).toBeCloseTo(29.5, 12)
    // 最後は全体の平均。成分 2 は 200 を足す
    expect(mips[3]![0]).toBeCloseTo(3.5 + 35, 12)
    expect(mips[3]![2]).toBeCloseTo(3.5 + 35 + 200, 12)
  })

  it('カスケードどうしを混ぜない', () => {
    const n = 4
    const two = new Float64Array(2 * n * n * 4)
    two.set(field(n, () => 1), 0)
    two.set(field(n, () => 3), n * n * 4)
    const mips = buildOceanMips(two, n, 2)
    expect(mips[2]![0]).toBe(1)
    expect(mips[2]![4]).toBe(3)
  })
})

describe('引き方', () => {
  const n = 8
  const base = field(n, (x, y) => x + 10 * y)
  const mips = buildOceanMips(base, n, 1)

  it('texel の中心では texel の値そのもの', () => {
    // 中心は (i + 0.5) / n
    expect(sampleOceanCpu(mips, n, 0, 2.5 / n, 3.5 / n, 0)[0]).toBeCloseTo(32, 12)
  })

  it('中心の間は線形', () => {
    expect(sampleOceanCpu(mips, n, 0, 3 / n, 3.5 / n, 0)[0]).toBeCloseTo(32.5, 12)
    expect(sampleOceanCpu(mips, n, 0, 2.5 / n, 4 / n, 0)[0]).toBeCloseTo(37, 12)
  })

  it('端は反対側へ巻く（repeat）', () => {
    // u = 0 は texel 7 と 0 の中点
    expect(sampleOceanCpu(mips, n, 0, 0, 0.5 / n, 0)[0]).toBeCloseTo((7 + 0) / 2, 12)
    // 1 周ずらしても同じ
    expect(sampleOceanCpu(mips, n, 0, 1 + 2.5 / n, -3 + 3.5 / n, 0)[0]).toBeCloseTo(32, 12)
  })

  it('段の端数は段の間の線形、範囲の外は端の段', () => {
    const u = 2.5 / n
    const v = 3.5 / n
    const a = sampleOceanCpu(mips, n, 0, u, v, 1)[0]!
    const b = sampleOceanCpu(mips, n, 0, u, v, 2)[0]!
    expect(sampleOceanCpu(mips, n, 0, u, v, 1.25)[0]).toBeCloseTo(a + (b - a) * 0.25, 12)
    expect(sampleOceanCpu(mips, n, 0, u, v, -3)[0]).toBeCloseTo(32, 12)
    expect(sampleOceanCpu(mips, n, 0, u, v, 99)[0]).toBeCloseTo(mips[3]![0]!, 12)
  })
})

describe('突き合わせの点と比べ方', () => {
  it('点は間隔ごとに 64 個、起点から幅の内', () => {
    for (const span of Object.values(OCEAN_SURFACE_PROBE_SPANS)) {
      const pts = oceanSurfaceProbePoints(span)
      expect(pts.length).toBe(OCEAN_SURFACE_PROBE_CELLS.length * OCEAN_SURFACE_PROBE_COUNT * 4)
      const xs = Array.from({ length: pts.length / 4 }, (_, k) => pts[k * 4]!)
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(span)
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(span * 0.9)
    }
  })

  it('CPU で引いた値を GPU の値として渡せば差は 0、向きを取り違えると大きい', () => {
    // 小さな格子で、比べ方が空回りしていないことを確かめる。4 カスケードにして、最も細かい
    // カスケード（texel 0.46 m）が間隔 40 m で足さない段に届くようにする
    const p = oceanParamsFor(4, 16)
    const N = p.size
    const C = p.cascades.length
    const disp = new Float64Array(C * N * N * 4)
    for (let i = 0; i < disp.length; i++) disp[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.91)
    const points = oceanSurfaceProbePoints(OCEAN_SURFACE_PROBE_SPANS.near)
    const M = points.length / 4
    const mips = buildOceanMips(disp, N, C)
    const gpu = new Float32Array(M * C * 4)
    for (let k = 0; k < M; k++) {
      for (let c = 0; c < C; c++) {
        const L = p.cascades[c]!
        const lod = oceanCascadeLod(points[k * 4 + 2]!, L, N)
        if (oceanCascadeSkipped(lod, N)) continue
        const v = sampleOceanCpu(mips, N, c, points[k * 4]! / L + 0.5 / N, points[k * 4 + 1]! / L + 0.5 / N, lod)
        gpu.set(v, (k * C + c) * 4)
      }
    }
    const s = compareOceanSurface(gpu, points, disp, p, oceanCascadeLod, oceanCascadeSkipped)
    // 32 ビットへ丸めた分だけ残る
    expect(s.error).toBeLessThan(1e-6)
    expect(s.transposed).toBeGreaterThan(0.1)
    expect(s.skipped).toBeGreaterThan(0)
    expect(s.byCell).toHaveLength(OCEAN_SURFACE_PROBE_CELLS.length)
  })
})

describe('LEAN のモーメントの場', () => {
  it('傾きの 2 乗と積、4 成分目は 0', () => {
    const m = oceanMomentField([2, -3, 9, 9, 0.5, 4, 1, 1])
    expect(Array.from(m)).toEqual([4, 9, -6, 0, 0.25, 16, 2, 0])
  })

  it('積のまま平均すると、平均の積より大きい（粗い段に分散が残る）', () => {
    // 傾きが +1 と −1 の 2 × 2 を 1 段平均すると、平均の傾きは 0 だが 2 乗の平均は 1
    const n = 2
    const d = field(n, (x, y, ch) => (ch === 0 ? ((x + y) % 2 === 0 ? 1 : -1) : 0))
    const mips = buildOceanMips(oceanMomentField(d), n, 1)
    const mean = buildOceanMips(d, n, 1)[1]![0]!
    expect(mean).toBe(0)
    expect(mips[1]![0]).toBe(1)
  })
})
