import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { parseAc3d, flatten, stats, bounds, toWorld } from '../../tools/ac3d.mjs'
import { F18_HINGES, xmlToAc, xmlToWorld } from '../../tools/f18-hinges.mjs'

/**
 * AC3D パーサの検算。
 *
 * 自分のパーサが出した数値を自分で期待値に置くと、回帰しか防げない。正しさは
 * 外の事実と突き合わせて確かめる。使える外の事実が3つある。
 *
 * ファイル自身が宣言している数（`numvert` と `kids` の合計）。
 * FlightGear のアニメーション XML が持つヒンジの座標。
 * 実機の F/A-18C の寸法。
 */

const SOURCE = fileURLToPath(new URL('../../assets/upstream/f18/f18.ac', import.meta.url))
const source = readFileSync(SOURCE, 'utf8')
const parsed = parseAc3d(source)
const parts = flatten(parsed.root)

/** 原本を素の正規表現で数える。パーサとは別経路で同じ値に着くはず */
function countByRegex(text: string): {
  objects: number
  vertices: number
  triangles: number
  surfaces: number
} {
  const objects = text.match(/^OBJECT /gm)?.length ?? 0
  const vertices =
    text.match(/^numvert (\d+)/gm)?.reduce((s, l) => s + Number(l.split(' ')[1]), 0) ?? 0
  const refs = text.match(/^refs (\d+)/gm) ?? []
  const surfaces = refs.length
  const triangles = refs.reduce((s, l) => s + Math.max(0, Number(l.split(' ')[1]) - 2), 0)
  return { objects, vertices, triangles, surfaces }
}

describe('AC3D のパース', () => {
  it('素の正規表現で数えた値と一致する', () => {
    const expected = countByRegex(source)
    const actual = stats(parsed.root)

    expect(actual.objects).toBe(expected.objects)
    expect(actual.vertices).toBe(expected.vertices)
    expect(actual.triangles).toBe(expected.triangles)
    expect(actual.surfaces).toBe(expected.surfaces)
  })

  it('マテリアルとテクスチャを取れている', () => {
    expect(parsed.materials.length).toBe(17)
    expect(stats(parsed.root).textures).toEqual([
      'f18cockpit.rgb',
      'f18tail.rgb',
      'f18top.rgb',
    ])
  })

  it('未対応のキーワードは例外にする', () => {
    // 黙って無視すると形が崩れたまま気づけない
    const broken = 'AC3Db\nOBJECT poly\nname "x"\nrot 1 0 0 0 1 0 0 0 1\nkids 0\n'
    expect(() => parseAc3d(broken)).toThrow(/rot/)
  })

  it('ヘッダが無ければ例外にする', () => {
    expect(() => parseAc3d('OBJECT poly\nkids 0\n')).toThrow(/ヘッダ/)
  })
})

describe('loc の積み上げ', () => {
  it('親の loc を足さないと寸法が合わない', () => {
    const withLoc = bounds(parts)
    // loc を無視した場合の境界
    const raw = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    const walk = (node: typeof parsed.root): void => {
      for (const v of node.vertices) {
        for (let a = 0; a < 3; a++) {
          raw.min[a] = Math.min(raw.min[a]!, v[a]!)
          raw.max[a] = Math.max(raw.max[a]!, v[a]!)
        }
      }
      for (const kid of node.kids) walk(kid)
    }
    walk(parsed.root)

    // 前後方向は loc を積むと 15.391 から 17.797 へ伸びる。差が出ることを
    // 押さえておかないと、loc を落としたまま通ってしまう
    expect(raw.max[0]! - raw.min[0]!).toBeCloseTo(15.391, 2)
    expect(withLoc.size[0]!).toBeCloseTo(17.797, 2)
  })

  it('実機の F/A-18C の寸法と 5% 以内で一致する', () => {
    const b = bounds(parts)
    // 全長 17.07 m、翼幅 11.43 m（翼端ランチャなし）、全高 4.66 m
    // 前後は .ac の X、翼幅は Z、上下は Y
    const ratio = (measured: number | undefined, real: number): number =>
      (measured ?? 0) / real
    for (const [label, r] of [
      ['全長', ratio(b.size[0], 17.07)],
      ['翼幅', ratio(b.size[2], 11.43)],
      ['全高', ratio(b.size[1], 4.66)],
    ] as const) {
      expect(r, `${label} の比 ${r.toFixed(3)}`).toBeGreaterThan(0.95)
      expect(r, `${label} の比 ${r.toFixed(3)}`).toBeLessThan(1.05)
    }
  })
})

