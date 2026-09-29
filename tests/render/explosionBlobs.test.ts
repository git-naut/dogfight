import { describe, expect, it } from 'vitest'
import {
  BLOB_DELAY,
  BLOB_SPREAD,
  blobAge,
  blobOffset,
  blobSize,
} from '../../src/render/weapons/explosions'

describe('子の火の玉', () => {
  it('k 番目は BLOB_DELAY × (k + 1) 秒遅れて火が付く', () => {
    expect(blobAge(0, 0)).toBeCloseTo(-BLOB_DELAY)
    expect(blobAge(0.1, 1)).toBeCloseTo(0.1 - 2 * BLOB_DELAY)
  })

  it('火が付く前は中心にいて、押し出しは主の半径の BLOB_SPREAD 倍で止まる', () => {
    expect(blobOffset(10, -0.01)).toBe(0)
    expect(blobOffset(10, 0)).toBe(0)
    expect(blobOffset(10, 0.05)).toBeGreaterThan(0)
    expect(blobOffset(10, 5)).toBeCloseTo(10 * BLOB_SPREAD, 5)
    // 押し出しは単調に増える
    expect(blobOffset(10, 0.2)).toBeGreaterThan(blobOffset(10, 0.1))
  })

  it('大きさの揺らぎは 0.8〜1.2 で、隣どうしで同じにならない', () => {
    const sizes = Array.from({ length: 6 }, (_, k) => blobSize(k))
    for (const s of sizes) {
      expect(s).toBeGreaterThanOrEqual(0.8)
      expect(s).toBeLessThanOrEqual(1.2)
    }
    for (let k = 1; k < sizes.length; k++) expect(sizes[k]).not.toBeCloseTo(sizes[k - 1]!, 2)
  })
})
