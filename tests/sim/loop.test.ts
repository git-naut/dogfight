import { describe, it, expect } from 'vitest'
import { FixedStepDriver, FIXED_DT, MAX_STEPS_PER_FRAME } from '@sim/loop'

describe('FixedStepDriver', () => {
  it('1 秒分の実時間で 120 ステップ進む', () => {
    const driver = new FixedStepDriver()
    let steps = 0
    // 60fps 相当で 60 フレーム分を流す
    for (let i = 0; i < 60; i++) {
      driver.advance(1 / 60, () => steps++)
    }
    expect(steps).toBe(120)
  })

  it('描画レートが違っても実時間あたりのステップ数がほぼ揃う', () => {
    // 1/144 のような値は二進浮動小数点で正確に表せない。144 回足すと
    // 1.0 をわずかに下回り、1 ステップ足りない結果になりうる。
    // 実際の performance.now() の差分はさらに不規則なので、秒あたりの
    // ステップ数を厳密に固定できるという前提は取らない。
    const run = (fps: number, seconds: number) => {
      const driver = new FixedStepDriver()
      let steps = 0
      for (let i = 0; i < fps * seconds; i++) {
        driver.advance(1 / fps, () => steps++)
      }
      return steps
    }

    for (const fps of [30, 60, 75, 120, 144, 165]) {
      expect(Math.abs(run(fps, 1) - 120)).toBeLessThanOrEqual(1)
    }
  })

  it('長時間走らせても遅れが蓄積しない', () => {
    // これが固定ステップで本当に守りたい性質。1 秒あたりの端数がずれても、
    // 繰り越しが効いていれば誤差は 1 ステップ前後に留まり、積み上がらない。
    const driver = new FixedStepDriver()
    let steps = 0
    const fps = 144
    const seconds = 600 // 10 分

    for (let i = 0; i < fps * seconds; i++) {
      driver.advance(1 / fps, () => steps++)
    }

    const expected = 120 * seconds
    expect(Math.abs(steps - expected)).toBeLessThanOrEqual(1)
  })

  it('dt に満たない delta ではステップしない', () => {
    const driver = new FixedStepDriver()
    let steps = 0
    driver.advance(FIXED_DT / 2, () => steps++)
    expect(steps).toBe(0)
  })

  it('繰り越しは失われない（半ステップ 2 回で 1 ステップ）', () => {
    const driver = new FixedStepDriver()
    let steps = 0
    driver.advance(FIXED_DT * 0.6, () => steps++)
    driver.advance(FIXED_DT * 0.6, () => steps++)
    expect(steps).toBe(1)
  })

  it('alpha は次ステップまでの進み具合を [0, 1) で返す', () => {
    const driver = new FixedStepDriver()
    const alpha = driver.advance(FIXED_DT * 1.5, () => {})
    expect(alpha).toBeGreaterThanOrEqual(0)
    expect(alpha).toBeLessThan(1)
    expect(alpha).toBeCloseTo(0.5, 6)
  })

  it('巨大な delta でも上限で打ち切る（spiral of death を避ける）', () => {
    const driver = new FixedStepDriver()
    let steps = 0
    // タブが 10 秒裏に回った想定
    driver.advance(10, () => steps++)
    expect(steps).toBe(MAX_STEPS_PER_FRAME)
    expect(driver.droppedSteps).toBeGreaterThan(0)
  })

  it('打ち切った後は蓄積が残らず、次フレームが重くならない', () => {
    const driver = new FixedStepDriver()
    driver.advance(10, () => {})

    let steps = 0
    driver.advance(1 / 60, () => steps++)
    expect(steps).toBe(2)
  })

  it('負の delta と NaN を無視する', () => {
    const driver = new FixedStepDriver()
    let steps = 0
    driver.advance(-5, () => steps++)
    driver.advance(Number.NaN, () => steps++)
    expect(steps).toBe(0)
  })

  it('reset で蓄積が消える', () => {
    const driver = new FixedStepDriver()
    driver.advance(FIXED_DT * 0.9, () => {})
    driver.reset()

    let steps = 0
    driver.advance(FIXED_DT * 0.9, () => steps++)
    expect(steps).toBe(0)
  })
})
