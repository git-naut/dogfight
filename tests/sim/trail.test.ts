import { describe, it, expect } from 'vitest'
import { Aircraft, TRAIL_LENGTH, TRAIL_STRIDE, createAircraftSample } from '@sim/aircraft'
import { FIXED_DT } from '@sim/loop'
import { AIRCRAFT, trimCondition } from '@sim/flightModel'
import { airDensity, temperature, CONTRAIL_TEMPERATURE } from '@sim/isa'
import { Vec3 } from '@sim/vec3'
import { neutralInput } from '@sim/input'

/**
 * 軌跡の履歴。
 *
 * 描画がコントレイルと翼端渦を作るのに使う。履歴を描画側に置くと、
 * キャプチャモードは sync が 1 回しか走らないので何も出ない。sim の状態として
 * 持つことをここで固定する。
 */

const SECOND = 120

function craftAt(altitude: number, speed: number): { craft: Aircraft; input: ReturnType<typeof neutralInput> } {
  const { throttle } = trimCondition(speed, airDensity(altitude))
  const craft = new Aircraft({
    position: new Vec3(0, altitude, 0),
    velocity: new Vec3(0, 0, -speed),
    throttle,
  })
  return { craft, input: { ...neutralInput(), throttle } }
}

describe('軌跡の履歴', () => {
  it('作った直後は空', () => {
    const { craft } = craftAt(2000, 250)
    expect(craft.trailLength).toBe(0)
  })

  it('TRAIL_STRIDE ごとに 1 点増える', () => {
    const { craft, input } = craftAt(2000, 250)
    for (let i = 0; i < TRAIL_STRIDE * 5; i++) craft.step(input, FIXED_DT)
    expect(craft.trailLength).toBe(5)
  })

  it('TRAIL_LENGTH で頭打ちになる', () => {
    const { craft, input } = craftAt(2000, 250)
    for (let i = 0; i < TRAIL_STRIDE * (TRAIL_LENGTH + 50); i++) craft.step(input, FIXED_DT)
    expect(craft.trailLength).toBe(TRAIL_LENGTH)
  })

  it('0 が最新で、後ろへ行くほど古い', () => {
    const { craft, input } = craftAt(2000, 250)
    for (let i = 0; i < SECOND * 3; i++) craft.step(input, FIXED_DT)

    const newest = craft.trailPoint(0).position.z
    const older = craft.trailPoint(5).position.z
    const oldest = craft.trailPoint(craft.trailLength - 1).position.z
    // 機首は -Z。新しいほど z が小さい
    expect(newest).toBeLessThan(older)
    expect(older).toBeLessThan(oldest)
  })

  it('リングを 1 周しても順番が崩れない', () => {
    const { craft, input } = craftAt(2000, 250)
    for (let i = 0; i < TRAIL_STRIDE * (TRAIL_LENGTH + 77); i++) craft.step(input, FIXED_DT)

    for (let i = 1; i < craft.trailLength; i++) {
      expect(
        craft.trailPoint(i - 1).position.z,
        `${i - 1} 番目と ${i} 番目`,
      ).toBeLessThan(craft.trailPoint(i).position.z)
    }
  })

  it('機体右方向と上方向が単位ベクトル', () => {
    const { craft, input } = craftAt(2000, 250)
    for (let i = 0; i < SECOND; i++) craft.step({ ...input, roll: 0.5 }, FIXED_DT)

    for (let i = 0; i < craft.trailLength; i++) {
      const point = craft.trailPoint(i)
      expect(point.right.length()).toBeCloseTo(1, 6)
      expect(point.up.length()).toBeCloseTo(1, 6)
      // 直交している
      expect(Math.abs(point.right.dot(point.up))).toBeLessThan(1e-6)
    }
  })

  it('同じ入力から同じ列が出る', () => {
    const run = (): number[] => {
      const { craft, input } = craftAt(2000, 250)
      for (let i = 0; i < SECOND * 2; i++) craft.step({ ...input, pitch: 0.3 }, FIXED_DT)
      const out: number[] = []
      for (let i = 0; i < craft.trailLength; i++) {
        const p = craft.trailPoint(i)
        out.push(p.position.x, p.position.y, p.position.z, p.loadFactor)
      }
      return out
    }
    expect(run()).toEqual(run())
  })

  it('荷重倍数と海抜が入っている', () => {
    const { craft, input } = craftAt(2000, 250)
    for (let i = 0; i < SECOND * 2; i++) craft.step({ ...input, pitch: 0.6 }, FIXED_DT)

    const newest = craft.trailPoint(0)
    expect(newest.loadFactor).toBeGreaterThan(1.5)
    // 記録は TRAIL_STRIDE ごとなので、最新でも最大 3 ステップ古い
    expect(Math.abs(newest.altitude - craft.altitude)).toBeLessThan(5)
  })

  it('墜落しても履歴は消えない', () => {
    const { craft, input } = craftAt(300, 250)
    for (let i = 0; i < SECOND * 20; i++) craft.step({ ...input, pitch: -1 }, FIXED_DT)
    expect(craft.crashed).toBe(true)
    expect(craft.trailLength).toBeGreaterThan(10)
  })

  it('サンプルは履歴を持たない（毎フレーム 256 本を写さない）', () => {
    const out = createAircraftSample()
    expect('trail' in out).toBe(false)
  })
})

describe('コントレイルが出る高度', () => {
  it('海面では気温が高くて出ない', () => {
    expect(temperature(0)).toBeGreaterThan(CONTRAIL_TEMPERATURE)
  })

  it('高度 8,462 m あたりが境目', () => {
    // ISA の気温減率 6.5 K/km。288.15 K から 233.15 K まで 55 K 下がる高度
    expect(temperature(8_000)).toBeGreaterThan(CONTRAIL_TEMPERATURE)
    expect(temperature(9_000)).toBeLessThan(CONTRAIL_TEMPERATURE)
  })

  it('対流圏界面より上は一定', () => {
    expect(temperature(12_000)).toBeCloseTo(temperature(20_000), 12)
  })

  it('この機体の実用高度では出ない', () => {
    // 迎角制限と推力の都合で 9 km 以上を保つのは難しい。コントレイルは
    // 高高度でしか出ないという物理をそのまま入れてある
    expect(temperature(3_000)).toBeGreaterThan(CONTRAIL_TEMPERATURE)
    expect(AIRCRAFT.maxThrust).toBeGreaterThan(0)
  })
})
