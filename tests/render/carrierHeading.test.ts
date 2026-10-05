import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { placeCarrier, type Carrier } from '@render/carrier'
import { radarPoint } from '@hud/radar'

/**
 * 空母の向きの約束（Phase 9 の段 1）。**heading は右回りが正**で、描画・射出・レーダーが
 * 同じ向きに回ること。
 *
 * 段 1 までは描画（`placeCarrier`）と射出（`catapultLaunch`）が three の Ry と同じ左回りで、
 * レーダーの空母の枠（右回り）と逆だった。heading ≠ 0 の台本は `carrier-deck` だけで、HUD を
 * 出さないので表に出ていなかった
 */
const HEADINGS = [0, 0.35, -0.35, Math.PI / 2, -2.5, 3]

function carrierAt(heading: number): THREE.Object3D {
  const carrier: Carrier = { object: new THREE.Object3D(), triangles: 0, dispose() {} }
  placeCarrier(carrier, 0, 0, heading)
  carrier.object.updateMatrixWorld()
  return carrier.object
}

describe('空母の向き', () => {
  it.each(HEADINGS)('heading %f で、描画の艦首が (sin h, −cos h) を向く', (h) => {
    // 艦首は機体座標の −Z
    const bow = new THREE.Vector3(0, 0, -1).transformDirection(carrierAt(h).matrixWorld)
    expect(bow.x).toBeCloseTo(Math.sin(h), 9)
    expect(bow.y).toBeCloseTo(0, 9)
    expect(bow.z).toBeCloseTo(-Math.cos(h), 9)
  })

  it.each(HEADINGS)('heading %f で、レーダーの空母の枠の向きが艦首の向きと一致する', (h) => {
    // 北を向いた自機から、空母の艦首の先 1,000 m の点を見る
    const bow = new THREE.Vector3(0, 0, -1).transformDirection(carrierAt(h).matrixWorld)
    const p = radarPoint(bow.x * 1000, bow.z * 1000, 0)
    const length = Math.hypot(p.x, p.y)
    // hud.ts は枠を canvas の rotate(k.heading − 自機の heading) で回す。(0, −1) は
    // (sin θ, −cos θ) へ写るので、艦首の点の方向と同じでなければならない
    expect(p.x / length).toBeCloseTo(Math.sin(h), 9)
    expect(p.y / length).toBeCloseTo(-Math.cos(h), 9)
  })
})
