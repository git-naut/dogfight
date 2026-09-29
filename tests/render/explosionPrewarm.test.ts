import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createExplosions } from '../../src/render/weapons/explosions'
import { createExplosionTrails } from '../../src/render/weapons/explosionTrails'
import type { FireballSprite } from '../../src/render/weapons/fireballNodes'
import { getQuality } from '../../src/render/quality'

const none = {
  length: 0,
  explosionAt: () => {
    throw new Error('爆発は無い')
  },
}

function fakeFireball(): FireballSprite {
  return {
    material: new THREE.MeshBasicMaterial(),
    fireMaterial: new THREE.MeshBasicMaterial(),
    setState() {},
  }
}

describe('爆発の材質を先に組む', () => {
  // **材質は初めて描くときに組まれる。**実機で最初の撃墜の 0.55 秒後に 0.4〜0.55 秒
  // 止まった（段 29 の締め）。起動時に全部の板を 1 度描く
  const camera = new THREE.Vector3(0, 1000, 0)
  const forward = new THREE.Vector3(0, 0, -1)

  it('全部の板を見える状態にし、空の源で更新すると全部隠す', () => {
    const quality = getQuality('high')
    const ex = createExplosions(8, quality, undefined, fakeFireball)
    ex.prewarm(camera, forward)
    const meshes = ex.object.children.filter((c) => c instanceof THREE.Mesh)
    // 白い芯・赤い芯・外側の炎・煙・破片 12・主の火の玉 2 層・子 4 個 × 2 層
    expect(meshes.length).toBe(4 + quality.explosionSprites + 2 + quality.explosionBlobs * 2)
    expect(meshes.every((m) => m.visible), '見えていない板は命令が組まれない').toBe(true)
    ex.update(none, 0, camera, forward)
    expect(meshes.some((m) => m.visible), '先に組んだあとに板が残った').toBe(false)
  })

  it('尾の帯を 1 本張り、空の源で更新すると外す', () => {
    const trails = createExplosionTrails(8, getQuality('high'))
    trails.prewarm(camera, forward)
    const drawn = () =>
      trails.object.children.filter(
        (c) => c instanceof THREE.Mesh && (c.geometry as THREE.BufferGeometry).drawRange.count > 0,
      ).length
    expect(drawn(), '帯が張られないと描かれず、命令が組まれない').toBe(1)
    trails.update(none, 0, camera, forward)
    expect(drawn()).toBe(0)
  })
})
