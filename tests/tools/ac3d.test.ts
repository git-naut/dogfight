import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { parseAc3d, flatten, stats, bounds, toWorld } from '../../tools/ac3d.mjs'
import { F18_HINGES } from '../../tools/f18-hinges.mjs'
import { F16_HINGES } from '../../tools/f16-hinges.mjs'
import { xmlToAc, xmlToWorld } from '../../tools/fg-coords.mjs'

/**
 * AC3D パーサの検算。
 *
 * 自分のパーサが出した数値を自分で期待値に置くと、回帰しか防げない。正しさは
 * 外の事実と突き合わせて確かめる。使える外の事実が4つある。
 *
 * ファイル自身が宣言している数（`numvert` と `kids` の合計）。
 * FlightGear のアニメーション XML が持つヒンジの座標。
 * JSBSim の飛行制御が持つ舵角の上限。
 * 実機の寸法。
 *
 * **機体 2 機で回す。**1 機だけだと、その機体に固有の性質を仕様と取り違える。
 * 実際にそうなっていた。F/A-18C しか見ていなかったので「1 枚の舵面 = 1 つの
 * オブジェクト」「舵面の名前は左右で対になる」「エルロンの軸は外向き」を
 * 前提にしていて、F-16 で 3 つとも崩れた。
 */

