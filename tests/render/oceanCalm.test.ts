import { describe, it, expect } from 'vitest'
import {
  CARRIER_CALM_BAND,
  CARRIER_HULL,
  WATERLINE_FOAM_BAND,
  carrierCalm,
  carrierLocal,
  hullDistance,
  waterlineFoam,
} from '@render/ocean/oceanCalm'
import { catapultLaunch } from '@sim/carrierDeck'
import { buildFrequencyIndex, buildH0, oceanFields, oceanParamsFor } from '@render/ocean/reference'

/**
 * 空母のまわりの凪と喫水線の泡、カメラの高さに対する波の上限（段 S4a-3）
 */

describe('船の座標系', () => {
  it('カタパルトの射出の始点を船の座標へ戻すと、甲板の上の同じ点になる', () => {
    // `catapultLaunch` は船の座標を艦首の向きで回して位置を足す。その逆になっていること
    const carrier = { x: 1_234, z: -5_678, heading: 0.7 }
    const zero = catapultLaunch({ x: 0, z: 0, heading: 0 }, 'cat-1', 91.44)
    const placed = catapultLaunch(carrier, 'cat-1', 91.44)
    const [lx, lz] = carrierLocal(placed.from.x, placed.from.z, carrier)
    expect(lx).toBeCloseTo(zero.from.x, 9)
    expect(lz).toBeCloseTo(zero.from.z, 9)
  })
})

describe('船体からの距離', () => {
  it('中心は内側（負）で、深さは半幅', () => {
    expect(hullDistance(CARRIER_HULL.centerX, CARRIER_HULL.centerZ)).toBeCloseTo(-CARRIER_HULL.halfWidth, 9)
  })

  it('舷側の真横は水線からの距離', () => {
    const x = CARRIER_HULL.centerX + CARRIER_HULL.halfWidth + 7
    expect(hullDistance(x, CARRIER_HULL.centerZ + 50)).toBeCloseTo(7, 9)
  })

  it('艦首と艦尾は半幅の丸みで閉じる', () => {
    const tip = CARRIER_HULL.centerZ - CARRIER_HULL.halfLength
    expect(hullDistance(CARRIER_HULL.centerX, tip)).toBeCloseTo(0, 9)
    expect(hullDistance(CARRIER_HULL.centerX, tip - 10)).toBeCloseTo(10, 9)
  })

  it('測った水線の外接箱（x −18.0〜+20.6、z −159.4〜+161.5）の端は水線の上か外', () => {
    for (const [x, z] of [
      [-18.0, CARRIER_HULL.centerZ],
      [20.6, CARRIER_HULL.centerZ],
      [CARRIER_HULL.centerX, -159.4],
      [CARRIER_HULL.centerX, 161.5],
    ] as const) {
      expect(Math.abs(hullDistance(x, z))).toBeLessThan(0.1)
    }
  })
})

describe('凪の係数', () => {
  it('船体の中と水線で 0、帯の外で 1、間は単調', () => {
    expect(carrierCalm(-5)).toBe(0)
    expect(carrierCalm(0)).toBe(0)
    expect(carrierCalm(CARRIER_CALM_BAND)).toBe(1)
    expect(carrierCalm(500)).toBe(1)
    let prev = 0
    for (let d = 0; d <= CARRIER_CALM_BAND; d += 1) {
      const s = carrierCalm(d)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })
})

describe('喫水線の泡', () => {
  it('水線の外側の帯にだけ注ぐ', () => {
    expect(waterlineFoam(-1)).toBe(0)
    expect(waterlineFoam(0)).toBeGreaterThan(0.5)
    expect(waterlineFoam(WATERLINE_FOAM_BAND)).toBe(0)
    expect(waterlineFoam(WATERLINE_FOAM_BAND / 2)).toBeGreaterThan(0)
  })
})

describe('波の上限とカメラの高さ', () => {
  it('high の海の高さの上限（カスケードごとの最大の和）がカメラの最低高度 2.5 m より 1 m 以上低い', () => {
    // 2026-10-29 の実測で 4 × 256 は 1.02 m（3 時刻）。ここは格子を 128 にして 1 時刻で縛る
    const p = oceanParamsFor(4, 128)
    const N = p.size
    const f = oceanFields(buildH0(p), buildFrequencyIndex(p), 30_000, 0, p)
    let bound = 0
    for (let c = 0; c < p.cascades.length; c++) {
      let m = 0
      for (let i = 0; i < N * N; i++) m = Math.max(m, Math.abs(f.displacement[(c * N * N + i) * 4 + 1]!))
      bound += m
    }
    expect(bound).toBeGreaterThan(0.3)
    expect(bound).toBeLessThan(1.5)
  })
})
