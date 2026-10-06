import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { readGltfParts } from '../../tools/gltf-parts.mjs'
import { DECK_HEIGHT, toWorld } from '../../tools/ford-parts.mjs'
import {
  FORD_CATAPULTS,
  FORD_DECK_HEIGHT,
  FORD_DECK_OUTLINE,
  FORD_ISLAND,
  FORD_LANDING_CENTERLINE,
  FORD_WIRES,
} from '../../src/sim/fordDeck'

/**
 * 空母 Ford の甲板のデータ（Phase 9 の段 3）。
 *
 * `src/sim/fordDeck.ts` の値は `tools/ford-deck-measure.py` がテクスチャの標識から測った
 * `assets/generated/ford/deck.json` を写したもの。ここでは 3 つの側から確かめる。
 * 1 つ目は JSON と食い違わないこと。2 つ目は測った角度を数字で固定すること。
 * 3 つ目は標識とは別の手がかり（原本の glTF の部品の形）と矛盾しないこと
 */
const GLTF = fileURLToPath(new URL('../../assets/upstream/ford/scene.gltf', import.meta.url))
const DECK_JSON = fileURLToPath(new URL('../../assets/generated/ford/deck.json', import.meta.url))

type Point = readonly [number, number]
type CatName = keyof typeof FORD_CATAPULTS
const CAT_NAMES: CatName[] = ['cat-1', 'cat-2', 'cat-3', 'cat-4']

/** 艦首へ向かうほど左舷へ寄る角度（度）。艦の軸と平行なら 0 */
const angleDeg = (start: Point, end: Point) => (Math.atan2(start[0] - end[0], start[1] - end[1]) * 180) / Math.PI

/** 点が多角形の内側か（偶奇の規則） */
const inside = (p: Point, polygon: readonly Point[]) => {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) result = !result
  }
  return result
}

/** 世界座標の (x, z) の外接箱 */
const worldBox = (p: { min: readonly number[]; max: readonly number[] }) => {
  const a = toWorld(p.min)
  const b = toWorld(p.max)
  return {
    xMin: Math.min(a[0], b[0]),
    xMax: Math.max(a[0], b[0]),
    zMin: Math.min(a[2], b[2]),
    zMax: Math.max(a[2], b[2]),
    top: Math.max(a[1], b[1]),
  }
}

describe('Ford の甲板のデータ', () => {
  it('測った JSON と 0.01 m 以内で一致する', () => {
    const json = JSON.parse(readFileSync(DECK_JSON, 'utf8'))
    expect(FORD_DECK_HEIGHT).toBeCloseTo(json.deckTop, 2)
    for (const name of CAT_NAMES) {
      for (const end of ['start', 'end'] as const) {
        for (const k of [0, 1]) expect(FORD_CATAPULTS[name][end][k], `${name} ${end}`).toBeCloseTo(json.catapults[name][end][k], 2)
      }
    }
    expect(FORD_LANDING_CENTERLINE.k).toBeCloseTo(json.landingCenterline.k, 6)
    expect(FORD_LANDING_CENTERLINE.c).toBeCloseTo(json.landingCenterline.c, 3)
    expect(FORD_DECK_OUTLINE).toEqual(json.outline)
  })

  it('甲板の高さが変換（ford-parts）の値と同じ', () => {
    expect(FORD_DECK_HEIGHT).toBeCloseTo(DECK_HEIGHT, 2)
  })

  it('カタパルトの向きが測った角度のまま。cat-4 は艦の軸と平行', () => {
    // 期待値は定数から作らず、測った値を数字で書く（fordDeck.ts の表と同じ）
    const measured: Record<CatName, number> = { 'cat-1': 4.03, 'cat-2': 2.21, 'cat-3': 4.37, 'cat-4': 0.04 }
    for (const name of CAT_NAMES) {
      const { start, end } = FORD_CATAPULTS[name]
      expect(angleDeg(start, end), name).toBeCloseTo(measured[name], 1)
      // 射出は艦首（−Z）へ向かう
      expect(end[1], name).toBeLessThan(start[1])
    }
    // ミッションが発進に使う 1 本（段 4）。帯に沿って走ると艦の軸と平行になる
    const cat4 = FORD_CATAPULTS['cat-4']
    expect(Math.abs(angleDeg(cat4.start, cat4.end))).toBeLessThan(0.5)
  })

  it('カタパルトと拘束索の両端が甲板の輪郭の内側にある', () => {
    for (const name of CAT_NAMES) {
      for (const p of [FORD_CATAPULTS[name].start, FORD_CATAPULTS[name].end]) expect(inside(p, FORD_DECK_OUTLINE), name).toBe(true)
    }
    for (const [i, wire] of FORD_WIRES.entries()) {
      expect(inside(wire.starboard, FORD_DECK_OUTLINE), `索 ${i + 1} 右舷`).toBe(true)
      expect(inside(wire.port, FORD_DECK_OUTLINE), `索 ${i + 1} 左舷`).toBe(true)
    }
  })

  it('拘束索は 3 本、中心線に直交し、中心線をはさんで左右に張られる', () => {
    const { k, c } = FORD_LANDING_CENTERLINE
    // 中心線の向き（艦尾へ）
    const len = Math.hypot(k, 1)
    const along = [k / len, 1 / len] as const
    expect(FORD_WIRES).toHaveLength(3)
    const s: number[] = []
    for (const [i, { starboard, port }] of FORD_WIRES.entries()) {
      const dx = starboard[0] - port[0]
      const dz = starboard[1] - port[1]
      // 直交：索の向きと中心線の向きの内積が 0
      expect(Math.abs(dx * along[0] + dz * along[1]) / Math.hypot(dx, dz), `索 ${i + 1}`).toBeLessThan(0.01)
      // 右舷の端が中心線の右（+X 側）、左舷の端が左
      expect(starboard[0], `索 ${i + 1}`).toBeGreaterThan(k * starboard[1] + c)
      expect(port[0], `索 ${i + 1}`).toBeLessThan(k * port[1] + c)
      // 索の中点は中心線の上
      const mid = [(starboard[0] + port[0]) / 2, (starboard[1] + port[1]) / 2] as const
      expect(Math.abs(mid[0] - (k * mid[1] + c))).toBeLessThan(0.05)
      s.push(mid[0] * along[0] + mid[1] * along[1])
    }
    // 艦尾に近い順（中心線に沿った位置が減っていく）、間隔は 10〜14 m、着艦区域の後ろ寄り
    for (let i = 1; i < s.length; i++) {
      const gap = s[i - 1]! - s[i]!
      expect(gap).toBeGreaterThan(10)
      expect(gap).toBeLessThan(14)
    }
    for (const v of s) {
      expect(v).toBeGreaterThan(60)
      expect(v).toBeLessThan(130)
    }
  })
})