describe('座標変換', () => {
  it('機首が −Z、上が +Y、右が +X になる', () => {
    // .ac は 機首 −X、上 +Y、左 +Z。−0 と 0 を区別しないよう成分で見る
    const near = (a: readonly number[], b: readonly number[]): void => {
      for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 12)
    }
    near(toWorld([-1, 0, 0]), [0, 0, -1]) // 機首
    near(toWorld([0, 1, 0]), [0, 1, 0]) // 上
    near(toWorld([0, 0, -1]), [1, 0, 0]) // 右
  })

  it('行列式が +1 で鏡像にならない', () => {
    const ex = toWorld([1, 0, 0])
    const ey = toWorld([0, 1, 0])
    const ez = toWorld([0, 0, 1])
    const det =
      ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) -
      ex[1] * (ey[0] * ez[2] - ey[2] * ez[0]) +
      ex[2] * (ey[0] * ez[1] - ey[1] * ez[0])
    expect(det).toBeCloseTo(1, 12)
  })
})

describe('舵面のヒンジ', () => {
  const byName = new Map(parts.map((p) => [p.name, p]))

  it('6 枚すべてがモデルに存在する', () => {
    for (const hinge of F18_HINGES) {
      expect(byName.has(hinge.node), `${hinge.node} が無い`).toBe(true)
    }
  })

  it('XML のヒンジが対応する舵面の境界の内側にある', () => {
    // これが座標系の対応の検算。XML は FlightGear が持つ独立した情報なので、
    // パーサ側の思い込みでは一致しない
    for (const hinge of F18_HINGES) {
      const part = byName.get(hinge.node)!
      const b = bounds([part])
      const point = xmlToAc(hinge.from)
      // エレベータのヒンジ中心は機体の中心線上にあり、左右の舵面の外に出る。
      // 回転軸が翼幅方向なので前後と上下だけ見る
      const axes = hinge.node.startsWith('Elevator') ? [0, 1] : [0, 1, 2]
      for (const a of axes) {
        expect(
          point[a],
          `${hinge.node} の軸 ${a}: ${point[a]} が ${b.min[a]}..${b.max[a]} の外`,
        ).toBeGreaterThanOrEqual(b.min[a]! - 0.05)
        expect(point[a]).toBeLessThanOrEqual(b.max[a]! + 0.05)
      }
    }
  })

  it('エルロンのヒンジが翼幅方向に伸びている', () => {
    const left = F18_HINGES.find((h) => h.node === 'AileronLeft')!
    const from = xmlToWorld(left.from)
    const to = xmlToWorld(left.to)
    // 当方の系で X が翼幅方向。左は −X 側
    expect(Math.abs(to[0] - from[0])).toBeGreaterThan(1)
    expect(from[0]).toBeLessThan(0)
    expect(Math.abs(to[1] - from[1])).toBeLessThan(1e-6)
    expect(Math.abs(to[2] - from[2])).toBeLessThan(1e-6)
  })

  it('舵角が XML の factor と一致する', () => {
    const byNode = new Map(F18_HINGES.map((h) => [h.node, h.maxDeg]))
    expect(byNode.get('AileronLeft')).toBe(30)
    expect(byNode.get('RudderLeft')).toBe(30)
    expect(byNode.get('ElevatorLeft')).toBe(25)
  })
})
