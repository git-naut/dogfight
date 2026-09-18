import { describe, it, expect } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { identifyParts, SPEC, SCALE } from '../../tools/f18e-parts.mjs'

/**
 * F/A-18E の部品の同定。
 *
 * **名前で拾えないモデルを幾何で当てている。**Sketchfab が FBX から変換した
 * glTF なので、ノード名は `Meshpart126_Material.001_0` のような自動生成名。
 * 意味のある名前は `Canopy1` と `Tailhook1/2` の 3 つだけで、舵面は 1 つも
 * 名前を持たない。
 *
 * 位置と寸法で当てているので、**閾値が隣の部品を巻き込んでいないか**を
 * ここで固定する。1 つの舵面に 2 つ当たったら、それは閾値が広すぎる。
 *
 * モデルは `assets/upstream/f18e/` に原本を置いてある（CC BY 4.0、
 * `assets/CREDITS.md`）。差し替えない限りこの数は動かない。
 */

const GLTF = fileURLToPath(new URL('../../assets/upstream/f18e/scene.gltf', import.meta.url))
const result = identifyParts(GLTF)

describe('F/A-18E の glTF', () => {
  it('部品と三角形の総数が変わらない', () => {
    expect(result.parts.length).toBe(220)
    expect(result.parts.reduce((s, p) => s + p.triangles, 0)).toBe(77_840)
  })

  it('寸法が公称と一致する', () => {
    // 全長は倍率を出すのに使ったので必ず合う。**翼幅と全高が独立に合うことで
    // 倍率そのものが正しいと言える**（片方だけなら偶然もありうる）
    expect(result.size[0]).toBeCloseTo(SPEC.length, 2)

    const span = result.size[2]
    const height = result.size[1]
    expect(Math.abs(span / SPEC.span - 1), `翼幅 ${span.toFixed(2)} m`).toBeLessThan(0.05)
    expect(Math.abs(height / SPEC.height - 1), `全高 ${height.toFixed(2)} m`).toBeLessThan(0.05)
  })

  it('倍率は実測から導いた値のまま', () => {
    // 5 単位 = 1 m に近い。モデルを差し替えたら測り直す
    expect(SCALE).toBeCloseTo(0.2005, 4)
  })
})

describe('舵面の同定', () => {
  const byName = new Map<string, typeof result.matched>()
  for (const m of result.matched) {
    const list = byName.get(m.name) ?? []
    list.push(m)
    byName.set(m.name, list)
  }

  const expected = [
    ['AileronLeft', 'Main2', 237],
    ['AileronRight', 'Main3', 238],
    ['FlapLeft', 'Meshpart164', 52],
    ['FlapRight', 'Meshpart156', 52],
    ['StabilatorLeft', 'Meshpart176', 76],
    ['StabilatorRight', 'Meshpart126', 76],
    // **左右で作りが違う。**左は 2 プリミティブ（94 + 49）、右は 1 つで 143。
    // 親ノードでまとめるので、どちらも 143 三角形になる
    ['RudderLeft', 'Meshpart125', 143],
    ['RudderRight', 'Meshpart174', 143],
  ] as const

  it.each(expected)('%s は %s の 1 ノードに当たる', (name, node, triangles) => {
    const hits = byName.get(name) ?? []
    // **1 つだけ当たること。**2 つ当たったら閾値が隣を巻き込んでいる
    expect(hits.length, `${name} に ${hits.length} 件当たった`).toBe(1)
    expect(hits[0]!.node).toBe(node)
    expect(hits[0]!.triangles).toBe(triangles)
  })

  it('8 面すべてが揃う', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'AileronLeft',
        'AileronRight',
        'FlapLeft',
        'FlapRight',
        'RudderLeft',
        'RudderRight',
        'StabilatorLeft',
        'StabilatorRight',
      ].sort(),
    )
  })

  it('左右の舵面が鏡像の位置にある', () => {
    for (const role of ['aileron', 'flap', 'stabilator', 'rudder']) {
      const left = result.matched.find((m) => m.role === role && m.side === 'left')
      const right = result.matched.find((m) => m.role === role && m.side === 'right')
      expect(left, `${role} の左が無い`).toBeDefined()
      expect(right, `${role} の右が無い`).toBeDefined()
      // 翼幅方向が反転していること
      expect(left!.part.z * right!.part.z, `${role} が同じ側にある`).toBeLessThan(0)
      // 前後と上下はほぼ同じ
      expect(Math.abs(left!.part.x - right!.part.x)).toBeLessThan(0.3)
      expect(Math.abs(left!.part.y - right!.part.y)).toBeLessThan(0.3)
    }
  })

  it('舵面が機体の正しい場所にある', () => {
    const at = (name: string) => result.matched.find((m) => m.name === name)!.part
    // エルロンはフラップより外側
    expect(at('AileronLeft').absZ).toBeGreaterThan(at('FlapLeft').absZ)
    // スタビレータはエルロンより後ろ（機首が −X）
    expect(at('StabilatorLeft').x).toBeGreaterThan(at('AileronLeft').x)
    // 垂直尾翼はいちばん高い
    expect(at('RudderLeft').y).toBeGreaterThan(at('StabilatorLeft').y)
    expect(at('RudderLeft').y).toBeGreaterThan(at('AileronLeft').y)
  })
})

describe('降着装置', () => {
  it('13 件が機体の下にある', () => {
    expect(result.gear.length).toBe(13)
    expect(result.gear.reduce((s, p) => s + p.triangles, 0)).toBe(7_829)
    for (const p of result.gear) expect(p.y).toBeLessThan(-0.6)
  })

  it('舵面と重ならない', () => {
    // **同じ部品が舵面と脚の両方に当たってはいけない。**当たると
    // `gear` を隠したときに舵が消える
    const gearNames = new Set(result.gear.map((p) => p.name))
    for (const m of result.matched) {
      for (const prim of m.primitives) {
        expect(gearNames.has(prim.name), `${m.name} が脚にも当たっている`).toBe(false)
      }
    }
  })
})

describe('左右対称のペア', () => {
  it('43 組ある', () => {
    // 舵面がすべて左右にあることの裏付け。減ったら同定の前提が崩れている
    expect(result.pairs.length).toBe(43)
  })
})
