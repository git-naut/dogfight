import { describe, it, expect } from 'vitest'
import { Rng } from '@sim/rng'

describe('Rng', () => {
  it('同じシードからは同じ列が出る', () => {
    const a = new Rng(12345)
    const b = new Rng(12345)
    const seqA = Array.from({ length: 100 }, () => a.next())
    const seqB = Array.from({ length: 100 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('違うシードからは違う列が出る', () => {
    const a = new Rng(1)
    const b = new Rng(2)
    const seqA = Array.from({ length: 50 }, () => a.next())
    const seqB = Array.from({ length: 50 }, () => b.next())
    expect(seqA).not.toEqual(seqB)
  })

  it('next() は [0, 1) に収まる', () => {
    const rng = new Rng(7)
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('分布に偏りがない（10分割の各バケツが期待値の 1 割以内）', () => {
    const rng = new Rng(99)
    const buckets = new Array(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i++) {
      buckets[Math.floor(rng.next() * 10)]!++
    }
    const expected = n / 10
    for (const count of buckets) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.1)
    }
  })

  it('負のシードでも壊れない', () => {
    const rng = new Rng(-1)
    for (let i = 0; i < 100; i++) {
      const v = rng.next()
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('range() と int() が指定範囲に収まる', () => {
    const rng = new Rng(31)
    for (let i = 0; i < 5_000; i++) {
      const r = rng.range(-3, 7)
      expect(r).toBeGreaterThanOrEqual(-3)
      expect(r).toBeLessThan(7)

      const n = rng.int(2, 5)
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(5)
    }
  })

  it('clone() は以降の列を共有せず、その時点から同じ列を出す', () => {
    const original = new Rng(555)
    original.next()
    original.next()

    const copy = original.clone()
    const fromOriginal = Array.from({ length: 20 }, () => original.next())
    const fromCopy = Array.from({ length: 20 }, () => copy.next())

    expect(fromCopy).toEqual(fromOriginal)
  })
})
