import { describe, expect, it } from 'vitest'
import {
  MARCH_PROBE_CAMERA,
  MARCH_PROBE_HEIGHT,
  MARCH_PROBE_LIGHT_GROWTH,
  MARCH_PROBE_MAX_DISTANCE,
  MARCH_PROBE_MAX_STEPS,
  MARCH_PROBE_STEP_GROWTH,
  MARCH_PROBE_SUN,
  MARCH_PROBE_WIDTH,
  byteDifference,
  marchExhaustedCount,
  marchSampleStats,
} from '@render/clouds/marchProbe'
import { CLOUD_BOTTOM, CLOUD_TOP, NEAR_STEP } from '@render/clouds/geometry'

/**
 * マーチの突き合わせに使う固定入力と、その読み取り。
 *
 * **GLSL 版と TSL 版が同じこの関数を通る**ことが要点。片方だけ別の数え方を
 * すると、突き合わせが嘘をつく。段 13 の合格条件は密度サンプル数の一致で、
 * その数はここで作られる。
 */

/** R と G に 16bit 整数を詰めた絵を作る */
function packed(counts: number[]): Uint8Array {
  const out = new Uint8Array(counts.length * 4)
  for (let i = 0; i < counts.length; i++) {
    out[i * 4] = Math.floor(counts[i]! / 256)
    out[i * 4 + 1] = counts[i]! % 256
    out[i * 4 + 2] = 0
    out[i * 4 + 3] = 255
  }
  return out
}

describe('マーチのサンプル数', () => {
  it('R と G の 16bit を復元して数える', () => {
    const stats = marchSampleStats(packed([0, 1, 255, 256, 65535]))
    expect(stats.total).toBe(0 + 1 + 255 + 256 + 65535)
    expect(stats.max).toBe(65535)
    // 0 の画素は歩いていない
    expect(stats.hit).toBe(4)
  })

  it('上位バイトを落とさない', () => {
    // **`c = R * 256 + G`。**R を無視すると 256 以上が全部同じに見える
    expect(marchSampleStats(packed([300])).total).toBe(300)
    expect(marchSampleStats(packed([300])).max).toBe(300)
  })

  it('空なら 0', () => {
    const stats = marchSampleStats(new Uint8Array(0))
    expect(stats).toEqual({ total: 0, max: 0, hit: 0 })
  })

  it('打ち切りは G チャンネルで数える', () => {
    // `probeMode = 2` は `vec4(0, exhausted ? 1 : 0, 0, 1)` を書く
    const bytes = new Uint8Array([0, 255, 0, 255, 0, 0, 0, 255, 0, 255, 0, 255])
    expect(marchExhaustedCount(bytes)).toBe(2)
  })

  it('打ち切りが無ければ 0', () => {
    expect(marchExhaustedCount(new Uint8Array([0, 0, 0, 255]))).toBe(0)
  })
})

describe('マーチの固定入力', () => {
  it('カメラが雲層の内側にある', () => {
    // **外に置くと通らない枝ができる。**雲底の下から見上げる構図では
    // 歩数を使い切った画素が 0 になり、打ち切りの移植が検査されなかった
    // **定数から読む。**ここに数を書き写すと、カメラを動かしても気づけない
    expect(MARCH_PROBE_CAMERA.positionY).toBeGreaterThan(CLOUD_BOTTOM)
    expect(MARCH_PROBE_CAMERA.positionY).toBeLessThan(CLOUD_TOP)
  })

  it('伸び率が歩数と上限距離から解かれている', () => {
    // `stepGrowthScale` は連続版 t(k) = G * (exp(NEAR_STEP * k / G) - 1) を
    // 二分法で解く。**離散の積み上げは連続解を下回る**（64 歩で 23,661 m）
    // ので、ここでは解いた式のほうで確かめる
    const g = MARCH_PROBE_STEP_GROWTH
    const reach = g * (Math.exp((NEAR_STEP * MARCH_PROBE_MAX_STEPS) / g) - 1)
    expect(reach).toBeCloseTo(MARCH_PROBE_MAX_DISTANCE, 0)
  })

  it('光マーチの伸び率が 1 より大きい', () => {
    expect(MARCH_PROBE_LIGHT_GROWTH).toBeGreaterThan(1)
  })

  it('太陽が地平線より上にある', () => {
    // 下にあると雲が真っ暗になり、絵の突き合わせが空回りする
    expect(MARCH_PROBE_SUN.y).toBeGreaterThan(0)
  })

  it('焼く大きさが 16:9', () => {
    expect(MARCH_PROBE_WIDTH / MARCH_PROBE_HEIGHT).toBeCloseTo(16 / 9, 6)
  })
})

describe('バイトの違い', () => {
  it('同じものどうしは 0', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    expect(byteDifference(a, a)).toEqual({ differing: 0, max: 0 })
  })

  it('違う数と最大の差を返す', () => {
    const a = new Uint8Array([0, 10, 20, 30])
    const b = new Uint8Array([0, 12, 20, 99])
    expect(byteDifference(a, b)).toEqual({ differing: 2, max: 69 })
  })

  it('長さが違えば無限大', () => {
    // **0 を返してはいけない。**読み戻せていない絵を「一致した」と読む
    const d = byteDifference(new Uint8Array(4), new Uint8Array(8))
    expect(d.differing).toBe(Number.POSITIVE_INFINITY)
    expect(d.max).toBe(Number.POSITIVE_INFINITY)
  })

  it('符号によらず差の大きさを見る', () => {
    expect(byteDifference(new Uint8Array([5]), new Uint8Array([1])).max).toBe(4)
    expect(byteDifference(new Uint8Array([1]), new Uint8Array([5])).max).toBe(4)
  })
})
