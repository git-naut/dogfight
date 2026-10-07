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
  it('16 件が機体の下にある', () => {
    // Phase 9 の段 6 で脚柱の上半分 3 件（各 637・637・979 三角形）を足して 13 件から 16 件
    expect(result.gear.length).toBe(16)
    expect(result.gear.reduce((s, p) => s + p.triangles, 0)).toBe(7_829 + 637 + 637 + 979)
    for (const p of result.gear) expect(p.y).toBeLessThan(-0.5)
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

/**
 * 脚 3 本とフック（Phase 9 の段 6）。脚は `GEAR_RULE` に当たった部品を位置で 3 本に
 * 振り分ける。**1 つの部品が 2 本に入ったり、どこにも入らなかったりしない**
 */
describe('脚とフック', () => {
  it('脚の部品が前脚 5・左主脚 6・右主脚 5 にちょうど 1 回ずつ入る', () => {
    const count = Object.fromEntries(result.legs.map((l) => [l.leg, l.parts.length]))
    expect(count).toEqual({ nose: 5, left: 6, right: 5 })
    const all = result.legs.flatMap((l) => l.parts.map((p) => p.index))
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(result.gear.length)
  })

  /**
   * **脚柱の上半分も脚に入る。**入っていないと、脚を上げても機体の下にぶら下がる
   * （段 6 で気づいた）。胴体の下面の平板 `fi18` は巻き込まない
   */
  it('脚柱の上半分（185・186・195）が入り、胴体の下面（fi18）は入らない', () => {
    const names = new Set(result.gear.map((p) => p.raw.parent ?? p.name))
    for (const n of ['Meshpart185', 'Meshpart186', 'Meshpart195']) expect(names.has(n), n).toBe(true)
    expect(names.has('fi18')).toBe(false)
  })

  it('左主脚は +Z（原本の左）、右主脚は −Z にある', () => {
    for (const l of result.legs) {
      if (l.leg === 'nose') continue
      for (const p of l.parts) expect(Math.sign(p.z), `${l.leg} の ${p.name}`).toBe(l.leg === 'left' ? 1 : -1)
    }
  })

  /**
   * 畳む向き。原本の座標（機首 −X、上 +Y、+Z が左）で、付け根から真下の点を軸まわりに
   * 格納の角度だけ回す。前脚は前（−X）、主脚は後ろ（+X）へ水平まで畳まれる
   */
  it('前脚は前へ、主脚は後ろへ 90 度畳む', async () => {
    const { buildGearHinges } = await import('../../tools/f18e-hinges.mjs')
    const { gear } = buildGearHinges(GLTF)
    const fold = (axis: readonly number[], deg: number) => {
      // ロドリゲスの公式で (0, −1, 0) を回す
      const a = (deg * Math.PI) / 180
      const v = [0, -1, 0]
      const c = Math.cos(a)
      const sn = Math.sin(a)
      const dot = v[0]! * axis[0]! + v[1]! * axis[1]! + v[2]! * axis[2]!
      const cross = [
        axis[1]! * v[2]! - axis[2]! * v[1]!,
        axis[2]! * v[0]! - axis[0]! * v[2]!,
        axis[0]! * v[1]! - axis[1]! * v[0]!,
      ]
      return [0, 1, 2].map((k) => v[k]! * c + cross[k]! * sn + axis[k]! * dot * (1 - c))
    }
    for (const g of gear) {
      const foot = fold(g.axis, g.retractDeg)
      expect(g.retractDeg, g.leg).toBe(90)
      expect(foot[1], `${g.leg} が水平まで畳まれていない`).toBeCloseTo(0, 9)
      expect(foot[0], `${g.leg} の畳む向き`).toBeCloseTo(g.leg === 'nose' ? -1 : 1, 9)
    }
  })

  it('フックは Tailhook2 の 1 部品で、尾部の下にある', () => {
    expect(result.hook.map((p) => p.raw.parent ?? p.name)).toEqual(['Tailhook2'])
    expect(result.hook[0]!.x).toBeGreaterThan(5)
  })
})

/**
 * 舵面の上限は道具（素の JavaScript）と sim の 2 か所に書いてある。**片方だけ直すと、描画の
 * 角度と sim の速さの計算が食い違う**ので、一致を見張る（NASA TM-4786 の表）
 */
describe('舵面の上限', () => {
  it('道具の SURFACE_DEG と sim の SURFACE_LIMITS が同じ値', async () => {
    const { SURFACE_DEG } = await import('../../tools/f18e-hinges.mjs')
    const sim = await import('../../src/sim/controlSurfaces')
    expect(SURFACE_DEG.stabilator).toEqual({
      up: sim.SURFACE_LIMITS.elevator.positiveDeg,
      down: sim.SURFACE_LIMITS.elevator.negativeDeg,
    })
    expect(SURFACE_DEG.aileron).toEqual({
      up: sim.AILERON_TRAILING_EDGE_UP_DEG,
      down: sim.AILERON_TRAILING_EDGE_DOWN_DEG,
    })
    expect(SURFACE_DEG.rudder).toEqual({ up: sim.SURFACE_LIMITS.rudder.positiveDeg, down: sim.SURFACE_LIMITS.rudder.negativeDeg })
    // 表の値そのもの
    expect(SURFACE_DEG.stabilator).toEqual({ up: 24, down: 10.5 })
    expect(SURFACE_DEG.aileron).toEqual({ up: 24, down: 45 })
  })

  it('水平尾翼は機首上げで後縁上げ 24 度、機首下げで後縁下げ 10.5 度', async () => {
    const { buildHinges } = await import('../../tools/f18e-hinges.mjs')
    for (const h of buildHinges(GLTF).filter((x) => x.role === 'stabilator')) {
      // 指令 +1（機首上げ）× 符号 が正の回転。正の回転が後縁上げなら上限 24 度
      expect(h.sign * 1 > 0 ? h.positiveRaisesTrailingEdge : !h.positiveRaisesTrailingEdge, h.node).toBe(true)
      expect(h.sign > 0 ? h.maxDegPositive : h.maxDegNegative, h.node).toBe(24)
      expect(h.sign > 0 ? h.maxDegNegative : h.maxDegPositive, h.node).toBe(10.5)
    }
  })

  it('エルロンは後縁上げ 24 度、後縁下げ 45 度。左右で向きが逆', async () => {
    const { buildHinges } = await import('../../tools/f18e-hinges.mjs')
    const ail = buildHinges(GLTF).filter((x) => x.role === 'aileron')
    for (const h of ail) {
      const up = h.positiveRaisesTrailingEdge ? h.maxDegPositive : h.maxDegNegative
      const down = h.positiveRaisesTrailingEdge ? h.maxDegNegative : h.maxDegPositive
      expect([up, down], h.node).toEqual([24, 45])
    }
    // 同じ指令で左右が逆に動く
    expect(ail[0]!.positiveRaisesTrailingEdge).not.toBe(ail[1]!.positiveRaisesTrailingEdge)
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

    // **ラダーは鉛直ではない。**垂直尾翼と同じく外へ傾いた前縁に沿う。Phase 9 までは
    // 鉛直の軸で回していて、ラダーが自分の面の外へ振れて付け根が胴体から浮いた。
    // 測った傾きは左右とも 17〜18 度（左は +Z、右は −Z へ倒れる）
    for (const [name, outward] of [
      ['RudderLeft', 1],
      ['RudderRight', -1],
    ] as const) {
      const d = dir(at(name))
      expect(d[1], `${name} が上を向いていない`).toBeGreaterThan(0.85)
      const cant = (Math.atan2(outward * d[2]!, d[1]!) * 180) / Math.PI
      expect(cant, `${name} の外への傾き`).toBeGreaterThan(15)
      expect(cant, `${name} の外への傾き`).toBeLessThan(25)
    }
  })

  /**
   * **舵面が付け根から浮かない。**最大舵角まで回したとき、継ぎ目の頂点が固定の部品から
   * 離れる距離を測る（`seamDeparture`）。外接箱から作っていた軸ではエルロン 11〜15 cm・
   * ラダー 8〜30 cm 離れ、ライブで「機体に接しておらず隙間がある」と指摘された
   * （2026-10-07）。頂点から作る軸では 5〜6 cm。残りは舵面の両端の断面が隣の部品と
   * 接しているぶんで、実機も舵角を付ければそこはずれる
   */
  it('最大舵角でも継ぎ目がエルロン 9 cm・ラダー 7 cm より離れない', async () => {
    const { buildHinges, seamDeparture } = await import('../../tools/f18e-hinges.mjs')
    const result = seamDeparture(GLTF, buildHinges(GLTF))
    // **エルロンは 9 cm。**2026-10-07 に後縁下げの上限を 30 度から 45 度（NASA TM-4786）へ
    // 広げ、端の断面のずれが増えた（7.6 cm）。高さ一定の軸（直す前の誤り）は 45 度で 10.5 cm
    const limit: Record<string, number> = { AileronLeft: 0.09, AileronRight: 0.09, RudderLeft: 0.07, RudderRight: 0.07 }
    for (const name of Object.keys(limit)) {
      const r = result[name]!
      // 継ぎ目を拾えていないと測った値に意味がない
      expect(r.seam, `${name} の継ぎ目の頂点`).toBeGreaterThanOrEqual(3)
      expect(r.max, `${name} の継ぎ目の離れ方`).toBeLessThan(limit[name]!)
    }
  }, 60_000)

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
