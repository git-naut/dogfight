import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { parseAc3d, flatten } from '../../tools/ac3d.mjs'
import { CATAPULTS, deckToWorld, catapultLaunch } from '@sim/carrierDeck'
import { LAUNCH_DISTANCE } from '@sim/launch'

/**
 * 甲板の座標。
 *
 * **主題は原本との突き合わせ。**`carrierDeck.ts` は原本から手で写した
 * 定数を持つ。写し間違いを捕まえないと、射出の軌跡だけがカタパルトの帯から
 * ずれる。絵を見ても気づきにくい。
 */

/**
 * 原本から `cat-*` の 2 点を読む。
 *
 * **自前で `.ac` を舐めない。**`loc` の合成（親の位置を足す）を書き直すと
 * そこがずれる。既存の `parseAc3d` と `flatten` が済ませている
 */
function readCatapults(): Map<string, number[][]> {
  const { root } = parseAc3d(
    readFileSync(
      fileURLToPath(new URL('../../assets/upstream/nimitz/nimitz.ac', import.meta.url)),
      'latin1',
    ),
  )
  const out = new Map<string, number[][]>()
  for (const part of flatten(root)) {
    if (/^cat-\d$/.test(part.name)) out.set(part.name, part.vertices)
  }
  return out
}

const original = readCatapults()

describe('カタパルトの座標', () => {
  it('原本から 4 基が読める', () => {
    expect(original.size).toBe(4)
  })

  /**
   * **写した値が原本と一致する。**ずれると射出の軌跡だけが帯から外れる。
   * 絵を見ても気づきにくい種類の間違い
   */
  it('写した値が原本と一致する', () => {
    for (const [name, line] of Object.entries(CATAPULTS)) {
      const verts = original.get(name)
      expect(verts, `${name} が原本に無い`).toBeDefined()
      expect(verts!.length).toBe(2)

      // 原本の 2 点は順序が一定でない。+X 側が start
      const sorted = [...verts!].sort((a, b) => b[0]! - a[0]!)
      const [plusX, minusX] = sorted as [number[], number[]]
      for (let i = 0; i < 3; i++) {
        expect(line.start[i], `${name} の start[${i}]`).toBeCloseTo(plusX[i]!, 2)
        expect(line.end[i], `${name} の end[${i}]`).toBeCloseTo(minusX[i]!, 2)
      }
    }
  })

  /** 4 基とも甲板の高さに乗っている */
  it('甲板の高さが 20 m', () => {
    for (const line of Object.values(CATAPULTS)) {
      expect(line.start[1]).toBe(20)
      expect(line.end[1]).toBe(20)
    }
  })
})

describe('座標の変換', () => {
  /** `.ac` は 艦首 −X・上 +Y・左 +Z、当方は 艦首 −Z・上 +Y・右 +X */
  it('艦首方向が −Z へ移る', () => {
    // 艦首側（−X）の点は当方の −Z へ
    const bow = deckToWorld([-100, 20, 0])
    expect(bow.z).toBeCloseTo(-100, 3)
    expect(bow.y).toBe(20)
  })

  it('左舷が −X へ移る', () => {
    // `.ac` の +Z は左舷。当方は右が +X なので左は −X
    const port = deckToWorld([0, 20, 30])
    expect(port.x).toBeCloseTo(-30, 3)
  })
})

describe('射出の諸元', () => {
  const AT_ORIGIN = { x: 0, z: 0, heading: 0 }

  it('知らない名前は例外', () => {
    expect(() => catapultLaunch(AT_ORIGIN, 'cat-9', LAUNCH_DISTANCE)).toThrow()
  })

  it('向きが単位ベクトル', () => {
    for (const name of Object.keys(CATAPULTS)) {
      const spec = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE)
      expect(spec.direction.length(), `${name}`).toBeCloseTo(1, 5)
      // 水平
      expect(spec.direction.y).toBe(0)
    }
  })

  /** 艦首が −Z なので、射出も −Z 側へ向かう */
  it('射出が艦首側を向く', () => {
    for (const name of Object.keys(CATAPULTS)) {
      const spec = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE)
      expect(spec.direction.z, `${name} が艦首を向いていない`).toBeLessThan(-0.9)
    }
  })

  it('開始位置が甲板の高さ', () => {
    const spec = catapultLaunch(AT_ORIGIN, 'cat-1', LAUNCH_DISTANCE)
    expect(spec.from.y).toBe(20)
  })

  /**
   * **開始位置は帯の内側。**終点から行程ぶん手前に取るので、帯（115 m）
   * より短い行程（94 m）なら必ず内側に入る
   */
  it('開始位置が帯の内側にある', () => {
    for (const name of Object.keys(CATAPULTS)) {
      const line = CATAPULTS[name]!
      const start = deckToWorld(line.start)
      const end = deckToWorld(line.end)
      const spec = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE)
      const bandLength = Math.hypot(end.x - start.x, end.z - start.z)
      const fromEnd = Math.hypot(spec.from.x - end.x, spec.from.z - end.z)
      expect(fromEnd, `${name}`).toBeCloseTo(LAUNCH_DISTANCE, 3)
      expect(fromEnd, `${name} が帯からはみ出している`).toBeLessThan(bandLength)
    }
  })

  /** 空母を動かすと射出位置も動く */
  it('空母の位置が反映される', () => {
    const a = catapultLaunch({ x: 0, z: 0, heading: 0 }, 'cat-1', LAUNCH_DISTANCE)
    const b = catapultLaunch({ x: 500, z: -300, heading: 0 }, 'cat-1', LAUNCH_DISTANCE)
    expect(b.from.x - a.from.x).toBeCloseTo(500, 3)
    expect(b.from.z - a.from.z).toBeCloseTo(-300, 3)
    // 向きは変わらない
    expect(b.direction.x).toBeCloseTo(a.direction.x, 6)
  })

  /** 艦首を回すと射出方向も回る */
  it('艦首の向きが反映される', () => {
    const straight = catapultLaunch({ x: 0, z: 0, heading: 0 }, 'cat-1', LAUNCH_DISTANCE)
    const turned = catapultLaunch(
      { x: 0, z: 0, heading: Math.PI / 2 },
      'cat-1',
      LAUNCH_DISTANCE,
    )
    // 90 度回すと −Z 向きが −X 向きになる
    expect(straight.direction.z).toBeLessThan(-0.9)
    expect(turned.direction.x).toBeLessThan(-0.9)
    expect(Math.abs(turned.direction.z)).toBeLessThan(0.2)
  })
})
