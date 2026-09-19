import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createControlSurfaces } from '@render/aircraft/surfaces'
import type { AircraftHinge } from '@render/aircraft/model'
import { F18_HINGES, xmlToWorld } from '../../tools/f18-hinges.mjs'
import { F16_HINGES } from '../../tools/f16-hinges.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * 舵の向きの検算。
 *
 * ヒンジの軸は左右で逆を向いていることがあるので、符号の扱いを間違えると
 * 左右のエルロンが揃って動く。絵で気づくのは遅いので、後縁の点が上下
 * どちらへ動くかを数値で固める。
 *
 * **ヒンジは機体の定義から読む。**手で写した値を期待値に置くと、定義を
 * 直したときにこの検査が付いてこない。変換ツールと同じ式で当方の座標へ
 * 移すところまでを再現する。当方の系は 機首 −Z、上 +Y、右 +X。後縁は
 * ヒンジより +Z 側にある。
 */

interface RawHinge {
  node: string
  from: number[]
  to?: number[]
  axis?: number[]
  maxDeg: number
  channel: string
  sign: number
}

/** 機体の定義を、変換ツールが glb へ載せるのと同じ形へ直す */
function toHinges(raw: readonly RawHinge[]): AircraftHinge[] {
  return raw.map((h) => {
    const origin = xmlToWorld(h.from)
    const end =
      h.to !== undefined
        ? xmlToWorld(h.to)
        : xmlToWorld([h.from[0]! + h.axis![0]!, h.from[1]! + h.axis![1]!, h.from[2]! + h.axis![2]!])
    const axis = new THREE.Vector3(
      end[0] - origin[0],
      end[1] - origin[1],
      end[2] - origin[2],
    ).normalize()
    return {
      node: h.node,
      origin,
      axis: [axis.x, axis.y, axis.z],
      maxDeg: h.maxDeg,
      channel: h.channel as AircraftHinge['channel'],
      sign: h.sign,
    }
  })
}

function build(raw: readonly RawHinge[]): {
  nodes: Map<string, THREE.Object3D>
  surfaces: ReturnType<typeof createControlSurfaces>
  hinges: AircraftHinge[]
} {
  const hinges = toHinges(raw)
  const nodes = new Map<string, THREE.Object3D>()
  for (const hinge of hinges) {
    const node = new THREE.Object3D()
    node.name = hinge.node
    nodes.set(hinge.node, node)
  }
  return { nodes, surfaces: createControlSurfaces(nodes, hinges), hinges }
}

/** 後縁の点（ヒンジから 1 m 後ろ）を回したあとの位置 */
function trailingEdge(node: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(node.quaternion)
}

/** 舵の切れ角 度 */
function angle(node: THREE.Object3D): number {
  const q = node.quaternion
  return 2 * Math.acos(Math.min(1, Math.abs(q.w))) * (180 / Math.PI)
}

/**
 * 機体ごとの舵面の名前。
 *
 * F-16 はラダーが 1 枚しかない。左右あるものだけ組にする。
 */
const CRAFT = [
  {
    id: 'f18',
    raw: F18_HINGES as unknown as RawHinge[],
    count: 6,
    aileron: ['AileronLeft', 'AileronRight'],
    elevator: ['ElevatorLeft', 'ElevatorRight'],
    rudder: ['RudderLeft', 'RudderRight'],
    maxAileron: 30,
    maxElevator: 25,
    maxRudder: 30,
  },
  {
    id: 'f16',
    raw: F16_HINGES as unknown as RawHinge[],
    count: 5,
    aileron: ['AileronLeft', 'AileronRight'],
    elevator: ['ElevatorLeft', 'ElevatorRight'],
    rudder: ['Rudder'],
    maxAileron: 20,
    maxElevator: 25,
    maxRudder: 30,
  },
] as const

