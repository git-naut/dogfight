import { describe, expect, it } from 'vitest'
import { DOPPLER_MAX, DOPPLER_MIN, dopplerRate, toListenerLocal } from '../../src/audio/spatial'
import { Quat } from '../../src/sim/quat'
import { Vec3 } from '../../src/sim/vec3'

/** 立体の音とドップラー（段 B11d、ADR 0040） */
describe('立体の音', () => {
  it('機首が −Z のままなら、右の音源は右（+x）、前の音源は前（−z）', () => {
    const q = new Quat()
    const r = toListenerLocal({ x: 200, y: 0, z: 0 }, q, { x: 0, y: 0, z: 0 })
    expect(r.x).toBeCloseTo(200, 9)
    const f = toListenerLocal({ x: 0, y: 0, z: -500 }, q, { x: 0, y: 0, z: 0 })
    expect(f.z).toBeCloseTo(-500, 9)
  })

  it('右へ 90 度向いたら、世界の −Z（もとの前）は自機の左（−x）', () => {
    // 右旋回 = Y 軸まわりに −90 度
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), -Math.PI / 2)
    const r = toListenerLocal({ x: 0, y: 0, z: -500 }, q, { x: 0, y: 0, z: 0 })
    expect(r.x).toBeCloseTo(-500, 6)
    expect(Math.abs(r.z)).toBeLessThan(1e-6)
  })
})

describe('ドップラー', () => {
  it('近づくと高く、遠ざかると低い。0.7〜1.4 で止める', () => {
    const ahead = { x: 0, y: 0, z: -1000 }
    // 音源が自機へ向かって 50 m/s で近づく: 343 / 293
    expect(dopplerRate(ahead, { x: 0, y: 0, z: 50 })).toBeCloseTo(343 / 293, 9)
    // 50 m/s で遠ざかる: 343 / 393
    expect(dopplerRate(ahead, { x: 0, y: 0, z: -50 })).toBeCloseTo(343 / 393, 9)
    expect(dopplerRate(ahead, { x: 0, y: 0, z: 300 })).toBe(DOPPLER_MAX)
    expect(dopplerRate(ahead, { x: 0, y: 0, z: -300 })).toBe(DOPPLER_MIN)
    // 横切るだけなら変えない
    expect(dopplerRate(ahead, { x: 300, y: 0, z: 0 })).toBeCloseTo(1, 9)
  })
})
