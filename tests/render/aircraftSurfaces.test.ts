import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createControlSurfaces } from '@render/aircraft/surfaces'
import type { AircraftHinge } from '@render/aircraft/model'

/**
 * 舵の向きの検算。
 *
 * ヒンジの軸は左右で逆を向いているので、符号の扱いを間違えると左右の
 * エルロンが揃って動く。絵で気づくのは遅いので、後縁の点が上下どちらへ
 * 動くかを数値で固める。
 *
 * ヒンジの値は tools/f18-hinges.mjs と同じもの（当方の座標系へ変換済み）。
 * 当方の系は 機首 −Z、上 +Y、右 +X。後縁はヒンジより +Z 側にある。
 */

const HINGES: AircraftHinge[] = [
  { node: 'AileronLeft', origin: [-3.74241, 0.470943, 2.67178], axis: [-1, 0, 0], maxDeg: 30 },
  { node: 'AileronRight', origin: [3.74241, 0.470943, 2.67178], axis: [1, 0, 0], maxDeg: 30 },
  { node: 'ElevatorLeft', origin: [0, -0.0314742, 5.22371], axis: [1, 0, 0], maxDeg: 25 },
  { node: 'ElevatorRight', origin: [0, -0.0314742, 5.22371], axis: [1, 0, 0], maxDeg: 25 },
  { node: 'RudderLeft', origin: [-1.03207, 0.670875, 4.46901], axis: [-0.30606, 0.89473, 0.32497], maxDeg: 30 },
  { node: 'RudderRight', origin: [1.03207, 0.670875, 4.46901], axis: [0.30606, 0.89473, 0.32497], maxDeg: 30 },
]

function build(): {
  nodes: Map<string, THREE.Object3D>
  surfaces: ReturnType<typeof createControlSurfaces>
} {
  const nodes = new Map<string, THREE.Object3D>()
  for (const hinge of HINGES) {
    const node = new THREE.Object3D()
    node.name = hinge.node
    nodes.set(hinge.node, node)
  }
  return { nodes, surfaces: createControlSurfaces(nodes, HINGES) }
}

/** 後縁の点（ヒンジから 1 m 後ろ）を回したあとの位置 */
function trailingEdge(node: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(node.quaternion)
}

describe('舵面の向き', () => {
  it('6 枚すべてを拾う', () => {
    expect(build().surfaces.count).toBe(6)
  })

  it('左ロールで左のエルロンが上がり、右が下がる', () => {
    const { nodes, surfaces } = build()
    // 指令が負で左ロール（sim の setBodyRates は roll 正が右）
    surfaces.update(0, -1, 0)

    expect(trailingEdge(nodes.get('AileronLeft')!).y).toBeGreaterThan(0.4)
    expect(trailingEdge(nodes.get('AileronRight')!).y).toBeLessThan(-0.4)
  })

  it('右ロールで左右が入れ替わる', () => {
    const { nodes, surfaces } = build()
    surfaces.update(0, 1, 0)

    expect(trailingEdge(nodes.get('AileronLeft')!).y).toBeLessThan(-0.4)
    expect(trailingEdge(nodes.get('AileronRight')!).y).toBeGreaterThan(0.4)
  })

  it('機首上げでエレベータの後縁が上がる', () => {
    const { nodes, surfaces } = build()
    surfaces.update(1, 0, 0)

    // 水平尾翼が下向きの力を出して機首を持ち上げる
    expect(trailingEdge(nodes.get('ElevatorLeft')!).y).toBeGreaterThan(0.3)
    expect(trailingEdge(nodes.get('ElevatorRight')!).y).toBeGreaterThan(0.3)
  })

  it('エレベータは左右が同じ向きに動く', () => {
    const { nodes, surfaces } = build()
    surfaces.update(0.6, 0, 0)
    const left = trailingEdge(nodes.get('ElevatorLeft')!)
    const right = trailingEdge(nodes.get('ElevatorRight')!)
    expect(left.y).toBeCloseTo(right.y, 12)
  })

  it('右ヨーでラダーの後縁が右へ振れる', () => {
    const { nodes, surfaces } = build()
    surfaces.update(0, 0, 1)

    expect(trailingEdge(nodes.get('RudderLeft')!).x).toBeGreaterThan(0.3)
    expect(trailingEdge(nodes.get('RudderRight')!).x).toBeGreaterThan(0.3)
  })

  it('舵角がヒンジの最大値を超えない', () => {
    const { nodes, surfaces } = build()
    // 範囲外の指令を渡しても切り詰める
    surfaces.update(5, -5, 5)
    const angle = (name: string): number => {
      const q = nodes.get(name)!.quaternion
      return 2 * Math.acos(Math.min(1, Math.abs(q.w))) * (180 / Math.PI)
    }
    expect(angle('AileronLeft')).toBeCloseTo(30, 6)
    expect(angle('ElevatorLeft')).toBeCloseTo(25, 6)
    expect(angle('RudderLeft')).toBeCloseTo(30, 6)
  })

  it('中立では回転しない', () => {
    const { nodes, surfaces } = build()
    surfaces.update(0, 0, 0)
    for (const hinge of HINGES) {
      const q = nodes.get(hinge.node)!.quaternion
      expect(q.w).toBeCloseTo(1, 12)
    }
  })
})
