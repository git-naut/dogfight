import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createControlSurfaces } from '@render/aircraft/surfaces'
import type { AircraftHinge } from '@render/aircraft/model'

/**
 * 後縁上げと後縁下げで上限が違う舵面（2026-10-07、NASA TM-4786）。**作り物のヒンジで見る。**
 * glb は生成物で、歯型の作業場には無い
 */
const STAB: AircraftHinge = {
  node: 'Stab',
  origin: [0, 0, 0],
  axis: [1, 0, 0],
  maxDeg: 24,
  maxDegPositive: 24,
  maxDegNegative: 10.5,
  channel: 'elevator',
  sign: 1,
}

function angleOf(command: number, hinge: AircraftHinge): number {
  const node = new THREE.Object3D()
  const surfaces = createControlSurfaces(new Map([[hinge.node, node]]), [hinge])
  surfaces.update(command, 0, 0)
  // 軸まわりの符号付きの角度 deg
  const q = node.quaternion
  return ((2 * Math.atan2(q.x, q.w)) * 180) / Math.PI
}

describe('舵角の上限（正と負で別）', () => {
  it('指令 +1 で +24 度、−1 で −10.5 度', () => {
    expect(angleOf(1, STAB)).toBeCloseTo(24, 9)
    expect(angleOf(-1, STAB)).toBeCloseTo(-10.5, 9)
    expect(angleOf(0.5, STAB)).toBeCloseTo(12, 9)
    expect(angleOf(-0.5, STAB)).toBeCloseTo(-5.25, 9)
  })

  it('符号が −1 なら、指令 +1 は負の側（−10.5 度）を使う', () => {
    expect(angleOf(1, { ...STAB, sign: -1 })).toBeCloseTo(-10.5, 9)
  })

  it('上限が 1 つしか無い機体（F/A-18C・F-16）は両側に maxDeg を使う', () => {
    const plain: AircraftHinge = { node: 'P', origin: [0, 0, 0], axis: [1, 0, 0], maxDeg: 30, channel: 'elevator', sign: 1 }
    expect(angleOf(1, plain)).toBeCloseTo(30, 9)
    expect(angleOf(-1, plain)).toBeCloseTo(-30, 9)
  })
})
