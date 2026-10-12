import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createAircraftView } from '@render/aircraftView'
import type { AircraftModel } from '@render/aircraft/model'

/**
 * 脚の扉の開き方（2026-10-12）。**両端の 15% ずつで扉が開閉し、間で脚が動く。**上げるときも
 * 下ろすときも「開く→脚が動く→閉じる」になる。作り物のモデルで見る（glb は生成物で、歯型の
 * 作業場には無い）
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
    doorTiming: { share: 0.15, openRad: Math.PI / 2 },
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

  it('0.075: 扉が半分（45 度）開き、脚はまだ畳まれたまま隠れている', () => {
    const { m, nose, main, leg } = model()
    createAircraftView(m).setGear(0.075)
    expect(deg(nose)).toBeCloseTo(45, 6)
    expect(main.visible).toBe(true)
    expect(deg(leg)).toBeCloseTo(90, 6)
    expect(m.gear!.visible).toBe(false)
  })

  it('0.5: 扉は開き切り、脚は半分（45 度）', () => {
    const { m, nose, leg } = model()
    createAircraftView(m).setGear(0.5)
    expect(deg(nose)).toBeCloseTo(90, 6)
    expect(deg(leg)).toBeCloseTo(45, 6)
    expect(m.gear!.visible).toBe(true)
  })

  it('0.925: 脚は出し切り、扉は半分まで閉じている', () => {
    const { m, nose, leg } = model()
    createAircraftView(m).setGear(0.925)
    expect(deg(leg)).toBeCloseTo(0, 9)
    expect(deg(nose)).toBeCloseTo(45, 6)
  })

  /**
   * **出し切りでも扉は閉じる**（2026-10-12）。2026-10-08 の版は開いたままで、「開いて閉じる」に
   * 見えなかった。主脚の扉は閉じたら隠す
   */
  it('出し切り（1）: 扉は閉じ、脚の回転は 0', () => {
    const { m, nose, main, leg } = model()
    createAircraftView(m).setGear(1)
    expect(deg(nose)).toBeCloseTo(0, 9)
    expect(main.visible).toBe(false)
    expect(deg(leg)).toBeCloseTo(0, 9)
    expect(m.gear!.visible).toBe(true)
  })

  it('上げと下ろしで同じ順（位置だけで決まる）。途中のどこでも、脚が動くあいだは扉が開き切っている', () => {
    const { m, nose, leg } = model()
    const view = createAircraftView(m)
    for (let i = 0; i <= 100; i++) {
      const p = i / 100
      view.setGear(p)
      const moving = deg(leg) > 1e-6 && deg(leg) < 90 - 1e-6
      if (moving) expect(deg(nose), `位置 ${p}`).toBeCloseTo(90, 6)
    }
  })
})
