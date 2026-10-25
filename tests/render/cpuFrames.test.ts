import { describe, expect, it } from 'vitest'
import { CPU_FRAME_HISTORY, pushFrame } from '@render/cpuFrames'
import { PASS_HISTORY } from '@render/gpuTimer'

/**
 * フレームごとの CPU の内訳の輪（段 S0e）。GPU の内訳と同じ長さで残し、
 * 実機の計測がフレーム番号で突き合わせる。
 */
describe('フレームごとの CPU の内訳の輪', () => {
  it('古い順に積み、上限で前から捨てる', () => {
    const ring: number[] = []
    for (let i = 0; i < 10; i++) pushFrame(ring, i, 4)
    expect(ring).toEqual([6, 7, 8, 9])
  })

  it('上限までは捨てない', () => {
    const ring: number[] = []
    for (let i = 0; i < 4; i++) pushFrame(ring, i, 4)
    expect(ring).toEqual([0, 1, 2, 3])
  })

  it('既定の上限は GPU の内訳の輪と同じ長さ', () => {
    // 短いと、0.5 秒おきに読む計測で GPU の内訳と突き合わせる相手が先に消える
    expect(CPU_FRAME_HISTORY).toBe(PASS_HISTORY)
    const ring: number[] = []
    for (let i = 0; i < CPU_FRAME_HISTORY * 2; i++) pushFrame(ring, i)
    expect(ring).toHaveLength(CPU_FRAME_HISTORY)
    expect(ring[0]).toBe(CPU_FRAME_HISTORY)
  })
})
