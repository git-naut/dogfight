import { describe, it, expect } from 'vitest'
import { LAUNCHER_SHAPE, SILHOUETTE_STOPS, silhouetteColor } from '@hud/armament'
import { LAUNCHER_HEIGHT_REF, LAUNCHER_WIDTH_REF } from '@hud/layout'

/**
 * 兵装の欄の自機の輪郭と発射機の印（段 C3、ADR 0030）。録画のコマ 600（損傷 0%）と 19990（41%）
 */
describe('輪郭の色', () => {
  it('損傷 0 は HUD の緑、0.41 で黄、0.75 から赤', () => {
    expect(silhouetteColor(0)).toEqual(SILHOUETTE_STOPS[0]![1])
    expect(silhouetteColor(0.41)).toEqual(SILHOUETTE_STOPS[1]![1])
    expect(silhouetteColor(0.75)).toEqual(SILHOUETTE_STOPS[2]![1])
    expect(silhouetteColor(1)).toEqual(SILHOUETTE_STOPS[2]![1])
  })

  it('黄は録画の 0% → 41% の向き（赤が増え、青が減る）', () => {
    const [g, y] = [silhouetteColor(0), silhouetteColor(0.41)]
    expect(y[0]).toBeGreaterThan(g[0])
    expect(y[2]).toBeLessThan(g[2])
  })

  it('間は線形', () => {
    const mid = silhouetteColor(0.205)
    const [a, b] = [SILHOUETTE_STOPS[0]![1], SILHOUETTE_STOPS[1]![1]]
    for (let k = 0; k < 4; k++) expect(mid[k]).toBeCloseTo((a[k]! + b[k]!) / 2, 9)
  })
})

describe('発射機の印の形', () => {
  it('幅 16・高さ 82（録画のコマ 600 の左の印）', () => {
    const xs = LAUNCHER_SHAPE.filter((_, i) => i % 2 === 0)
    const ys = LAUNCHER_SHAPE.filter((_, i) => i % 2 === 1)
    expect(Math.max(...xs) - Math.min(...xs)).toBe(LAUNCHER_WIDTH_REF)
    expect(Math.max(...ys) - Math.min(...ys)).toBe(LAUNCHER_HEIGHT_REF)
  })
})
