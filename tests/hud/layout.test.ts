import { describe, expect, it } from 'vitest'
import {
  computeLayout,
  centeredBaseline,
  hudScale,
  FONT_REF,
  LABEL_FONT_REF,
  VALUE_BOX_HEIGHT_REF,
  VALUE_BOX_WIDTH_REF,
  VALUE_LABEL_GAP_REF,
  type HudElement,
  type Rect,
} from '@hud/layout'

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

  it('縮尺は録画の 1920x1080 を 1 とし、高さと幅の小さいほうに合わせる（段 B1）', () => {
    expect(hudScale(1920, 1080)).toBe(1)
    expect(hudScale(1280, 720)).toBeCloseTo(2 / 3, 12)
    // 横に長い画面は高さで、縦に長い画面は幅で決まる
    expect(hudScale(3440, 1440)).toBeCloseTo(1440 / 1080, 12)
    expect(hudScale(1000, 1200)).toBeCloseTo(1000 / 1920, 12)
  })

  /**
   * **段 B1 の合格条件。**1920x1080 で、録画（lesson 1 のコマ 144〜918 の中央値、
   * `~/.claude/plans/dogfight-ac7-ref/measure/l1_summary.json`・`l3_summary.json`）の外接矩形と
   * 各辺が画面の 1% 以内（横 19.2・縦 10.8 画素）
   */
  describe('1920x1080 で録画の位置に合う（各辺 ±1%）', () => {
    const W = 1920
    const H = 1080
    const l = computeLayout(W, H)
    const nearX = (actual: number, recorded: number, what: string) =>
      expect(Math.abs(actual - recorded), `${what}: ${actual.toFixed(1)}、録画 ${recorded}`).toBeLessThanOrEqual(W * 0.01)
    const nearY = (actual: number, recorded: number, what: string) =>
      expect(Math.abs(actual - recorded), `${what}: ${actual.toFixed(1)}、録画 ${recorded}`).toBeLessThanOrEqual(H * 0.01)
    // 見出しの大文字の上端（見出しの基線から字の大きさの 0.7 上）から数字の箱の下端まで
    const top = (cy: number) => cy - VALUE_BOX_HEIGHT_REF / 2 - VALUE_LABEL_GAP_REF - LABEL_FONT_REF * 0.7
    const bottom = (cy: number) => cy + VALUE_BOX_HEIGHT_REF / 2

    it('SPEED は x 611〜700・y 500〜557', () => {
      nearX(l.speedBox.innerX - VALUE_BOX_WIDTH_REF, 611, 'SPEED の左')
      nearX(l.speedBox.innerX, 700, 'SPEED の右（尖りの先）')
      nearY(top(l.speedBox.centerY), 500, 'SPEED の上')
      nearY(bottom(l.speedBox.centerY), 557, 'SPEED の下')
    })

    it('ALT は x 1216〜1324・y 499〜557', () => {
      nearX(l.altitudeBox.innerX, 1216, 'ALT の左（尖りの先）')
      nearX(l.altitudeBox.innerX + VALUE_BOX_WIDTH_REF, 1324, 'ALT の右')
      nearY(top(l.altitudeBox.centerY), 499, 'ALT の上')
      nearY(bottom(l.altitudeBox.centerY), 557, 'ALT の下')
    })

    it('レーダーは x 100〜399・y 724〜1025', () => {
      nearX(l.radar.x, 100, 'レーダーの左')
      nearX(l.radar.x + l.radar.size, 399, 'レーダーの右')
      nearY(l.radar.y, 724, 'レーダーの上')
      nearY(l.radar.y + l.radar.size, 1025, 'レーダーの下')
    })

    it('ミッション欄は x 100・大文字の上端 52', () => {
      nearX(l.mission.x, 100, 'ミッション欄の左')
      nearY(l.mission.y - FONT_REF * 0.7, 52, 'ミッション欄の上')
    })

    it('兵装の一覧は見出し x 1656・数の右端 x 1821・大文字の上端 708、輪郭の中心 (1698, 955)', () => {
      nearX(l.armament.labelX, 1656, '兵装の見出しの左')
      nearX(l.armament.valueX, 1821, '兵装の数の右')
      nearY(l.armament.y - FONT_REF * 0.7, 708, '兵装の上')
      nearX(l.silhouette.cx, 1698, '輪郭の中心 x')
      nearY(l.silhouette.cy, 939.5, '輪郭の中心 y（段 C3 で機体の部分の中心へ）')
    })
  })

  /** 段 B3。結果の帯（録画 x 756〜1165・y 454〜489）と SHOOT（x 920〜998・y 690〜714） */
  it('1920x1080 で結果の帯と SHOOT が録画の位置に合う（各辺 ±1%）', () => {
    const { bounds } = computeLayout(1920, 1080)
    const near = (r: Rect, x0: number, y0: number, x1: number, y1: number, what: string) => {
      expect(Math.abs(r.x - x0), `${what} の左`).toBeLessThanOrEqual(19.2)
      expect(Math.abs(r.x + r.w - x1), `${what} の右`).toBeLessThanOrEqual(19.2)
      expect(Math.abs(r.y - y0), `${what} の上`).toBeLessThanOrEqual(10.8)
      expect(Math.abs(r.y + r.h - y1), `${what} の下`).toBeLessThanOrEqual(10.8)
    }
    near(bounds.banner, 756, 454, 1165, 489, '結果の帯')
    near(bounds.shoot, 920, 690, 998, 714, 'SHOOT')
  })

  it('全画面の視点（full）の目盛りの位置は段 36 までの式のまま', () => {
    // 追従視点では描かない（段 36）。操縦席など別の視点のために残している
    const l = computeLayout(1280, 720)
    expect(l.speedTape).toEqual({ x: 1280 * 0.18, centerY: 720 * 0.5, halfHeight: 720 * 0.22 })
    expect(l.altitudeTape.x).toBe(1280 * 0.82)
    expect(l.headingTape).toEqual({ centerX: 640, y: 720 * 0.11, halfWidth: 256 })
  })
})

describe('字の上下の中央（段 D3）', () => {
  it('字形の上端と下端の真ん中が中心に来る基線を返す', () => {
    // 上へ 22、下へ 0 の字なら、基線は中心より 11 下
    expect(centeredBaseline(539, 22, 0)).toBe(550)
    const y = centeredBaseline(100, 20, 4)
    expect((y - 20 + (y + 4)) / 2).toBe(100)
  })
})
