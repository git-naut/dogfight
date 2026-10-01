import { describe, expect, it } from 'vitest'
import { computeLayout, type HudElement, type Rect } from '@hud/layout'

/**
 * HUD の配置の器（段 31）。**5 種の画面の大きさで、全要素の組が交差しないこと**を
 * 総当たりで見る（計画書の段 28）。要素を足すときは、ここに落ちることで重なりに気づける
 */
const SIZES: readonly [number, number][] = [
  [1280, 720],
  [1920, 1080],
  [1920, 946],
  [1366, 768],
  [1024, 600],
]

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe('HUD の配置', () => {
  it.each(SIZES)('%i x %i で、どの 2 つの要素も重ならない', (w, h) => {
    const { bounds } = computeLayout(w, h)
    const names = Object.keys(bounds) as HudElement[]
    const overlaps: string[] = []
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        if (intersects(bounds[names[i]!], bounds[names[j]!])) overlaps.push(`${names[i]} と ${names[j]}`)
      }
    }
    expect(overlaps, overlaps.join(' / ')).toEqual([])
  })

  it.each(SIZES)('%i x %i で、どの要素も画面の中に収まる', (w, h) => {
    const { bounds } = computeLayout(w, h)
    for (const [name, r] of Object.entries(bounds)) {
      expect(r.x, `${name} の左`).toBeGreaterThanOrEqual(0)
      expect(r.y, `${name} の上`).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w, `${name} の右`).toBeLessThanOrEqual(w)
      expect(r.y + r.h, `${name} の下`).toBeLessThanOrEqual(h)
    }
  })

  it('位置の式は元の hud.ts と同じ値を返す', () => {
    // **合格条件は基準画像が 1 画素も動かないこと。**元の式（`width * 0.18` など）と
    // ビットまで同じかを、代表の大きさで元の式の形のまま突き合わせる（`1280 * 0.18` は
    // 230.39999999999998 で、丸めた 230.4 とは別の値）
    const l = computeLayout(1280, 720)
    expect(l.speedTape).toEqual({ x: 1280 * 0.18, centerY: 720 * 0.5, halfHeight: 720 * 0.22 })
    expect(l.altitudeTape.x).toBe(1280 * 0.82)
    expect(l.headingTape).toEqual({ centerX: 640, y: 720 * 0.11, halfWidth: 256 })
    expect(l.dlzBar).toEqual({ x: 1280 * 0.66, bottom: 435 })
    expect(l.armament).toEqual({ x: 640, y: 720 * 0.9 })
    expect(l.mission).toEqual({ x: 1280 * 0.06, y: 720 * 0.08 })
    expect(l.threat).toEqual({ cx: 1280 * 0.3, cy: 720 * 0.3, radius: 26 })
    expect(l.readouts).toEqual({ x: 1280 * 0.18, y: 720 * 0.78 })
    expect(l.agl).toEqual({ x: 1280 * 0.82, y: 720 * 0.78 })
    expect(l.warnings).toEqual({ x: 640, y: 720 * 0.7 })
  })
})
