import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { HAZE_IDLE, computeHeatHaze, createHeatHazeState, hazeStrength } from '../../src/render/heatHaze'

/** 陽炎の範囲と強さ（ADR 0041） */
describe('陽炎', () => {
  it('強さはアイドルで 0.3、全開で 1、間はスロットルとともに上がる', () => {
    expect(hazeStrength(0)).toBeCloseTo(HAZE_IDLE, 9)
    expect(hazeStrength(1)).toBeCloseTo(1, 9)
    let last = 0
    for (let t = 0; t <= 1; t += 0.05) {
      expect(hazeStrength(t)).toBeGreaterThanOrEqual(last)
      last = hazeStrength(t)
    }
  })

  // 自機は原点、機首 −Z。カメラは後ろ上方（追従カメラと同じ 24.2 m 後ろ・5.55 m 上）
  function setup() {
    const object = new THREE.Object3D()
    object.updateMatrixWorld()
    const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 30000)
    camera.position.set(0, 5.55, 24.2)
    camera.lookAt(0, 0, -60)
    camera.updateMatrixWorld()
    const nozzles = [
      { position: [-0.55, 0, 7.5] as [number, number, number], radius: 0.45 },
      { position: [0.55, 0, 7.5] as [number, number, number], radius: 0.45 },
    ]
    return { object, camera, nozzles }
  }

  it('範囲は排気口から後ろ（カメラの側、画面の下）へ伸び、終わりのほうが太い', () => {
    const { object, camera, nozzles } = setup()
    const s = computeHeatHaze(nozzles, object, camera, 1, createHeatHazeState())
    expect(s.strength).toBeCloseTo(1, 9)
    // 後ろ上方から見下ろすので、後ろへ伸びる範囲は画面の下へ向かう
    expect(s.endY).toBeLessThan(s.startY)
    expect(Math.abs(s.startX)).toBeLessThan(0.01)
    expect(s.endRadius).toBeGreaterThan(s.startRadius)
  })

  it('範囲がカメラの後ろへ出たら揺らさない', () => {
    const { object, camera, nozzles } = setup()
    // カメラを機体の前へ回し、後ろ向きに機首を見る（範囲の終わりはカメラの後ろ 8 m の先）
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, -100)
    camera.updateMatrixWorld()
    const s = computeHeatHaze(nozzles, object, camera, 1, createHeatHazeState())
    expect(s.strength).toBe(0)
  })
})