describe('原本の部品の形と突き合わせる', () => {
  const result = readGltfParts(GLTF)

  it('ブラスト・ディフレクターが、各カタパルトの始点の 15〜35 m 後ろ、帯の延長の 6 m 以内にある', () => {
    // 標識（テクスチャ）とは別の手がかり。ディフレクターは射出の始点の後ろに立つ
    const deflectors = result.parts.filter((p) => /^blast_deflector/.test(p.name)).map(worldBox)
    expect(deflectors).toHaveLength(4)
    for (const name of CAT_NAMES) {
      const { start, end } = FORD_CATAPULTS[name]
      const length = Math.hypot(start[0] - end[0], start[1] - end[1])
      // 艦尾へ向かう帯の向き
      const back = [(start[0] - end[0]) / length, (start[1] - end[1]) / length] as const
      const hits = deflectors.filter((d) => {
        const rx = (d.xMin + d.xMax) / 2 - start[0]
        const rz = (d.zMin + d.zMax) / 2 - start[1]
        const behind = rx * back[0] + rz * back[1]
        const lateral = Math.abs(rx * back[1] - rz * back[0])
        return behind > 15 && behind < 35 && lateral < 6
      })
      expect(hits, name).toHaveLength(1)
    }
  })

  it('艦橋の箱が、甲板より上にある艦橋まわりの部品の和と 0.1 m 以内で一致する', () => {
    const union = { xMin: Infinity, xMax: -Infinity, zMin: Infinity, zMax: -Infinity, top: -Infinity }
    for (const box of result.parts.map(worldBox)) {
      const cx = (box.xMin + box.xMax) / 2
      const cz = (box.zMin + box.zMax) / 2
      if (box.top < 19.5 || cx < 15 || cx > 42 || cz < 75 || cz > 106) continue
      union.xMin = Math.min(union.xMin, box.xMin)
      union.xMax = Math.max(union.xMax, box.xMax)
      union.zMin = Math.min(union.zMin, box.zMin)
      union.zMax = Math.max(union.zMax, box.zMax)
      union.top = Math.max(union.top, box.top)
    }
    for (const key of ['xMin', 'xMax', 'zMin', 'zMax', 'top'] as const) {
      expect(Math.abs(FORD_ISLAND[key] - union[key]), key).toBeLessThan(0.1)
    }
    // 実物と同じく右舷
    expect(FORD_ISLAND.xMin).toBeGreaterThan(0)
  })
})
