import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createControlSurfaces } from '@render/aircraft/surfaces'
import type { AircraftHinge } from '@render/aircraft/model'
import { F18_HINGES, xmlToWorld } from '../../tools/f18-hinges.mjs'
import { F16_HINGES } from '../../tools/f16-hinges.mjs'

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
