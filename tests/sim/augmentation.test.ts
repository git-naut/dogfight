import { describe, expect, it } from 'vitest'
import { AUGMENTATION_THROTTLE, augmentation } from '../../src/sim/flightModel'

describe('アフターバーナーの強さ', () => {
  it('スロットル 0.85 までは 0、超えた分を 0..1 へ写す', () => {
    // **描画の 2 か所に同じ値が二重に定義されていた**（`aircraftView.ts` と
    // `enemyView.ts`）。熱源（段 30b）も同じ値を読むので sim へ移した
    expect(AUGMENTATION_THROTTLE).toBe(0.85)
    expect(augmentation(0.85)).toBe(0)
    expect(augmentation(0.5)).toBe(0)
    expect(augmentation(1)).toBe(1)
    expect(augmentation(0.925)).toBeCloseTo(0.5)
  })

  it('範囲の外は切る', () => {
    expect(augmentation(1.2)).toBe(1)
    expect(augmentation(-1)).toBe(0)
  })
})
