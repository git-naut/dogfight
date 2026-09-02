import { describe, expect, it } from 'vitest'
import { unpadRows } from '../../src/render/pipeline/readback'

/**
 * 読み戻しの並べ直し。
 *
 * この関数が黙って間違うと、TSL 版と GLSL 版の突き合わせが「算術がずれた」
 * という誤った読みになる。実際に段 11 でそう読み違えかけた。
 */

/** 幅 width・高さ height の画像を、行の間隔 stride バイトで詰めた生データ */
function packed(width: number, height: number, stride: number): Uint8Array {
  const rowBytes = width * 4
  // 最後の行だけ揃えない。WebGPU の実測がその形だった
  const total = (height - 1) * stride + rowBytes
  const out = new Uint8Array(total)
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < rowBytes; i++) out[y * stride + i] = y * 16 + (i % 16)
  }
  return out
}

describe('unpadRows', () => {
  it('詰まっていればそのまま返す', () => {
    const data = packed(2, 2, 8)
    expect(unpadRows(data, 2, 2, false)).toEqual([...data])
  })

  it('256 バイト境界へ揃えられた行から詰め物を外す', () => {
    // WebGPU で 16x16 を読んだときの実測。15 行 x 256 + 64 = 3,904
    const data = packed(16, 16, 256)
    expect(data.length).toBe(3904)
    const out = unpadRows(data, 16, 16, false)
    expect(out.length).toBe(16 * 16 * 4)
    // 先頭の行と最後の行が、詰め物を跨がずに取れている
    expect(out.slice(0, 4)).toEqual([0, 1, 2, 3])
    expect(out.slice(15 * 64, 15 * 64 + 4)).toEqual([240, 241, 242, 243])
  })

  it('flipRows で行の向きを反転する', () => {
    const data = packed(2, 2, 8)
    const straight = unpadRows(data, 2, 2, false)
    const flipped = unpadRows(data, 2, 2, true)
    expect(flipped.slice(0, 8)).toEqual(straight.slice(8, 16))
    expect(flipped.slice(8, 16)).toEqual(straight.slice(0, 8))
  })

  it('反転を 2 回かけると元へ戻る', () => {
    const data = packed(4, 4, 256)
    const once = unpadRows(data, 4, 4, true)
    // 一度詰め直したものは stride = rowBytes なので、そのまま入れ直せる
    expect(unpadRows(Uint8Array.from(once), 4, 4, true)).toEqual(
      unpadRows(data, 4, 4, false),
    )
  })

  it('高さ 1 なら間隔を割り出さずに全部を 1 行として返す', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(unpadRows(data, 2, 1, false)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('行の間隔が割り切れなければ黙って返さずに落ちる', () => {
    // **0 を返してはいけない。**読めない読み戻しを「一致しなかった」と
    // 読み違えると、原因が算術のずれに見える。
    // 幅 4 の 4 行なら (101 - 16) / 3 = 28.33 で割り切れない
    expect(() => unpadRows(new Uint8Array(101), 4, 4, false)).toThrow(
      /行の間隔が読めない/,
    )
  })

  it('行の間隔が幅より狭ければ落ちる', () => {
    // (40 - 16) / 3 = 8 は整数だが、1 行の 16 バイトに足りない
    expect(() => unpadRows(new Uint8Array(40), 4, 4, false)).toThrow(
      /行の間隔が読めない/,
    )
  })
})
