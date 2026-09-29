import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createExplosions } from '../../src/render/weapons/explosions'
import { getQuality } from '../../src/render/quality'
import { FIXED_DT } from '../../src/sim/loop'
import { Vec3 } from '../../src/sim/vec3'
import type { Explosion, ExplosionSource } from '../../src/sim/effects'

describe('破片の位置', () => {
  it('爆発の中心から、向き × 速さ × 経過秒の所に置く', () => {
    // **`place()` が中で `scratch` を上書きしていた。**破片の位置を `scratch` に
    // 入れて渡したので「位置 − カメラの位置」に置かれ、2026-08-21 の最初の実装から
    // 破片は 1 度も画面に出ていなかった（段 29e で見つけた）
    const e: Explosion = {
      position: new Vec3(0, 1000, -300),
      velocity: new Vec3(0, 0, 0),
      strength: 1,
      frame: 100,
      shards: [{ direction: new Vec3(1, 0, 0), speed: 50 }],
    }
    const source: ExplosionSource = { length: 1, explosionAt: () => e }
    const ex = createExplosions(1, getQuality('high'), undefined, null)
    const camera = new THREE.Vector3(0, 1000, 0)
    const frame = 112
    ex.update(source, frame, camera, new THREE.Vector3(0, 0, -1))
    const age = (frame - e.frame) * FIXED_DT
    const expected = [50 * age, 1000, -300]
    // 破片の板は 12 枚とも同じ向き（向きが 1 つしか無いので先頭を繰り返す）
    const shards = ex.object.children.filter(
      (m) => m.visible && Math.abs(m.position.x - expected[0]!) < 1e-6,
    )
    expect(shards.length, '爆発の中心から向き × 速さ × 経過秒の所に破片が無い').toBeGreaterThan(0)
    expect(shards[0]!.position.y).toBeCloseTo(expected[1]!)
    expect(shards[0]!.position.z).toBeCloseTo(expected[2]!)
  })
})
