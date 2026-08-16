import { describe, it, expect } from 'vitest'
import { Vec3 } from '@sim/vec3'

describe('Vec3', () => {
  it('addScaledVector は this += v * s になる', () => {
    const p = new Vec3(1, 2, 3)
    const v = new Vec3(10, 0, -10)
    p.addScaledVector(v, 0.5)
    expect(p.approxEquals(new Vec3(6, 2, -2))).toBe(true)
  })

  it('normalize は長さを 1 にする', () => {
    const v = new Vec3(3, 4, 0).normalize()
    expect(v.length()).toBeCloseTo(1, 12)
  })

  it('ゼロベクトルの normalize は NaN を出さない', () => {
    const v = new Vec3(0, 0, 0).normalize()
    expect(v.isFinite()).toBe(true)
    expect(v.length()).toBe(0)
  })

  it('crossVectors は右手系になる（X × Y = Z）', () => {
    const out = new Vec3().crossVectors(new Vec3(1, 0, 0), new Vec3(0, 1, 0))
    expect(out.approxEquals(new Vec3(0, 0, 1))).toBe(true)
  })

  it('crossVectors は自分自身を引数に渡しても正しい', () => {
    const a = new Vec3(1, 0, 0)
    const b = new Vec3(0, 1, 0)
    a.crossVectors(a, b)
    expect(a.approxEquals(new Vec3(0, 0, 1))).toBe(true)
  })

  it('clampLength は上限を超えた分だけ縮める', () => {
    const v = new Vec3(0, 100, 0).clampLength(25)
    expect(v.length()).toBeCloseTo(25, 12)

    const short = new Vec3(0, 3, 0).clampLength(25)
    expect(short.length()).toBeCloseTo(3, 12)
  })

  it('lerp は t=0 で元の値、t=1 で目標値になる', () => {
    const from = new Vec3(0, 0, 0)
    const to = new Vec3(10, 20, 30)

    expect(from.clone().lerp(to, 0).approxEquals(new Vec3(0, 0, 0))).toBe(true)
    expect(from.clone().lerp(to, 1).approxEquals(to)).toBe(true)
    expect(from.clone().lerp(to, 0.5).approxEquals(new Vec3(5, 10, 15))).toBe(true)
  })

  it('dot は直交で 0、同方向で長さの積になる', () => {
    expect(new Vec3(1, 0, 0).dot(new Vec3(0, 1, 0))).toBe(0)
    expect(new Vec3(0, 2, 0).dot(new Vec3(0, 3, 0))).toBe(6)
  })

  it('clone は独立した実体を返す', () => {
    const a = new Vec3(1, 2, 3)
    const b = a.clone()
    b.set(9, 9, 9)
    expect(a.approxEquals(new Vec3(1, 2, 3))).toBe(true)
  })

  it('座標系の定数が CLAUDE.md の規約と一致する（Y up、機首 -Z）', () => {
    expect(Vec3.UP.toArray()).toEqual([0, 1, 0])
    expect(Vec3.FORWARD.toArray()).toEqual([0, 0, -1])
    expect(Vec3.RIGHT.toArray()).toEqual([1, 0, 0])
  })
})
