import { describe, it, expect } from 'vitest'
import {
  pcg3d,
  hash33,
  hashTopByte,
  hashProbeExpected,
  HASH_CELL_OFFSET,
  HASH_PROBE_SIDE,
  PCG_INCREMENT,
  PCG_MULTIPLIER,
} from '@render/hashReference'

/**
 * CPU 参照の算術を、別の書き方で確かめる。
 *
 * **自分の出力を凍らせても検査にならない。**`Math.imul` と `>>> 0` で
 * 32 ビットに巻く書き方が正しいかを、BigInt で素直に書いた実装と突き合わせる。
 * 遅いが 1 度しか書かないので、こちらを物差しにできる。
 *
 * GPU との突き合わせは `tests/e2e/node-path.spec.ts` が行う。ここは
 * 「CPU 側が PCG を正しく計算しているか」だけを見る。
 */
const M = 0xffffffffn

function pcg3dBig(x: number, y: number, z: number): [bigint, bigint, bigint] {
  const mul = BigInt(PCG_MULTIPLIER)
  const inc = BigInt(PCG_INCREMENT)
  let vx = ((BigInt(x >>> 0) * mul + inc) & M)
  let vy = ((BigInt(y >>> 0) * mul + inc) & M)
  let vz = ((BigInt(z >>> 0) * mul + inc) & M)

  vx = (vx + ((vy * vz) & M)) & M
  vy = (vy + ((vz * vx) & M)) & M
  vz = (vz + ((vx * vy) & M)) & M

  vx = vx ^ (vx >> 16n)
  vy = vy ^ (vy >> 16n)
  vz = vz ^ (vz >> 16n)

  vx = (vx + ((vy * vz) & M)) & M
  vy = (vy + ((vz * vx) & M)) & M
  vz = (vz + ((vx * vy) & M)) & M
  return [vx, vy, vz]
}

describe('雲ノイズのハッシュ（CPU 参照）', () => {
  it('BigInt で書いた実装と一致する', () => {
    const out = new Uint32Array(3)
    // 格子は wrapCell で 0..period-1 に丸められてから 4096 が足される。
    // その範囲と、巻きを跨ぐ大きな値の両方を通す
    const inputs: Array<[number, number, number]> = []
    for (let i = 0; i < 64; i++) {
      inputs.push([i + HASH_CELL_OFFSET, (i * 7) % 64 + HASH_CELL_OFFSET, 4096])
    }
    inputs.push([0, 0, 0], [1, 2, 3], [0xffffffff, 0xfffffffe, 0x80000000])
    inputs.push([0x7fffffff, 0x12345678, 0xdeadbeef])

    for (const [x, y, z] of inputs) {
      pcg3d(x, y, z, out)
      const [bx, by, bz] = pcg3dBig(x, y, z)
      expect(BigInt(out[0]!), `x=${x} y=${y} z=${z} の 1 成分目`).toBe(bx)
      expect(BigInt(out[1]!), `x=${x} y=${y} z=${z} の 2 成分目`).toBe(by)
      expect(BigInt(out[2]!), `x=${x} y=${y} z=${z} の 3 成分目`).toBe(bz)
    }
  })

  it('検査そのものが働くことを、1 ビット変えて確かめる', () => {
    const a = pcg3d(4096, 4096, 4096, new Uint32Array(3))
    const b = pcg3d(4097, 4096, 4096, new Uint32Array(3))
    expect([...a]).not.toEqual([...b])
  })

  it('hash33 が 0 以上 1 未満に収まる', () => {
    for (let i = 0; i < 256; i++) {
      const h = hash33(i % 16, ((i / 16) | 0) % 16, i % 7)
      for (const v of h) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    }
  })

  it('上位 8 ビットが hash33 の上位と揃う', () => {
    // GPU は RGBA8 へ焼くので上位 8 ビットしか戻せない。同じものを見ている
    // ことを確かめる
    for (let i = 0; i < 64; i++) {
      const top = hashTopByte(i, i * 3, 0)
      const h = hash33(i, i * 3, 0)
      for (let c = 0; c < 3; c++) {
        expect(top[c]).toBe(Math.floor(h[c]! * 256))
      }
    }
  })

  it('検査用の格子が 16x16 で 3 成分ぶん並ぶ', () => {
    const probe = hashProbeExpected()
    expect(probe.length).toBe(HASH_PROBE_SIDE * HASH_PROBE_SIDE * 3)
    // 端の 2 つが偶然一致していない（全部同じ値なら検査にならない）
    expect(probe.slice(0, 3)).not.toEqual(probe.slice(-3))
  })
})
