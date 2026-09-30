import { describe, expect, it } from 'vitest'
import { createAfterburner, flameFlicker } from '../../src/render/aircraft/afterburner'

describe('アフターバーナーの炎の脈動', () => {
  const samples = Array.from({ length: 1200 }, (_, i) => flameFlicker(i / 120))

  it('1 を中心に ±13% の内側で揺れる', () => {
    expect(Math.max(...samples)).toBeLessThanOrEqual(1.13)
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.87)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    expect(Math.abs(mean - 1)).toBeLessThan(0.01)
  })

  it('0.1 秒のうちに目に見えるだけ動く', () => {
    // 12 フレーム（0.1 秒）ごとの最大と最小の差が 5% を越える区間が大半
    let moving = 0
    for (let s = 0; s + 12 <= samples.length; s += 12) {
      const w = samples.slice(s, s + 12)
      if (Math.max(...w) - Math.min(...w) > 0.05) moving++
    }
    expect(moving / Math.floor(samples.length / 12)).toBeGreaterThan(0.8)
  })

  it('同じ秒からは同じ値。決定論', () => {
    expect(flameFlicker(2.345)).toBe(flameFlicker(2.345))
  })

  it('炎の長さが秒で揺れる。秒を渡さなければ揺れない', () => {
    const burner = createAfterburner([{ position: [0, 0, 5], radius: 0.5 }])
    const length = () => burner.object.children[0]!.scale.z
    burner.setStrength(1, 0.0)
    const a = length()
    burner.setStrength(1, 0.03)
    const b = length()
    expect(Math.abs(a - b), '秒を変えても炎の長さが変わらない').toBeGreaterThan(0.01)
    burner.setStrength(1)
    expect(length()).toBe(1)
  })
})
