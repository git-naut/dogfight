import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createAircraftView } from '@render/aircraftView'
import type { AircraftModel } from '@render/aircraft/model'
import { HOOK_DOWN_ANGLE, HOOK_PIVOT, HOOK_POINT_STOWED, hookPointBody } from '@sim/arrestor'
import { Vec3 } from '@sim/vec3'

/**
 * `setGear` が脚を畳む（Phase 9 の段 6）。
 *
 * **作り物の脚で見る。**glb は生成物で、歯型の作業場には無い。軸は glb の定義と同じ
 * もの（前脚 +X、主脚 −X。正の角で畳む向き）を手で置く。glb の中身は
 * `tests/render/gearLegsGlb.test.ts` が、軸の向きの元は `tests/tools/f18eParts.test.ts` が
 * 見る。この作品の座標は機首 −Z、上 +Y、右 +X
 */
const LEGS = [
  // 前脚。+X 軸まわりの正の角で、下向きの脚は前（−Z）へ振れる
  { leg: 'nose', axis: [1, 0, 0] },
  // 主脚。−X 軸まわりの正の角で後ろ（+Z）へ振れる
  { leg: 'left', axis: [-1, 0, 0] },
  { leg: 'right', axis: [-1, 0, 0] },
] as const

function syntheticModel(): { model: AircraftModel; legs: Map<string, THREE.Object3D> } {
  const object = new THREE.Object3D()
  const gear = new THREE.Object3D()
  gear.name = 'gear'
  object.add(gear)
  const legs = new Map<string, THREE.Object3D>()
  const gearLegs = LEGS.map((l) => {
    const node = new THREE.Object3D()
    gear.add(node)
    legs.set(l.leg, node)
    return { object: node, axis: new THREE.Vector3(...l.axis), retractRad: Math.PI / 2 }
  })
  const model: AircraftModel = {
    object,
    nozzles: [],
    gear,
    gearLegs,
    hook: null,
    hookAxis: new THREE.Vector3(-1, 0, 0),
    surfaces: new Map(),
    hinges: [],
    triangles: 0,
    dispose() {},
  }
  return { model, legs }
}

/** 脚の付け根から 1 m 真下の点が、回したあとどこへ行くか（付け根からの相対） */
function footOf(node: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, -1, 0).applyQuaternion(node.quaternion)
}

describe('setGear', () => {
  it('出し切り（1）では回転 0。出し切りの絵は段 5 までと同じ', () => {
    const { model, legs } = syntheticModel()
    createAircraftView(model).setGear(1)
    for (const [leg, node] of legs) {
      expect(node.quaternion.angleTo(new THREE.Quaternion()), leg).toBeCloseTo(0, 9)
    }
    expect(model.gear!.visible).toBe(true)
  })

  it('上げる途中、前脚は前（−Z）へ、主脚は後ろ（+Z）へ振れる', () => {
    const { model, legs } = syntheticModel()
    createAircraftView(model).setGear(0.5)
    expect(footOf(legs.get('nose')!).z, '前脚').toBeLessThan(-0.5)
    expect(footOf(legs.get('left')!).z, '左主脚').toBeGreaterThan(0.5)
    expect(footOf(legs.get('right')!).z, '右主脚').toBeGreaterThan(0.5)
    // 横には振れない（軸は横向き）
    for (const [leg, node] of legs) expect(Math.abs(footOf(node).x), leg).toBeLessThan(1e-9)
  })

  it('上げ切り（0）で 90 度畳まれ、脚ごと隠れる', () => {
    const { model, legs } = syntheticModel()
    createAircraftView(model).setGear(0)
    expect(model.gear!.visible).toBe(false)
    for (const [leg, node] of legs) {
      expect(footOf(node).y, `${leg} が水平まで畳まれていない`).toBeCloseTo(0, 6)
    }
  })
})

/**
 * `setHook` がフックを下ろす（段 8）。**描画の回転と sim の先端の位置が同じ向きに動く。**
 * 軸は glb の定義（`extras.hook.axis` の (−1, 0, 0)、正の角で収納の向き）を手で置く
 */
describe('setHook', () => {
  function hookModel(): { model: AircraftModel; hook: THREE.Object3D } {
    const { model } = syntheticModel()
    const hook = new THREE.Object3D()
    model.object.add(hook)
    return { model: { ...model, hook }, hook }
  }

  it('0 では回転 0（原本の収納の姿勢）', () => {
    const { model, hook } = hookModel()
    createAircraftView(model).setHook(0)
    expect(hook.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9)
  })

  it('下ろし切り（68 度）で、先端は sim の `hookPointBody` と同じ位置へ行く', () => {
    const { model, hook } = hookModel()
    createAircraftView(model).setHook(HOOK_DOWN_ANGLE)
    const [y, z] = HOOK_POINT_STOWED
    const drawn = new THREE.Vector3(0, y, z).applyQuaternion(hook.quaternion)
    const sim = hookPointBody(HOOK_DOWN_ANGLE, new Vec3())
    expect(drawn.y + HOOK_PIVOT[1]).toBeCloseTo(sim.y, 9)
    expect(drawn.z + HOOK_PIVOT[2]).toBeCloseTo(sim.z, 9)
    // 下へ振れている（付け根より 1.4 m 以上下）
    expect(drawn.y).toBeLessThan(-1.4)
  })

  it('フックの無い機体は何もしない', () => {
    const { model } = syntheticModel()
    expect(() => createAircraftView(model).setHook(1)).not.toThrow()
  })
})