describe.each(CRAFT)('$id の舵面の向き', (craft) => {
  it('定義した舵面をすべて拾う', () => {
    expect(build(craft.raw).surfaces.count).toBe(craft.count)
  })

  it('左ロールで左のエルロンが上がり、右が下がる', () => {
    const { nodes, surfaces } = build(craft.raw)
    // 指令が負で左ロール（sim の setBodyRates は roll 正が右）
    surfaces.update(0, -1, 0)

    expect(trailingEdge(nodes.get(craft.aileron[0])!).y).toBeGreaterThan(0.3)
    expect(trailingEdge(nodes.get(craft.aileron[1])!).y).toBeLessThan(-0.3)
  })

  it('右ロールで左右が入れ替わる', () => {
    const { nodes, surfaces } = build(craft.raw)
    surfaces.update(0, 1, 0)

    expect(trailingEdge(nodes.get(craft.aileron[0])!).y).toBeLessThan(-0.3)
    expect(trailingEdge(nodes.get(craft.aileron[1])!).y).toBeGreaterThan(0.3)
  })

  it('機首上げでエレベータの後縁が上がる', () => {
    const { nodes, surfaces } = build(craft.raw)
    surfaces.update(1, 0, 0)

    // 水平尾翼が下向きの力を出して機首を持ち上げる
    for (const name of craft.elevator) {
      expect(trailingEdge(nodes.get(name)!).y).toBeGreaterThan(0.3)
    }
  })

  it('エレベータは左右が同じ向きに動く', () => {
    const { nodes, surfaces } = build(craft.raw)
    surfaces.update(0.6, 0, 0)
    const left = trailingEdge(nodes.get(craft.elevator[0])!)
    const right = trailingEdge(nodes.get(craft.elevator[1])!)
    expect(left.y).toBeCloseTo(right.y, 12)
  })

  it('右ヨーでラダーの後縁が右へ振れる', () => {
    const { nodes, surfaces } = build(craft.raw)
    surfaces.update(0, 0, 1)

    for (const name of craft.rudder) {
      expect(trailingEdge(nodes.get(name)!).x).toBeGreaterThan(0.3)
    }
  })

  it('舵角がヒンジの最大値を超えない', () => {
    const { nodes, surfaces } = build(craft.raw)
    // 範囲外の指令を渡しても切り詰める
    surfaces.update(5, -5, 5)
    expect(angle(nodes.get(craft.aileron[0])!)).toBeCloseTo(craft.maxAileron, 6)
    expect(angle(nodes.get(craft.elevator[0])!)).toBeCloseTo(craft.maxElevator, 6)
    expect(angle(nodes.get(craft.rudder[0])!)).toBeCloseTo(craft.maxRudder, 6)
  })

  it('中立では回転しない', () => {
    const { nodes, surfaces, hinges } = build(craft.raw)
    surfaces.update(0, 0, 0)
    for (const hinge of hinges) {
      expect(nodes.get(hinge.node)!.quaternion.w).toBeCloseTo(1, 12)
    }
  })
})

/**
 * F/A-18E の舵の向き。
 *
 * **glb の extras から読む。**F/A-18C と F-16 は `tools/*-hinges.mjs` が
 * XML 座標を持っていて、この検査が変換を再現していた。F/A-18E は原本に XML が
 * 無く、`tools/f18e-hinges.mjs` が bbox から軸を導いて
 * `tools/f18e-to-glb.mjs` が座標系を回す。**変換の再現ではなく、出来上がった
 * glb を読んで確かめる。**
 *
 * これで「舵面の同定」「ヒンジの軸」「座標系の回転」の 3 つが通しで見える。
 * 途中のどれかを間違えると後縁が逆へ動く。
 */
