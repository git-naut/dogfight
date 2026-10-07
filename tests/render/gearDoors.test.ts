import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createAircraftView } from '@render/aircraftView'
import type { AircraftModel } from '@render/aircraft/model'

/**
 * 脚の扉の開き方（2026-10-08）。**脚の位置の最初の 20% で扉が開き、残りで脚が動く。**
 * 作り物のモデルで見る（glb は生成物で、歯型の作業場には無い）
 */
function model(): { m: AircraftModel; nose: THREE.Object3D; main: THREE.Object3D; leg: THREE.Object3D } {
  const object = new THREE.Object3D()
  const gear = new THREE.Object3D()
  object.add(gear)
  const leg = new THREE.Object3D()
  gear.add(leg)
  const nose = new THREE.Object3D()
  const main = new THREE.Object3D()
  object.add(nose, main)
  const m: AircraftModel = {
    object,
    nozzles: [],
    gear,
    gearLegs: [{ object: leg, axis: new THREE.Vector3(1, 0, 0), retractRad: Math.PI / 2 }],
    hook: null,
    doors: [
      { object: nose, axis: new THREE.Vector3(0, 0, 1), hideWhenClosed: false },
      { object: main, axis: new THREE.Vector3(0, 0, 1), hideWhenClosed: true },
    ],
    doorTiming: { share: 0.2, openRad: Math.PI / 2 },
    surfaces: new Map(),
    hinges: [],
    triangles: 0,
    dispose() {},
  }
  return { m, nose, main, leg }
}

const deg = (o: THREE.Object3D) => (o.quaternion.angleTo(new THREE.Quaternion()) * 180) / Math.PI

describe('setGear と扉', () => {
  it('上げ切り（0）: 扉は閉じ、前脚の扉は見せて主脚の扉は隠す。脚も隠す', () => {
    const { m, nose, main } = model()
    createAircraftView(m).setGear(0)
    expect(deg(nose)).toBeCloseTo(0, 9)
    expect(nose.visible).toBe(true)
    expect(main.visible).toBe(false)
    expect(m.gear!.visible).toBe(false)
  })

  it('0.1: 扉が半分（45 度）開き、脚はまだ畳まれたまま隠れている', () => {
    const { m, nose, main, leg } = model()
    createAircraftView(m).setGear(0.1)
    expect(deg(nose)).toBeCloseTo(45, 6)
    expect(main.visible).toBe(true)
    expect(deg(leg)).toBeCloseTo(90, 6)
    expect(m.gear!.visible).toBe(false)
  })

  it('0.6: 扉は開き切り、脚は半分（45 度）', () => {
    const { m, nose, leg } = model()
    createAircraftView(m).setGear(0.6)
    expect(deg(nose)).toBeCloseTo(90, 6)
    expect(deg(leg)).toBeCloseTo(45, 6)
    expect(m.gear!.visible).toBe(true)
  })

  it('出し切り（1）: 扉は開いたまま、脚の回転は 0（出し切りの絵は扉を足す前と同じ）', () => {
    const { m, nose, leg } = model()
    createAircraftView(m).setGear(1)
    expect(deg(nose)).toBeCloseTo(90, 6)
    expect(deg(leg)).toBeCloseTo(0, 9)
  })
})
