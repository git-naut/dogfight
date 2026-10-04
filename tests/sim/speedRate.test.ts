import { describe, expect, it } from 'vitest'
import { runScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'
import { createAircraftSample } from '@sim/aircraft'

/**
 * 速さの変化率（段 36）。HUD の SPEED の箱の増減の矢印が読む。
 * **キャプチャは 1 フレームしか描かない**ので、sim が直前のステップから出す
 */
const SEC = 120

function rateAt(script: keyof typeof SCRIPTS, frames: number): { rate: number; speed: number } {
  const w = runScript(SCRIPTS[script], frames)
  const s = w.samplePlayer(1, createAircraftSample())
  return { rate: s.speedRate, speed: s.speed }
}

describe('speedRate', () => {
  it('全開の low-pass では加速している', () => {
    // 実測 +4.84 m/s²（2 秒の時点）
    const { rate } = rateAt('low-pass', SEC * 2)
    expect(rate).toBeGreaterThan(1)
  })

  it('機首を上げる pull-up では減速している', () => {
    // 実測 −2.96 m/s²（3 秒の時点）
    const { rate } = rateAt('pull-up', SEC * 3)
    expect(rate).toBeLessThan(-1)
  })

  it('直前のステップの速さの差を刻みで割った値', () => {
    const a = runScript(SCRIPTS['low-pass'], SEC * 2 - 1).player.speed
    const { rate, speed } = rateAt('low-pass', SEC * 2)
    expect(rate).toBeCloseTo((speed - a) * SEC, 9)
  })
})
