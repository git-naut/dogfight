import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import * as THREE from 'three'
import { createAircraftView } from '@render/aircraftView'
import type { AircraftGearLeg, AircraftModel } from '@render/aircraft/model'

/**
 * 脚ごとの動き（Phase 9 の段 6）。
 *
 * **glb の extras から読む。**脚の付け根は `tools/f18e-hinges.mjs` の `buildGearHinges` が
 * 頂点から決め、`tools/f18e-to-glb.mjs` が座標系を回して載せる。出来上がった glb を読み、
 * view の `setGear` を通して、脚が畳む向きへ回ることを確かめる。
 *
 * この作品の座標は機首 −Z、上 +Y、右 +X。前脚は前（−Z）へ、主脚は後ろ（+Z）へ畳む
 */
const extras = (() => {
  const path = fileURLToPath(new URL('../../public/aircraft/f18e.glb', import.meta.url))
  if (!existsSync(path)) throw new Error(`${path} が無い。npm run assets を走らせること`)
  const buf = readFileSync(path)
  const jsonLength = buf.readUInt32LE(12)
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'))
  return gltf.scenes[0].extras as {
    gear: AircraftGearLeg[]
    hook: { node: string; origin: [number, number, number]; axis: [number, number, number] }
  }
})()

/** glb の定義どおりの脚を持つ最小のモデルを作る */
function modelFromGlb(): { model: AircraftModel; legs: Map<string, THREE.Object3D> } {
  const object = new THREE.Object3D()
  const gear = new THREE.Object3D()
  gear.name = 'gear'
  object.add(gear)
  const legs = new Map<string, THREE.Object3D>()
  const gearLegs = extras.gear.map((leg) => {
    const node = new THREE.Object3D()
    node.name = leg.node
    node.position.set(...leg.origin)
    gear.add(node)
    legs.set(leg.leg, node)
    return {
      object: node,
      axis: new THREE.Vector3(...leg.axis).normalize(),
      retractRad: (leg.retractDeg * Math.PI) / 180,
    }
  })
  const model: AircraftModel = {
    object,
    nozzles: [],
    gear,
    gearLegs,
    hook: null,
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

describe('脚の付け根（glb の extras）', () => {
  it('前脚・左主脚・右主脚の 3 本', () => {
    expect(extras.gear.map((g) => g.leg).sort()).toEqual(['left', 'nose', 'right'])
  })

  it('前脚は機首側、主脚は左右に分かれる（右が +X）', () => {
    const at = (leg: string) => extras.gear.find((g) => g.leg === leg)!.origin
    expect(at('nose')[2]).toBeLessThan(-4)
    expect(at('left')[0]).toBeLessThan(-0.3)
    expect(at('right')[0]).toBeGreaterThan(0.3)
    // 付け根は機体の下面より上（脚の部品の最上部）
    for (const g of extras.gear) expect(g.origin[1], g.leg).toBeLessThan(0)
  })

  it('フックは尾部の下に付け根がある', () => {
    expect(extras.hook.node).toBe('Hook')
    expect(extras.hook.origin[2]).toBeGreaterThan(4)
    expect(extras.hook.origin[1]).toBeLessThan(0)
  })
})

describe('setGear', () => {
  it('出し切り（1）では回転 0。出し切りの絵は段 5 までと同じ', () => {
    const { model, legs } = modelFromGlb()
    createAircraftView(model).setGear(1)
    for (const [leg, node] of legs) {
      expect(node.quaternion.angleTo(new THREE.Quaternion()), leg).toBeCloseTo(0, 9)
    }
    expect(model.gear!.visible).toBe(true)
  })

  it('上げる途中、前脚は前（−Z）へ、主脚は後ろ（+Z）へ振れる', () => {
    const { model, legs } = modelFromGlb()
    createAircraftView(model).setGear(0.5)
    expect(footOf(legs.get('nose')!).z, '前脚').toBeLessThan(-0.5)
    expect(footOf(legs.get('left')!).z, '左主脚').toBeGreaterThan(0.5)
    expect(footOf(legs.get('right')!).z, '右主脚').toBeGreaterThan(0.5)
    // 横には振れない（軸は横向き）
    for (const [leg, node] of legs) expect(Math.abs(footOf(node).x), leg).toBeLessThan(1e-9)
  })

  it('上げ切り（0）で 90 度畳まれ、脚ごと隠れる', () => {
    const { model, legs } = modelFromGlb()
    createAircraftView(model).setGear(0)
    expect(model.gear!.visible).toBe(false)
    for (const [leg, node] of legs) {
      expect(footOf(node).y, `${leg} が水平まで畳まれていない`).toBeCloseTo(0, 6)
    }
  })
})
