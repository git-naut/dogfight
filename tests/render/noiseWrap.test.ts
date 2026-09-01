import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * 格子座標の巻き方が GLSL と TSL で同値であることを縛る。
 *
 * GLSL は `((cell % period) + period) % period` と書いている。TSL 側は
 * `cell & (period - 1)` に置き換えた。**周波数がすべて 2 のべき乗だから
 * 成り立つ置き換え**で、そうでない周期が混ざった瞬間に嘘になる。
 *
 * 整数の `%` が TSL でどう出るかを当てにせずに済むのが置き換えの理由。
 * 代わりに、前提（2 のべき乗であること）をここで機械的に守る。
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** GLSL 側の書き方 */
function wrapModulo(cell: number, period: number): number {
  return ((cell % period) + period) % period
}

/** TSL 側の書き方 */
function wrapBitAnd(cell: number, period: number): number {
  return cell & (period - 1)
}

/** 実際に使われる周波数。シェーダの本文から読む */
function usedFrequencies(): number[] {
  const source = readFileSync(`${ROOT}src/render/clouds/noiseNodes.ts`, 'utf8')
  const found = new Set<number>()
  for (const m of source.matchAll(/(?:worley|perlin)\(p, (?:Math\.min\()?(\d+)/g)) {
    found.add(Number(m[1]))
  }
  // fbm が内側で 2 倍と 4 倍にする
  for (const base of [...found]) {
    found.add(base * 2)
    found.add(base * 4)
  }
  return [...found].sort((a, b) => a - b)
}

describe('格子座標の巻き方', () => {
  const frequencies = usedFrequencies()

  it('シェーダが使う周波数を拾えている', () => {
    // 拾えていないと、以下の検査が空回りする
    expect(frequencies.length).toBeGreaterThanOrEqual(4)
    expect(frequencies).toContain(4)
    expect(frequencies).toContain(16)
  })

  it('周波数がすべて 2 のべき乗', () => {
    for (const freq of frequencies) {
      expect(Number.isInteger(Math.log2(freq)), `freq=${freq}`).toBe(true)
    }
  })

  it('2 つの書き方が実際に通る範囲で一致する', () => {
    for (const period of frequencies) {
      // `id` は floor(p * freq) で 0..period-1、そこへ -1..+1 の近傍が付く。
      // 余裕を見て両側へ広げる
      for (let cell = -4; cell <= period + 4; cell++) {
        expect(wrapBitAnd(cell, period), `period=${period} cell=${cell}`).toBe(
          wrapModulo(cell, period),
        )
      }
    }
  })

  it('2 のべき乗でない周期では一致しないことを確かめる', () => {
    // 置き換えが「2 のべき乗だから成り立つ」ことを、崩れる例で見る。
    // **最初に置いた -1 は偶然一致していた**（どちらも 2）ので、
    // 周期を跨ぐ側で取る
    expect(wrapBitAnd(3, 3), '3 & 2 = 2').toBe(2)
    expect(wrapModulo(3, 3), '((3 %% 3) + 3) %% 3 = 0').toBe(0)
  })
})
