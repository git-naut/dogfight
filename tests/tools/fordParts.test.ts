import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { readGltfParts } from '../../tools/gltf-parts.mjs'
import {
  DECK_HEIGHT,
  LENGTH_OVERALL,
  SCALE,
  SOURCE_DECK_TOP,
  toWorld,
  worldMatrix,
  type Vec3,
} from '../../tools/ford-parts.mjs'

/**
 * 空母 Gerald R. Ford の原本と、この作品の座標への変換（Phase 9 の段 2）。
 *
 * 原本は `assets/upstream/ford/`（Sketchfab の waelXcm 版、CC BY 4.0）。変換は
 * `tools/ford-parts.mjs` の 1 か所の値（原点・180 度の回転・倍率）で、`tools/ford-to-glb.mjs`
 * はシーンの頂上に行列を 1 つ掛けるだけ。**期待値は定数から作らず、実物の値と原本で測った値で書く**
 */
const GLTF = fileURLToPath(new URL('../../assets/upstream/ford/scene.gltf', import.meta.url))
const result = readGltfParts(GLTF)
const part = (pattern: RegExp) => {
  const found = result.parts.filter((p) => pattern.test(p.name))
  expect(found.length, `${pattern} に当たる部品`).toBeGreaterThan(0)
  return found
}

describe('空母 Ford の原本', () => {
  it('部品・三角形・材質・テクスチャの数が変わらない', () => {
    const gltf = JSON.parse(readFileSync(GLTF, 'utf8'))
    expect(result.parts.length).toBe(158)
    expect(result.parts.reduce((s, p) => s + p.triangles, 0)).toBe(116_316)
    expect(gltf.materials.length).toBe(11)
    expect(gltf.images.length).toBe(30)
    // リグ・アニメーションは無い（Sketchfab の説明の「rigged」は部品の階層のこと）
    expect(gltf.skins ?? []).toHaveLength(0)
    expect(gltf.animations ?? []).toHaveLength(0)
  })

  it('ライセンスの原文が CC BY 4.0・作者 waelXcm', () => {
    const license = readFileSync(fileURLToPath(new URL('../../assets/upstream/ford/license.txt', import.meta.url)), 'utf8')
    expect(license).toContain('CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)')
    expect(license).toContain('waelXcm (https://sketchfab.com/waelXcm)')
    expect(license).toContain('562bf516e1494df38d8f222504dc798b')
  })
})

describe('この作品の座標への変換', () => {
  const corners = (p: { min: readonly number[]; max: readonly number[] }): [Vec3, Vec3] => [toWorld(p.min), toWorld(p.max)]

  it('全長が実物の 337 m になる', () => {
    const [a, b] = corners(result)
    expect(Math.abs(a[2] - b[2])).toBeCloseTo(337, 6)
    expect(LENGTH_OVERALL).toBe(337)
  })

  it('艦首が −Z、艦尾（スクリュー）が +Z を向く', () => {
    for (const screw of part(/turbine/)) expect(toWorld(screw.center)[2], screw.name).toBeGreaterThan(120)
    // 艦首の甲板の縁は −Z 側に 160 m 以上
    const deck = part(/^ship_deck_ship_0$/)[0]!
    const [a, b] = corners(deck)
    expect(Math.min(a[2], b[2])).toBeLessThan(-160)
  })

  it('艦橋が右舷（+X）に来る。実物の Ford と同じ', () => {
    // 鏡映ではなく回転で向けているので、左右が入れ替わっていないことをここで固定する
    const bridge = part(/^ship_bridge_ship_bridge1_0$/)[0]!
    expect(toWorld(bridge.center)[0]).toBeGreaterThan(25)
  })

  it('甲板は水面から 18.87 m（喫水 12 m）、艦底は水面の下 12 m', () => {
    // (1.21390 − 0.10659) × 27.876 − 12 = 18.87
    expect(DECK_HEIGHT).toBeCloseTo(18.87, 2)
    expect(toWorld([0, SOURCE_DECK_TOP, 0])[1]).toBeCloseTo(18.87, 2)
    const keel = part(/^ship_fins/)[0]!
    expect(toWorld(keel.min)[1]).toBeCloseTo(-12, 6)
  })

  it('飛行甲板の長さと幅（実物は 333 m・約 78 m）', () => {
    const deck = part(/^ship_deck_ship_0$/)[0]!
    const length = deck.extent[2] * SCALE
    const width = deck.extent[0] * SCALE
    expect(length).toBeGreaterThan(330)
    expect(length).toBeLessThan(340)
    // モデルは実物より 7% 広い（83.8 m）。形の誤差として受け入れた（ford-parts.mjs）
    expect(width).toBeGreaterThan(80)
    expect(width).toBeLessThan(86)
  })

  it('glb の頂上に掛ける行列が toWorld と同じ変換', () => {
    const m = worldMatrix()
    for (const p of [result.min, result.max, [0.3, 1.2, -4.1]]) {
      const byMatrix = [0, 1, 2].map((r) => m[r]![0]! * p[0]! + m[r]![1]! * p[1]! + m[r]![2]! * p[2]! + m[r]![3]!)
      const byFunction = toWorld(p)
      for (let k = 0; k < 3; k++) expect(byMatrix[k]).toBeCloseTo(byFunction[k]!, 9)
    }
    // 回転は鏡映を含まない（行列式が正）
    const det =
      m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
      m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
      m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
    expect(det).toBeGreaterThan(0)
  })
})
