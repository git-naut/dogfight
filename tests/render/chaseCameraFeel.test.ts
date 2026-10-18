import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import { createAircraftSample } from '@sim/aircraft'
import { createChaseCamera } from '../../src/render/camera'

/**
 * 追従カメラの手触り（Phase 10 の段 B4、録画に合わせた）。sim の機体を飛ばし、このカメラで
 * 機体を画面（1920x1080）に投影して測る。録画は ACE COMBAT 7 の講座 lesson 2 の実測で、
 * `~/.claude/plans/dogfight-ac7-ref/measure/l2_summary.json`。
 *
 * 期待値は定数から作らず、測った数で書く（定数を壊したときに一緒に動かないように）
 */
const HZ = 120
const LOOK = { yaw: 0, pitch: 0 }

interface Probe {
  /** 時刻 秒（入力を入れてから）、画面上の機体の傾き 度、入力の前からのずれ 画素 */
  rows: { t: number; tilt: number; dx: number; dy: number }[]
}

function fly(input: Record<string, number>, holdSeconds: number): Probe {
  const script = {
    name: 'camera-probe',
    seed: 1,
    spawn: { altitude: 3000, speed: 250 },
    keyframes: [
      { frame: HZ, input },
      { frame: HZ + Math.round(holdSeconds * HZ), input: { roll: 0, pitch: 0, yaw: 0 } },
    ],
  }
  const { world, player } = createWorldFromScript(script as never)
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 5, 100000)
  const chase = createChaseCamera(camera)
  const s = createAircraftSample()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const bodyUp = new THREE.Vector3()
  const rows: Probe['rows'] = []
  let base: [number, number] | null = null
  for (let f = 0; f < 5 * HZ; f++) {
    world.step(player.at(f, world.player))
    if (f % 2 === 0) continue
    world.player.sample(1, s)
    chase.update(s, 2 / HZ, LOOK)
    camera.updateMatrixWorld()
    p.set(s.position.x, s.position.y, s.position.z).project(camera)
    const px = (p.x * 0.5 + 0.5) * 1920
    const py = (-p.y * 0.5 + 0.5) * 1080
    right.setFromMatrixColumn(camera.matrixWorld, 0)
    up.setFromMatrixColumn(camera.matrixWorld, 1)
    q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w)
    bodyUp.set(0, 1, 0).applyQuaternion(q)
    const tilt = THREE.MathUtils.radToDeg(Math.atan2(bodyUp.dot(right), bodyUp.dot(up)))
    if (f === HZ - 1) base = [px, py]
    if (base) rows.push({ t: (f + 1 - HZ) / HZ, tilt, dx: px - base[0], dy: py - base[1] })
  }
  return { rows }
}

describe('追従カメラの手触り（録画に合わせた）', () => {
  it('ロールを続けても、機体の画面上の傾きは 8〜11.5 度で頭打ちになる（段 B3 までは 31.6 度）', () => {
    const { rows } = fly({ roll: -1 }, 1.0)
    const peak = Math.max(...rows.map((r) => Math.abs(r.tilt)))
    expect(peak).toBeGreaterThanOrEqual(8)
    expect(peak).toBeLessThanOrEqual(11.5)
  })

  it('ロールをやめると水平へ戻り、行き過ぎは 2 度以内', () => {
    const { rows } = fly({ roll: -1 }, 0.4)
    // 左へ回したので傾きは負。戻ったあとの正の側の行き過ぎを見る
    const overshoot = Math.max(...rows.filter((r) => r.t > 0.6).map((r) => r.tilt))
    expect(overshoot).toBeGreaterThan(0.3)
    expect(overshoot).toBeLessThanOrEqual(2)
    // 2.5 秒後には 0.5 度以内に落ち着く
    const last = rows.filter((r) => r.t > 2.5)
    expect(Math.max(...last.map((r) => Math.abs(r.tilt)))).toBeLessThan(0.5)
  })

  it('引くと機体が画面の下へ 50〜70 画素ずれる（段 B3 までは 11 画素）', () => {
    const { rows } = fly({ pitch: 1 }, 2.0)
    const peak = Math.max(...rows.map((r) => r.dy))
    expect(peak).toBeGreaterThanOrEqual(50)
    expect(peak).toBeLessThanOrEqual(70)
    // 0.8 秒で最大の 8 割以上（録画は約 0.8 秒で最大）
    const at08 = rows.find((r) => r.t >= 0.8)!.dy
    expect(at08 / peak).toBeGreaterThan(0.8)
  })

  it('ヨーで機体が横へ 25〜45 画素ずれる（録画 38〜44 画素、段 B3 までは 7 画素）', () => {
    const { rows } = fly({ yaw: -1 }, 2.0)
    const peak = Math.max(...rows.map((r) => Math.abs(r.dx)))
    expect(peak).toBeGreaterThanOrEqual(25)
    expect(peak).toBeLessThanOrEqual(45)
  })
})
