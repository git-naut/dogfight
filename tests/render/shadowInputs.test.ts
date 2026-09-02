import { describe, expect, it } from 'vitest'
import {
  decodeShadowInputs,
  encodeShadowInputs,
  SHADOW_INPUT_COUNT,
  type ShadowInputs,
} from '../../src/render/clouds/shadowInputs'

/**
 * 雲影の入力の受け渡し。
 *
 * ここが黙って壊れると、GLSL 版と TSL 版が別の入力で焼いたものを比べる。
 * 一致しなかったときに移植の欠陥に見えるので、往復を単体で縛る。
 */
const SAMPLE: ShadowInputs = {
  cloudTime: 1.5,
  coverage: 0.29,
  sunX: -0.3007,
  sunY: 0.8123,
  sunZ: 0.5001,
  centerX: 1234.5,
  centerZ: -678.25,
}

describe('雲影の入力', () => {
  it('往復して同じ値に戻る', () => {
    expect(decodeShadowInputs(encodeShadowInputs(SAMPLE))).toEqual(SAMPLE)
  })

  it('並びは 7 個', () => {
    expect(SHADOW_INPUT_COUNT).toBe(7)
    expect(encodeShadowInputs(SAMPLE).split(',')).toHaveLength(7)
  })

  it('数が足りなければ null を返す', () => {
    // **0 で埋めない。**太陽の Y が 0 だと影マップが真っ白になり、
    // ヒストグラムの比較はそれでも通ってしまう
    expect(decodeShadowInputs('1,2,3')).toBeNull()
    expect(decodeShadowInputs('1,2,3,4,5,6,7,8')).toBeNull()
  })

  it('数でないものが混ざれば null を返す', () => {
    expect(decodeShadowInputs('0,0.3,0,1,0,0,x')).toBeNull()
    expect(decodeShadowInputs('0,0.3,0,1,0,0,')).toBeNull()
  })

  it('空と未指定は null', () => {
    expect(decodeShadowInputs(null)).toBeNull()
    expect(decodeShadowInputs('')).toBeNull()
  })

  it('負とゼロを落とさない', () => {
    const zero: ShadowInputs = {
      cloudTime: 0,
      coverage: 0,
      sunX: 0,
      sunY: -1,
      sunZ: 0,
      centerX: 0,
      centerZ: 0,
    }
    expect(decodeShadowInputs(encodeShadowInputs(zero))).toEqual(zero)
  })
})
