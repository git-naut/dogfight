import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { AircraftSample } from '@sim/aircraft'
import { createChaseCamera } from '../../src/render/camera'

/**
 * 追従カメラ（2026-10-02）。**ライブの絵はキャプチャと違う道を通る。**キャプチャは
 * `snap` で定位置に置き、ライブは `update` で遅れて追う。基準画像はライブの遅れを
 * 1 度も写さないので、遅れの性質はここで見る。
 *
 * 期待値は定数から作らず、測った数で書く（定数を壊したときに一緒に動かないように）
 */
const LOOK = { yaw: 0, pitch: 0 }
const HALF_SPAN = 6.7

function sampleAt(speed: number): AircraftSample {
  return {
    position: { x: 0, y: 2000, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    speed,
  } as unknown as AircraftSample
}

/** 機首 −Z へ等速で 3 秒飛ばし、カメラとの距離と、翼幅の画面の幅に対する割合を返す */
function flyStraight(speed: number, fps = 60): { distance: number; span: number; fov: number } {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 5, 100000)
  const chase = createChaseCamera(camera)
  const sample = sampleAt(speed)
  chase.snap(sample, LOOK)
  const dt = 1 / fps
  for (let i = 0; i < fps * 3; i++) {
    ;(sample.position as { z: number }).z -= speed * dt
    chase.update(sample, dt, LOOK)
  }
  const craft = new THREE.Vector3(sample.position.x, sample.position.y, sample.position.z)
  camera.updateMatrixWorld()
  const left = craft.clone().add(new THREE.Vector3(-HALF_SPAN, 0, 0)).project(camera)
  const right = craft.clone().add(new THREE.Vector3(HALF_SPAN, 0, 0)).project(camera)
  return { distance: camera.position.distanceTo(craft), span: (right.x - left.x) / 2, fov: camera.fov }
}

describe('追従カメラ', () => {
  it.each([60, 120])('%i fps で、速く飛んでもカメラが後ろに取り残されない', (fps) => {
    // 世界の位置を指数ラグで追っていたときは、250 m/s で 36.1 m、320 m/s で 41.8 m に伸びた
    for (const speed of [150, 250, 320]) {
      const { distance } = flyStraight(speed, fps)
      // 定位置は後方 19.5 m・上 3.8 m（距離 19.9 m）
      expect(distance, `${speed} m/s`).toBeGreaterThan(19.5)
      expect(distance, `${speed} m/s`).toBeLessThan(20.3)
    }
  })

  it('速いほど画角が狭まり、機体が大きく写る', () => {
    const slow = flyStraight(150)
    const cruise = flyStraight(250)
    const fast = flyStraight(350)
    expect(slow.fov).toBeCloseTo(50, 5)
    expect(fast.fov).toBeCloseTo(42, 5)
    expect(cruise.span).toBeGreaterThan(slow.span)
    expect(fast.span).toBeGreaterThan(cruise.span)
    // 150→350 m/s で 41.1% → 49.9%（1.21 倍）。0〜420 m/s に掛けていたころは 1.14 倍で、
    // 近づいて見えなかった
    expect(fast.span / slow.span).toBeGreaterThan(1.18)
    // 大きすぎない（15.5 m・50→36° では 51.8% と 74.3% で、大きすぎると言われた）
    expect(slow.span).toBeLessThan(0.45)
    expect(fast.span).toBeLessThan(0.55)
  })

  it('旋回では向きの遅れが残る', () => {
    // 遅れを向きにだけ掛けたので、旋回で機体の後ろから少し外れる手応えは残る
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 5, 100000)
    const chase = createChaseCamera(camera)
    const sample = sampleAt(250)
    chase.snap(sample, LOOK)
    const yawRate = 0.5
    const dt = 1 / 60
    for (let i = 1; i <= 60; i++) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRate * i * dt)
      ;(sample as { orientation: object }).orientation = { x: q.x, y: q.y, z: q.z, w: q.w }
      chase.update(sample, dt, LOOK)
    }
    const behind = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRate)
    const actual = camera.position.clone().sub(new THREE.Vector3(0, 2000, 0)).setY(0).normalize()
    // 定位置から 2 度以上ずれる（0.09 秒の遅れ × 0.5 rad/s ≈ 2.6 度）
    expect(THREE.MathUtils.radToDeg(actual.angleTo(behind))).toBeGreaterThan(2)
  })
})
