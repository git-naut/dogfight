import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createMissileFlames, LAUNCH_FLASH_SECONDS, type MissileFlameSource } from '../../src/render/weapons/missileFlames'
import { getQuality } from '../../src/render/quality'

/**
 * ミサイルの発射炎と炎の尾（段 B9、ADR 0034）。録画（lesson 5 のコマ 20022）は撃った瞬間に 1 コマだけ
 * 光る。合意した幅は 2 コマ以内。炎の尾はモーターが燃えているあいだ
 */

// カメラは自機の後ろ上方。ミサイルはその前方 25 m を前（−Z）へ飛ぶ
const camera = new THREE.Vector3(0, 5.55, 24.2)
const forward = new THREE.Vector3(0, -5.55, -24.2).normalize()

function missile(age: number, burning: boolean): MissileFlameSource {
  return { position: new THREE.Vector3(-2.29, -0.26, 0.41), quaternion: new THREE.Quaternion(), age, burning }
}

describe('ミサイルの発射炎と炎の尾', () => {
  it('発射炎は 2 コマ（2/30 秒）以内だけ出る', () => {
    expect(LAUNCH_FLASH_SECONDS).toBeLessThanOrEqual(2 / 30)
    const flames = createMissileFlames(4, getQuality('high'))
    flames.update([missile(0, true)], camera, forward)
    expect(flames.flashesDrawn).toBe(1)
    flames.update([missile(LAUNCH_FLASH_SECONDS / 2, true)], camera, forward)
    expect(flames.flashesDrawn).toBe(1)
    flames.update([missile(LAUNCH_FLASH_SECONDS + 1 / 120, true)], camera, forward)
    expect(flames.flashesDrawn).toBe(0)
  })

  it('炎の尾はモーターが燃えているあいだだけ出る', () => {
    const flames = createMissileFlames(4, getQuality('high'))
    flames.update([missile(0.2, true)], camera, forward)
    expect(flames.flamesDrawn).toBe(1)
    flames.update([missile(3, false)], camera, forward)
    expect(flames.flamesDrawn).toBe(0)
  })

  it('飛んでいるミサイルが無くなれば全部の板を隠す', () => {
    const flames = createMissileFlames(4, getQuality('high'))
    flames.update([missile(0, true)], camera, forward)
    flames.update([], camera, forward)
    const meshes = flames.object.children.filter((c) => c instanceof THREE.Mesh)
    expect(meshes.some((m) => m.visible)).toBe(false)
  })

  it('先に組むときは 1 発ぶんの全部の板を見せ、空の列で更新すると隠す', () => {
    const quality = getQuality('high')
    const flames = createMissileFlames(4, quality)
    flames.prewarm(camera, forward)
    const visible = flames.object.children.filter((c) => c instanceof THREE.Mesh && c.visible)
    expect(visible.length).toBe(quality.missileFlameSprites)
    flames.update([], camera, forward)
    expect(flames.object.children.some((c) => c.visible)).toBe(false)
  })

  it('low では描かない（プリセットの列が 0）', () => {
    const flames = createMissileFlames(4, getQuality('low'))
    flames.update([missile(0, true)], camera, forward)
    expect(flames.flashesDrawn).toBe(0)
    expect(flames.flamesDrawn).toBe(0)
  })
})
