import { describe, it, expect } from 'vitest'
import { TrailRing } from '@sim/trail'

/**
 * 履歴のリング。
 *
 * 添字の演算が微妙なので、機体を通した検証（tests/sim/trail.test.ts）とは別に
 * ここで境界を固定する。`written - 1 - index` は最小で -capacity になるので、
 * 剰余の前に容量の 2 倍を足している。その桁が合っているかを直接見る。
 */

interface Slot {
  value: number
}

function ring(capacity: number): TrailRing<Slot> {
  return new TrailRing<Slot>(capacity, () => ({ value: -1 }))
}

/** value に 0,1,2,... を順に詰める */
function fill(r: TrailRing<Slot>, count: number): void {
  for (let i = 0; i < count; i++) r.push().value = i
}

/** 新しい順に読み出した value の列 */
function readAll(r: TrailRing<Slot>): number[] {
  return Array.from({ length: r.length }, (_, i) => r.at(i).value)
}

describe('TrailRing', () => {
  it('作った直後は空', () => {
    expect(ring(8).length).toBe(0)
  })

  it('容量を先に確保する。push で器を作らない', () => {
    const r = ring(4)
    const first = r.push()
    // 1 周したら同じ器が戻る。毎回作っていれば別物になる
    fill(r, 3)
    expect(r.push()).toBe(first)
  })

  it('push した数だけ増え、容量で頭打ちになる', () => {
    const r = ring(4)
    fill(r, 3)
    expect(r.length).toBe(3)
    fill(r, 10)
    expect(r.length).toBe(4)
  })

  it('0 が最新で、後ろへ行くほど古い', () => {
    const r = ring(8)
    fill(r, 5)
    expect(readAll(r)).toEqual([4, 3, 2, 1, 0])
  })

  it('容量を超えたら古いほうから落ちる', () => {
    const r = ring(4)
    fill(r, 6)
    expect(readAll(r)).toEqual([5, 4, 3, 2])
  })

  it('リングを何周しても順番が崩れない', () => {
    const r = ring(7)
    fill(r, 7 * 5 + 3)
    const expected = [37, 36, 35, 34, 33, 32, 31]
    expect(readAll(r)).toEqual(expected)
  })

  it('容量 1 でも壊れない', () => {
    const r = ring(1)
    fill(r, 3)
    expect(r.length).toBe(1)
    expect(r.at(0).value).toBe(2)
  })

  it('範囲外は端へ丸める', () => {
    const r = ring(8)
    fill(r, 5)
    expect(r.at(-3).value).toBe(4)
    expect(r.at(4).value).toBe(0)
    expect(r.at(99).value).toBe(0)
  })

  it('空でも at が投げない。初期状態の器が返る', () => {
    const r = ring(8)
    expect(() => r.at(0)).not.toThrow()
    expect(r.at(0).value).toBe(-1)
  })

  it('at は写しではなく内部の器を返す', () => {
    const r = ring(4)
    fill(r, 2)
    r.at(0).value = 99
    expect(r.at(0).value).toBe(99)
  })

  it('capacity を外から読める', () => {
    expect(ring(768).capacity).toBe(768)
  })
})
