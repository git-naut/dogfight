import { describe, it, expect } from 'vitest'
import {
  softClipCurve,
  SOFT_CLIP_KNEE,
  SOFT_CLIP_LIMIT,
  SOFT_CLIP_DOMAIN,
} from '../../src/audio/synth'

/**
 * ソフトクリップのカーブ。
 *
 * **主題は「必ず上限を下回る」。**`DynamicsCompressorNode` はルック
 * アヘッドを持たず瞬間的なピークを通すので、最後の砦がここになる。
 * 実測で、これを入れる前は全部が同時に鳴る場合の 8 回中 2 回が 1 を
 * 超えた（`docs/audio.md`）。
 */

const N = 8192
const curve = softClipCurve(N)

/** インデックスから入力値を戻す */
function inputAt(i: number): number {
  return (i / (N - 1)) * 2 * SOFT_CLIP_DOMAIN - SOFT_CLIP_DOMAIN
}

describe('ソフトクリップ', () => {
  /**
   * **これが本質。**サンプル値が 1 を超えるとクリップする。
   *
   * 上限 0.98 はそのための余裕であって、目的ではない。
   */
  it('どの点も 1 を下回る', () => {
    let worst = 0
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(curve[i]!))
    expect(worst).toBeLessThan(1)
  })

  /**
   * 上限のあたりに収まっている。
   *
   * **ぴったり `SOFT_CLIP_LIMIT` 以下にはならない。**`Float32Array` へ
   * 入れた時点で丸められ、0.98 が 0.98000002 になる。相対誤差は
   * 2 の −24 乗 ≒ 6e-8。それを許す幅で見る
   */
  it('上限のあたりに収まる', () => {
    let worst = 0
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(curve[i]!))
    expect(worst).toBeLessThanOrEqual(SOFT_CLIP_LIMIT * (1 + 1e-6))
    expect(worst).toBeGreaterThan(SOFT_CLIP_LIMIT * 0.99)
  })

  /**
   * **1.0 に張り付かせない。**上限を 1 にすると `tanh` の漸近部分が
   * Float32 でちょうど 1.0 に丸められ、上限に触れているかどうかを
   * 測って区別できなくなる
   */
  it('上限は 1 未満', () => {
    expect(SOFT_CLIP_LIMIT).toBeLessThan(1)
  })

  it('小信号は素通し', () => {
    for (const x of [0, 0.1, 0.3, 0.5, SOFT_CLIP_KNEE]) {
      const i = Math.round(((x + SOFT_CLIP_DOMAIN) / (2 * SOFT_CLIP_DOMAIN)) * (N - 1))
      expect(curve[i]!).toBeCloseTo(inputAt(i), 3)
    }
  })

  it('単調に増える', () => {
    for (let i = 1; i < N; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!)
    }
  })

  it('奇関数。負の側も同じ形', () => {
    for (let i = 0; i < N; i++) {
      expect(curve[i]!).toBeCloseTo(-curve[N - 1 - i]!, 5)
    }
  })

  /** 膝から上は入力が増えても出力が増えにくい */
  it('膝から上は圧縮される', () => {
    const at = (x: number): number =>
      curve[Math.round(((x + SOFT_CLIP_DOMAIN) / (2 * SOFT_CLIP_DOMAIN)) * (N - 1))]!
    const slopeBelow = at(0.6) - at(0.5)
    const slopeAbove = at(2.6) - at(2.5)
    expect(slopeAbove).toBeLessThan(slopeBelow * 0.1)
  })

  /** 定義域の端でも上限を割っている。ここが WaveShaper のクランプ値になる */
  it('定義域の端が 1 を割る', () => {
    // WaveShaper は定義域の外をここへ丸める。どんな入力でもこれ以下
    expect(curve[N - 1]!).toBeLessThan(1)
    expect(curve[N - 1]!).toBeGreaterThan(SOFT_CLIP_LIMIT * 0.99)
  })
})
