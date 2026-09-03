import { describe, expect, it } from 'vitest'
import {
  HEIGHT_PROBE_COUNT,
  HEIGHT_PROBE_PER_REGION,
  HEIGHT_PROBE_REGIONS,
  HEIGHT_PROBE_SIDE,
  heightMaxError,
  heightProbePoint,
  heightProbeValues,
} from '@render/terrain/heightProbe'
import {
  SEABED_HEIGHT,
  TERRAIN_EXTENT,
  TERRAIN_TEXEL,
  defaultTerrain,
} from '@sim/terrain'

/**
 * 高さ場の突き合わせに使う標本点。
 *
 * **GPU 側と CPU 側が同じ式で同じ点を引く**ことが要点。点の並びがずれると
 * 別の点どうしを比べることになり、突き合わせが嘘をつく。
 */
describe('高さ場の標本点', () => {
  it('区画ごとに 64 点ずつ並ぶ', () => {
    expect(HEIGHT_PROBE_PER_REGION).toBe(HEIGHT_PROBE_SIDE * HEIGHT_PROBE_SIDE)
    expect(HEIGHT_PROBE_COUNT).toBe(
      HEIGHT_PROBE_PER_REGION * HEIGHT_PROBE_REGIONS.length,
    )
  })

  it('行が先、列があとで並ぶ', () => {
    const r = HEIGHT_PROBE_REGIONS[0]!
    expect(heightProbePoint(0)).toEqual({ x: r.origin.x, z: r.origin.z })
    expect(heightProbePoint(1)).toEqual({
      x: r.origin.x + r.step.x,
      z: r.origin.z,
    })
    expect(heightProbePoint(HEIGHT_PROBE_SIDE)).toEqual({
      x: r.origin.x,
      z: r.origin.z + r.step.z,
    })
  })

  it('2 つ目の区画へ切り替わる', () => {
    const second = HEIGHT_PROBE_REGIONS[1]!
    expect(heightProbePoint(HEIGHT_PROBE_PER_REGION)).toEqual({
      x: second.origin.x,
      z: second.origin.z,
    })
  })

  it('刻みがテクセルの倍数でない', () => {
    // **格子点に乗ると双三次が `t = 0` になり、補間の途中を通らない**
    for (const r of HEIGHT_PROBE_REGIONS) {
      expect(r.step.x % TERRAIN_TEXEL, `x の刻み ${r.step.x}`).not.toBe(0)
      expect(r.step.z % TERRAIN_TEXEL, `z の刻み ${r.step.z}`).not.toBe(0)
    }
  })

  it('範囲の外を通る点がある', () => {
    // **縁で止める処理はそこでしか通らない。**外すと範囲外を引いて 0 が返る
    const half = TERRAIN_EXTENT / 2
    const outside = Array.from({ length: HEIGHT_PROBE_COUNT }, (_, i) =>
      heightProbePoint(i),
    ).filter((p) => Math.abs(p.x) > half || Math.abs(p.z) > half)
    expect(outside.length).toBeGreaterThan(4)
  })

  it('起伏のある点と平らな点の両方を通る', () => {
    const terrain = defaultTerrain()
    const heights = Array.from({ length: HEIGHT_PROBE_COUNT }, (_, i) => {
      const p = heightProbePoint(i)
      return terrain.heightAt(p.x, p.z)
    })
    const land = heights.filter((h) => h > 0).length
    const varied = heights.filter((h) => Math.abs(h - SEABED_HEIGHT) > 0.5).length
    expect(land, `陸地 ${land} 点`).toBeGreaterThan(20)
    expect(varied, `平らでない点 ${varied} 点`).toBeGreaterThan(40)
    expect(Math.max(...heights)).toBeGreaterThan(1000)
  })
})

describe('高さの読み取り', () => {
  it('R 成分だけを取り出す', () => {
    const pixels = [1, 9, 9, 9, 2, 9, 9, 9, 3, 9, 9, 9]
    expect(heightProbeValues(pixels)).toEqual([1, 2, 3])
  })

  it('同じ並びどうしのずれは 0', () => {
    expect(heightMaxError([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('最大のずれを返す', () => {
    expect(heightMaxError([1, 2, 3], [1, 2.5, 3])).toBeCloseTo(0.5, 12)
  })

  it('長さが違えば無限大', () => {
    // **0 を返してはいけない。**読み戻せていない絵を「一致した」と読む
    expect(heightMaxError([1], [1, 2])).toBe(Number.POSITIVE_INFINITY)
    expect(heightMaxError([], [])).toBe(Number.POSITIVE_INFINITY)
  })

  it('NaN を通さない', () => {
    // 読み戻しが足りないと `heightProbeValues` が NaN を返す
    expect(heightMaxError([1, 2], [1, Number.NaN])).toBe(Number.POSITIVE_INFINITY)
  })
})
