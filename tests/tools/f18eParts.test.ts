import { describe, it, expect } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { identifyParts, SPEC, SCALE } from '../../tools/f18e-parts.mjs'

/**
 * F/A-18E の部品の同定。
 *
 * **名前でほとんど拾えないモデルを幾何で当てている。**Sketchfab が FBX から
 * 変換した glTF なので、ノード名は `Meshpart126_Material.001_0` のような
 * 自動生成名。舵面で名前が残っているのは左のエルロン `La1` だけ。
 *
 * 位置と寸法で当てているので、**閾値が隣の部品を巻き込んでいないか**を
 * ここで固定する。1 つの舵面に 2 つ当たったら、それは閾値が広すぎる。
 * **隣を拾っても bbox の検査は通る**（外翼パネルを 1 度そうやって拾った）
 * ので、大きさそのものにも条件を置く。
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
    // `La1` は原本に残った名前（Left aileron）。左右を決めた根拠でもある
    ['AileronLeft', 'La1', 68],
    ['AileronRight', 'Meshpart175', 68],
    ['StabilatorLeft', 'Meshpart126', 76],
    ['StabilatorRight', 'Meshpart176', 76],
    // **左右で作りが違う。**右は 2 プリミティブ（94 + 49）、左は 1 つで 143。
    // 親ノードでまとめるので、どちらも 143 三角形になる
    ['RudderLeft', 'Meshpart174', 143],
    ['RudderRight', 'Meshpart125', 143],
  ] as const

  it.each(expected)('%s は %s の 1 ノードに当たる', (name, node, triangles) => {
    const hits = byName.get(name) ?? []
    // **1 つだけ当たること。**2 つ当たったら閾値が隣を巻き込んでいる
    expect(hits.length, `${name} に ${hits.length} 件当たった`).toBe(1)
    expect(hits[0]!.node).toBe(node)
    expect(hits[0]!.triangles).toBe(triangles)
  })

  it('6 面すべてが揃う', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'AileronLeft',
        'AileronRight',
        'RudderLeft',
        'RudderRight',
        'StabilatorLeft',
        'StabilatorRight',
      ].sort(),
    )
  })

  it('左が +Z、右が −Z にある', () => {
    // **原本の左右は残った名前で決めた。**`La1`（Left aileron）が Z +5.41、
    // `Lw1`（left wing）が +4.58、`Rw1`（right wing）が −4.58。
    // 幾何だけで当てていると符号を取り違えても検査は通るので、ここで固定する
    const named = new Map(result.parts.map((p) => [p.raw.parent ?? p.name, p]))
    expect(named.get('La1')!.z, 'La1 は左なので +Z').toBeGreaterThan(0)
    expect(named.get('Lw1')!.z, 'Lw1 は左なので +Z').toBeGreaterThan(0)
    expect(named.get('Rw1')!.z, 'Rw1 は右なので −Z').toBeLessThan(0)

    for (const m of result.matched) {
      if (m.side === 'left') expect(m.part.z, `${m.name} が −Z にある`).toBeGreaterThan(0)
      else expect(m.part.z, `${m.name} が +Z にある`).toBeLessThan(0)
    }
  })

  it('左右の舵面が鏡像の位置にある', () => {
    for (const role of ['aileron', 'stabilator', 'rudder']) {
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
    // スタビレータはエルロンより後ろ（機首が −X）
    expect(at('StabilatorLeft').x).toBeGreaterThan(at('AileronLeft').x)
    // 垂直尾翼はいちばん高い
    expect(at('RudderLeft').y).toBeGreaterThan(at('StabilatorLeft').y)
    expect(at('RudderLeft').y).toBeGreaterThan(at('AileronLeft').y)
  })

  it('エルロンが外翼パネルではない', () => {
    // **1 度これを取り違えた。**主翼の外側は前縁フラップ（X 0.66）・パネル
    // 本体（`Main2`／`Main3`、X 1.43）・エルロン（X 2.47）の 3 枚に分かれて
    // いて、真ん中のパネルも「外翼後縁にある左右対称の薄板」の条件を満たす。
    // 拾うとロール指令で外翼が翼端ごと 30 度傾く。
    //
    // 見分けるのは翼弦。エルロンは 0.88 m でパネルは 1.99 m。舵面は翼幅方向に
    // 長いので、翼弦が翼幅の半分を超えたらそれは舵面ではない
    for (const side of ['Left', 'Right'] as const) {
      const p = result.matched.find((m) => m.name === `Aileron${side}`)!.part
      expect(p.sizeX, `Aileron${side} の翼弦 ${p.sizeX.toFixed(2)} m`).toBeLessThan(1.2)
      expect(p.sizeX / p.sizeZ, `Aileron${side} が翼幅方向に長くない`).toBeLessThan(0.5)
    }

    // パネル本体より後ろにあること（エルロンは後縁に付く）
    const panel = result.parts.find((p) => p.raw.parent === 'Main2')!
    expect(result.matched.find((m) => m.name === 'AileronLeft')!.part.x).toBeGreaterThan(panel.x)
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

describe('ヒンジ軸', () => {
  it('6 件そろい、軸が意図どおりの向きを向く', async () => {
    const { buildHinges } = await import('../../tools/f18e-hinges.mjs')
    const hinges = buildHinges(GLTF)
    expect(hinges.length).toBe(6)

    const dir = (h: { from: number[]; to: number[] }) => {
      const d = [0, 1, 2].map((k) => h.to[k]! - h.from[k]!)
      const n = Math.hypot(...d)
      return d.map((v) => v / n)
    }
    const at = (name: string) => hinges.find((h) => h.node === name)!

    // **エルロンは左右で逆を向く。**同じ符号で逆に回るため。
    // 揃っているとロールせずに両翼が同じ方向へ動く
    expect(dir(at('AileronLeft'))[2]).toBeCloseTo(-1, 2)
    expect(dir(at('AileronRight'))[2]).toBeCloseTo(1, 2)

    // スタビレータは左右同じ方向（機首上げで両方の後縁が上がる）
    expect(dir(at('StabilatorLeft'))[2]).toBeCloseTo(1, 2)
    expect(dir(at('StabilatorRight'))[2]).toBeCloseTo(1, 2)

    // ラダーは鉛直
    expect(dir(at('RudderLeft'))[1]).toBeCloseTo(1, 2)
    expect(dir(at('RudderRight'))[1]).toBeCloseTo(1, 2)
  })

  it('ヒンジが舵面の bbox の内側にある', async () => {
    const { buildHinges } = await import('../../tools/f18e-hinges.mjs')
    const { SCALE } = await import('../../tools/f18e-parts.mjs')
    for (const h of buildHinges(GLTF)) {
      const part = result.matched.find((m) => m.name === h.node)!.part
      const lo = part.raw.min.map((v: number) => v * SCALE)
      const hi = part.raw.max.map((v: number) => v * SCALE)
      for (const p of [h.from, h.to]) {
        for (let k = 0; k < 3; k++) {
          // **舵面の外にヒンジを置かない。**置くと舵が離れた位置を軸に振れる
          expect(p[k], `${h.node} の軸が bbox の外`).toBeGreaterThanOrEqual(lo[k]! - 0.01)
          expect(p[k], `${h.node} の軸が bbox の外`).toBeLessThanOrEqual(hi[k]! + 0.01)
        }
      }
    }
  })
})
