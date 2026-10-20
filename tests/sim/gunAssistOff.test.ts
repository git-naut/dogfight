import { describe, it, expect, vi } from 'vitest'
import { crossingHits } from './gunAssist.shared'

// 寄せる角を 0 にして、寄せのない場合を回す
vi.mock('@sim/weapons/gunLead', async (importOriginal) => {
  const original = await importOriginal<typeof import('@sim/weapons/gunLead')>()
  return { ...original, GUN_ASSIST_ANGLE: 0 }
})

describe('弾を寄せない場合（比べるため）', () => {
  /** 機首は迎角のぶん相手より約 2 度上を向いているので、寄せなしでは 1 発も当たらない */
  it.each([0.1, 0.2])('旋回率 %f rad/s の標的に当たらない', (turnRate) => {
    const { hits } = crossingHits(turnRate)
    expect(hits).toBe(0)
  })
})
