import { describe, it, expect } from 'vitest'
import {
  airDensity,
  dynamicPressure,
  SEA_LEVEL_DENSITY,
  TROPOPAUSE_ALTITUDE,
  TROPOPAUSE_DENSITY,
  GRAVITY,
} from '@sim/isa'

describe('ISA 大気', () => {
  it('海面高度で 1.225 kg/m³', () => {
    expect(airDensity(0)).toBeCloseTo(1.225, 10)
  })

  it('対流圏界面（11 km）で ISA 標準値 0.3639 kg/m³ を 1% 以内で再現する', () => {
    const reference = 0.36392
    const actual = airDensity(TROPOPAUSE_ALTITUDE)
    expect(Math.abs(actual - reference) / reference).toBeLessThan(0.01)
  })

  it('既知の高度の ISA 値と 2% 以内で一致する', () => {
    // ISA 標準表の値
    const table: ReadonlyArray<readonly [number, number]> = [
      [1000, 1.1117],
      [3000, 0.9093],
      [5000, 0.7364],
      [8000, 0.5258],
      [10000, 0.4135],
    ]
    for (const [altitude, reference] of table) {
      const actual = airDensity(altitude)
      expect(Math.abs(actual - reference) / reference).toBeLessThan(0.02)
    }
  })

  it('対流圏界面で式が滑らかにつながる（段差がない）', () => {
    const below = airDensity(TROPOPAUSE_ALTITUDE - 0.001)
    const at = airDensity(TROPOPAUSE_ALTITUDE)
    const above = airDensity(TROPOPAUSE_ALTITUDE + 0.001)
    expect(Math.abs(below - at)).toBeLessThan(1e-6)
    expect(Math.abs(above - at)).toBeLessThan(1e-6)
    expect(at).toBeCloseTo(TROPOPAUSE_DENSITY, 12)
  })

  it('高度が上がるほど密度が下がる', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let h = 0; h <= 20_000; h += 250) {
      const rho = airDensity(h)
      expect(rho).toBeLessThan(previous)
      expect(rho).toBeGreaterThan(0)
      previous = rho
    }
  })

  it('成層圏でも指数的に減り続ける', () => {
    // 等温層なのでスケールハイト 6341.62 m ごとに 1/e
    const at11 = airDensity(11_000)
    const at11PlusH = airDensity(11_000 + 6341.62)
    expect(at11PlusH / at11).toBeCloseTo(Math.E ** -1, 6)
  })

  it('海面より下と NaN では海面値に倒れる（発散を防ぐ）', () => {
    expect(airDensity(-100)).toBe(SEA_LEVEL_DENSITY)
    expect(airDensity(Number.NaN)).toBe(SEA_LEVEL_DENSITY)
    expect(airDensity(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('動圧が速度の 2 乗に比例する', () => {
    const rho = 1.225
    const base = dynamicPressure(rho, 100)
    expect(dynamicPressure(rho, 200) / base).toBeCloseTo(4, 12)
    expect(dynamicPressure(rho, 300) / base).toBeCloseTo(9, 12)
  })

  it('重力加速度が標準値', () => {
    expect(GRAVITY).toBeCloseTo(9.80665, 10)
  })
})
