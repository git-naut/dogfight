import { describe, it, expect } from 'vitest'
import { crossingHits } from './gunAssist.shared'

/**
 * 弾の寄せ（Phase 10 の段 D4、ADR 0032）。500 m 前で旋回する標的に、自機は真っすぐ飛んで撃つ。
 * 寄せのない場合は `gunAssistOff.test.ts`（寄せる角を 0 にして同じ場面を回す）
 */
describe('弾を未来位置へ寄せる', () => {
  /**
   * 寄せありで 60 発当たって落ちる（耐久 60）。寄せなしは 0 発（`gunAssistOff.test.ts`）。旋回を入れない
   * 未来位置（等速とみる）では、旋回率 0.05 で 1 発、0.1 で 0 発だった
   */
  it.each([0.1, 0.2])('旋回率 %f rad/s の標的を落とす', (turnRate) => {
    const { hits, snapped } = crossingHits(turnRate)
    expect(snapped).toBeGreaterThan(100)
    expect(hits).toBeGreaterThanOrEqual(60)
  })
})
