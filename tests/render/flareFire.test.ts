import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createFlares } from '../../src/render/weapons/flares'
import { getQuality } from '../../src/render/quality'
import { createNodeRadialSprite } from '../../src/render/weapons/spriteNodes'
import { Flare } from '../../src/sim/weapons/flare'
import { Vec3 } from '../../src/sim/vec3'

/**
 * フレアの火（段 B9）。ユーザーの指示で、ミサイルの炎の尾と同じ赤みの橙の火と帯に寄せた。帯は進む向きの
 * 後ろへ伸びる
 */

// カメラは自機の後ろ上方。フレアはその前方 25 m、前（−Z）へ 200 m/s で進む
const camera = new THREE.Vector3(0, 5.55, 24.2)
const forward = new THREE.Vector3(0, -5.55, -24.2).normalize()

function burning(): Flare {
  const flare = new Flare()
  flare.ignite(new Vec3(0, -1, 0), new Vec3(0, 0, -200), new Vec3(0, 0, 0))
  // 点火の閃光が過ぎるまで進める
  for (let i = 0; i < 60; i++) flare.step(1 / 120)
  return flare
}

describe('フレアの火', () => {
  it('帯は進む向きの後ろへ伸びる', () => {
    const flares = createFlares(4, getQuality('high'), createNodeRadialSprite)
    const flare = burning()
    flares.update([flare], camera, forward)
    expect(flares.drawn).toBe(1)
    // 帯は縦に伸ばした板（scale.y が長さ、scale.x が太さ）。長さが太さより大きい板が帯
    const bands = flares.object.children.filter(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.visible && c.scale.y > c.scale.x * 2,
    )
    expect(bands.length).toBe(3)
    const fire = new THREE.Vector3(flare.position.x, flare.position.y, flare.position.z)
    const velocity = new THREE.Vector3(flare.velocity.x, flare.velocity.y, flare.velocity.z)
    for (const band of bands) {
      const offset = band.position.clone().sub(fire)
      expect(offset.dot(velocity), '帯の中心が火より前にある').toBeLessThan(0)
    }
  })

  it('先に組むときは 1 発ぶんの全部の板を見せ、空の列で更新すると隠す', () => {
    const flares = createFlares(4, getQuality('high'), createNodeRadialSprite)
    flares.prewarm(camera, forward)
    const visible = flares.object.children.filter((c) => c instanceof THREE.Mesh && c.visible)
    // 煙・暈・芯・白い芯・帯 3 層
    expect(visible.length).toBe(7)
    flares.update([], camera, forward)
    expect(flares.object.children.some((c) => c.visible)).toBe(false)
  })
})