describe('f18e の舵面の向き（glb の extras から）', () => {
  const glbHinges = (() => {
    const path = fileURLToPath(new URL('../../public/aircraft/f18e.glb', import.meta.url))
    // **`public/aircraft/` は生成物で `.gitignore` に入っている。**`npm test` は
    // `pretest` で `npm run assets` を通すので普通は在る。`npx vitest run` で
    // 直に呼んだときだけ無いので、何をすればよいかを書いて落とす
    if (!existsSync(path)) {
      throw new Error(`${path} が無い。npm run assets を走らせること`)
    }
    const buf = readFileSync(path)
    const jsonLength = buf.readUInt32LE(12)
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'))
    return gltf.scenes[0].extras.hinges as AircraftHinge[]
  })()

  function buildFromGlb() {
    const nodes = new Map<string, THREE.Object3D>()
    for (const h of glbHinges) {
      const node = new THREE.Object3D()
      node.name = h.node
      nodes.set(h.node, node)
    }
    return { nodes, surfaces: createControlSurfaces(nodes, glbHinges) }
  }

  it('6 面が載っている', () => {
    expect(glbHinges.length).toBe(6)
    expect(glbHinges.map((h) => h.node).sort()).toEqual(
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

  it('左の舵面が −X、右が +X にある', () => {
    // **左右の割り当ての決め手。**原本は +Z が左（`La1`／`Lw1`／`Rw1` の名前）で、
    // 変換 (x,y,z) → (−z,y,x) を通すと −X へ移る。この作品は機首 −Z・上 +Y の
    // 右手系なので +X が右。**つまり左は −X。**
    // 名前と位置がここでずれていると、絵では左へロールしながら右のエルロンが
    // 下がる（幾何だけの検査では捕まらない）
    for (const h of glbHinges) {
      if (h.node.endsWith('Left')) expect(h.origin[0], `${h.node} が +X にある`).toBeLessThan(0)
      else expect(h.origin[0], `${h.node} が −X にある`).toBeGreaterThan(0)
    }
  })

  it('エルロンの軸が左右で逆を向く', () => {
    const left = glbHinges.find((h) => h.node === 'AileronLeft')!
    const right = glbHinges.find((h) => h.node === 'AileronRight')!
    // **同じ符号で逆に回るために逆向きが要る。**揃っていると両翼が同じ方向へ
    // 動いてロールしない
    expect(left.axis[0]! * right.axis[0]!).toBeLessThan(0)
  })

  it('左ロールで左のエルロンが上がり、右が下がる', () => {
    const { nodes, surfaces } = buildFromGlb()
    // 指令が負で左ロール（sim の setBodyRates は roll 正が右）
    surfaces.update(0, -1, 0)
    expect(trailingEdge(nodes.get('AileronLeft')!).y).toBeGreaterThan(0.3)
    expect(trailingEdge(nodes.get('AileronRight')!).y).toBeLessThan(-0.3)
  })

  it('機首上げでスタビレータの後縁が左右そろって上がる', () => {
    const { nodes, surfaces } = buildFromGlb()
    surfaces.update(1, 0, 0)
    const a = trailingEdge(nodes.get('StabilatorLeft')!).y
    const b = trailingEdge(nodes.get('StabilatorRight')!).y
    // 水平尾翼は左右同じ方向。**逆へ動いたら軸の向きが揃っていない**
    expect(a * b, `左 ${a.toFixed(2)} 右 ${b.toFixed(2)} が逆向き`).toBeGreaterThan(0)
    expect(a).toBeGreaterThan(0.3)
  })

  it('ヨーでラダーが左右そろって振れる', () => {
    const { nodes, surfaces } = buildFromGlb()
    surfaces.update(0, 0, 1)
    const a = trailingEdge(nodes.get('RudderLeft')!).x
    const b = trailingEdge(nodes.get('RudderRight')!).x
    expect(a * b, `左 ${a.toFixed(2)} 右 ${b.toFixed(2)} が逆向き`).toBeGreaterThan(0)
    expect(Math.abs(a)).toBeGreaterThan(0.3)
  })

  it('舵角が定義した上限に収まる', () => {
    const { nodes, surfaces } = buildFromGlb()
    surfaces.update(1, 1, 1)
    for (const h of glbHinges) {
      const deg = angle(nodes.get(h.node)!)
      expect(deg, `${h.node} が ${deg.toFixed(1)} 度`).toBeLessThanOrEqual(h.maxDeg + 0.01)
    }
  })
})
