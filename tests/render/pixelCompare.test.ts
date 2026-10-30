import { describe, expect, it } from 'vitest'
import { byteDifference, tileMeans } from '@render/pixelCompare'

/**
 * 読み戻した絵の比べ方。段 S4b で `marchProbe.test.ts` から移した（体積の雲と一緒に消えるため）
 */

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

  it('下限以下の差は数えない', () => {
    // **SwiftShader は同じ状態を撮り直しても約 1,800 バイトが 1 だけ動く。**
    // 「動いたか」を数える検査は、この雑音を数えると閾値を雑音で越える
    const a = new Uint8Array([0, 10, 20, 30])
    const b = new Uint8Array([1, 11, 22, 99])
    expect(byteDifference(a, b, 1)).toEqual({ differing: 2, max: 69 })
  })

  it('下限は最大の差に効かない', () => {
    const a = new Uint8Array([0, 10])
    const b = new Uint8Array([1, 11])
    expect(byteDifference(a, b, 1)).toEqual({ differing: 0, max: 1 })
  })
})

describe('区画平均', () => {
  it('区画ごとに赤の平均を 0..1 で返す', () => {
    // 2x2 の絵を 2x2 に区切る。左下だけ 255
    const bytes = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
    expect(tileMeans(bytes, 2, 2, 2)).toEqual([1, 0, 0, 0])
  })

  it('長さが足りなければ空を返す', () => {
    // **0 で埋めない。**読み戻せていない絵を「真っ黒」と読む
    expect(tileMeans(new Uint8Array(4), 2, 2)).toEqual([])
  })
})