function read(craft: string, file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../assets/upstream/${craft}/${file}`, import.meta.url)),
    'utf8',
  )
}

const source = read('f18', 'f18.ac')
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

/**
 * 機体ごとの実測値。
 *
 * オブジェクト数・三角形数・頂点数は原本から測ってある。パーサの正しさを
 * 外から固定するために書く。実機の寸法は公表値。
 */
const CRAFT = [
  {
    id: 'f18',
    file: 'f18.ac',
    hinges: F18_HINGES,
    objects: 201,
    triangles: 18_634,
    vertices: 12_260,
    /** 公表値。全長 17.07 m（56 ft）、翼幅 11.43 m（翼端ランチャなし）、全高 4.66 m */
    real: { span: 11.43, height: 4.66 },
    /** 機体だけの全長 m。実測 */
    length: 15.391,
    /** 機外の炎は寸法に入れない */
    exclude: /Flame/,
    /** ヒンジの中心が舵面の外に出る舵面。翼幅方向だけ見逃す */
    centerlineHinge: /^Elevator/,
    surfaces: 6,
  },
  {
    id: 'f16',
    file: 'f16.ac',
    hinges: F16_HINGES,
    objects: 125,
    triangles: 18_042,
    vertices: 10_627,
    /** 公表値。全長 15.06 m（49 ft 5 in）、翼幅 9.45 m（翼端ランチャなし）、全高 5.09 m */
    real: { span: 9.45, height: 5.09 },
    /** 機体だけの全長 m。実測 */
    length: 14.307,
    exclude: /Flame/,
    centerlineHinge: /^$/,
    surfaces: 5,
  },
] as const

describe.each(CRAFT)('$id の取り込み', (craft) => {
  const text = read(craft.id, craft.file)
  const tree = parseAc3d(text)
  const flat = flatten(tree.root)
  const st = stats(tree.root)

  it('原本から測った数と一致する', () => {
    expect(st.objects).toBe(craft.objects)
    expect(st.triangles).toBe(craft.triangles)
    expect(st.vertices).toBe(craft.vertices)
  })

  it('素の正規表現で数えた値とも一致する', () => {
    const expected = countByRegex(text)
    expect(st.objects).toBe(expected.objects)
    expect(st.triangles).toBe(expected.triangles)
    expect(st.vertices).toBe(expected.vertices)
    expect(st.surfaces).toBe(expected.surfaces)
  })

  it('翼幅と全高が公表値と 4% 以内で一致する', () => {
    // 実測の比。f18 は翼幅 1.012 / 全高 0.963、f16 は 1.015 / 1.015
    const b = bounds(flat.filter((p) => !craft.exclude.test(p.name)))
    for (const [label, measured, real] of [
      ['翼幅', b.size[2], craft.real.span],
      ['全高', b.size[1], craft.real.height],
    ] as const) {
      const ratio = (measured ?? 0) / real
      expect(ratio, `${label} の比 ${ratio.toFixed(3)}`).toBeGreaterThan(0.96)
      expect(ratio, `${label} の比 ${ratio.toFixed(3)}`).toBeLessThan(1.04)
    }
  })

  /**
   * 全長は公表値と突き合わせない。**どちらの原本も公表値より短い。**
   *
   * f18 は機体だけで 15.391 m、公表値 17.07 m に対して 90.2%。f16 は
   * 14.307 m で 15.06 m に対して 95.0%。翼幅と全高は 4% 以内で合うので
   * 縮尺は正しく、前後だけが詰まっている。
   *
   * **以前この検査は f18 の全長を 1.043 として通していた。**炎を含めた
   * 境界（17.797 m）と公表値を比べていたためで、機外の排気炎が 2.4 m ぶん
   * 下駄を履かせていた。炎を外した瞬間に 0.902 になった。合っていたのは
   * 偶然で、寸法の裏取りにはなっていなかった。
   *
   * 原本は直せないので、実測値で固定して形が崩れたことだけを捕まえる。
   */
  it('機体だけの全長が実測値と一致する', () => {
    const b = bounds(flat.filter((p) => !craft.exclude.test(p.name)))
    expect(b.size[0]).toBeCloseTo(craft.length, 3)
  })

  describe('舵面のヒンジ', () => {
    const byName = new Map(flat.map((p) => [p.name, p]))

    it('定義した枚数がある', () => {
      expect(craft.hinges.length).toBe(craft.surfaces)
    })

    it('束ねるオブジェクトがすべてモデルに存在する', () => {
      for (const hinge of craft.hinges) {
        for (const object of hinge.objects) {
          expect(byName.has(object), `${hinge.node} の ${object} が無い`).toBe(true)
        }
      }
    })

    it('1 つのオブジェクトが 2 つの舵面に入っていない', () => {
      const seen = new Set<string>()
      for (const hinge of craft.hinges) {
        for (const object of hinge.objects) {
          expect(seen.has(object), `${object} が重複`).toBe(false)
          seen.add(object)
        }
      }
    })

    it('XML のヒンジが対応する舵面の境界の内側にある', () => {
      // これが座標系の対応の検算。XML は FlightGear が持つ独立した情報なので、
      // パーサ側の思い込みでは一致しない
      for (const hinge of craft.hinges) {
        const b = bounds(hinge.objects.map((o) => byName.get(o)!))
        const point = xmlToAc(hinge.from)
        // 中心線上に軸を置く舵面は左右の舵面の外に出る。回転軸が翼幅方向
        // なので前後と上下だけ見る
        const axes = craft.centerlineHinge.test(hinge.node) ? [0, 1] : [0, 1, 2]
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
      for (const side of ['AileronLeft', 'AileronRight'] as const) {
        const hinge = craft.hinges.find((h) => h.node === side)!
        const from = xmlToWorld(hinge.from)
        const to = xmlToWorld(hinge.to!)
        // 当方の系で X が翼幅方向。左は −X 側にある
        expect(Math.abs(to[0] - from[0])).toBeGreaterThan(1)
        const sign = side === 'AileronLeft' ? -1 : 1
        expect(from[0] * sign).toBeGreaterThan(0)
        // 前後と上下の傾きは翼幅方向より小さい
        expect(Math.abs(to[1] - from[1])).toBeLessThan(Math.abs(to[0] - from[0]))
        expect(Math.abs(to[2] - from[2])).toBeLessThan(Math.abs(to[0] - from[0]))
      }
    })
  })
})

describe('舵角の上限が原典と一致する', () => {
  /** JSBSim の `kinematic` から clipto の min と max を読む */
  function clipto(text: string, name: string): { min: number; max: number } {
    const block = new RegExp(
      `<kinematic name="${name}">[\\s\\S]*?<clipto>\\s*<min>\\s*(-?[\\d.]+)\\s*</min>\\s*<max>\\s*(-?[\\d.]+)\\s*</max>`,
    ).exec(text)
    if (block === null) throw new Error(`${name} の clipto が見つからない`)
    return { min: Number(block[1]), max: Number(block[2]) }
  }

  it('F-16 の水平尾翼・ラダー・フラッペロン', () => {
    const fdm = read('f16', 'jsb-controls.xml')
    const tail = clipto(fdm, 'fcs/fly-by-wire/pitch/horz-tail-right-deflection-deg')
    const rudder = clipto(fdm, 'fcs/fly-by-wire/yaw/rudder-deflection-deg')
    const flaperon = clipto(fdm, 'fcs/fly-by-wire/roll/flaperon-right-deflection-deg')

    expect(tail).toEqual({ min: -25, max: 25 })
    expect(rudder).toEqual({ min: -30, max: 30 })
    // 上下で非対称。狭い側を採る
    expect(flaperon).toEqual({ min: -23, max: 20 })

    const byNode = new Map(F16_HINGES.map((h) => [h.node, h.maxDeg]))
    expect(byNode.get('ElevatorLeft')).toBe(tail.max)
    expect(byNode.get('Rudder')).toBe(rudder.max)
    expect(byNode.get('AileronLeft')).toBe(Math.min(-flaperon.min, flaperon.max))
  })

  it('F/A-18C は XML の factor と一致する', () => {
    const byNode = new Map(F18_HINGES.map((h) => [h.node, h.maxDeg]))
    expect(byNode.get('AileronLeft')).toBe(30)
    expect(byNode.get('RudderLeft')).toBe(30)
    expect(byNode.get('ElevatorLeft')).toBe(25)
  })
})
