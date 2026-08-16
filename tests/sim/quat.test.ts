import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'

/**
 * three.js の Quaternion を正解として突き合わせる。
 *
 * sim 層のコードは three に依存しないが、テストからは import してよい。
 * 自前実装の回転規約が three とずれていると、render 層へ写した瞬間に
 * 姿勢が壊れる。そのずれをここで潰す。
 */

const toThreeQ = (q: Quat) => new THREE.Quaternion(q.x, q.y, q.z, q.w)
const toThreeV = (v: Vec3) => new THREE.Vector3(v.x, v.y, v.z)

function expectQuatMatches(mine: Quat, theirs: THREE.Quaternion, eps = 1e-12) {
  expect(Math.abs(mine.x - theirs.x)).toBeLessThan(eps)
  expect(Math.abs(mine.y - theirs.y)).toBeLessThan(eps)
  expect(Math.abs(mine.z - theirs.z)).toBeLessThan(eps)
  expect(Math.abs(mine.w - theirs.w)).toBeLessThan(eps)
}

function expectVecMatches(mine: Vec3, theirs: THREE.Vector3, eps = 1e-12) {
  expect(Math.abs(mine.x - theirs.x)).toBeLessThan(eps)
  expect(Math.abs(mine.y - theirs.y)).toBeLessThan(eps)
  expect(Math.abs(mine.z - theirs.z)).toBeLessThan(eps)
}

const AXES: ReadonlyArray<readonly [string, Vec3]> = [
  ['X', new Vec3(1, 0, 0)],
  ['Y', new Vec3(0, 1, 0)],
  ['Z', new Vec3(0, 0, 1)],
  ['斜め', new Vec3(1, 2, -3).normalize()],
]

const ANGLES = [0, 0.1, Math.PI / 4, Math.PI / 2, 2.5, Math.PI - 0.01]

describe('Quat', () => {
  it('既定値は単位元', () => {
    const q = new Quat()
    expect(q.toArray()).toEqual([0, 0, 0, 1])
    expect(q.length()).toBe(1)
  })

  it.each(AXES.map(([n, a]) => [n, a] as const))(
    'setFromAxisAngle が three と一致する（%s 軸）',
    (_name, axis) => {
      for (const angle of ANGLES) {
        const mine = new Quat().setFromAxisAngle(axis, angle)
        const theirs = new THREE.Quaternion().setFromAxisAngle(toThreeV(axis), angle)
        expectQuatMatches(mine, theirs)
      }
    },
  )

  it('multiply の合成順序が three と一致する', () => {
    const a = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), 0.7)
    const b = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), -1.1)

    const mine = a.clone().multiply(b)
    const theirs = toThreeQ(a).multiply(toThreeQ(b))
    expectQuatMatches(mine, theirs)
  })

  it('premultiply の合成順序が three と一致する', () => {
    const a = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), 0.7)
    const b = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), -1.1)

    const mine = a.clone().premultiply(b)
    const theirs = toThreeQ(a).premultiply(toThreeQ(b))
    expectQuatMatches(mine, theirs)
  })

  it('rotate が three の applyQuaternion と一致する', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0.3, -0.8, 0.5).normalize(), 1.234)
    const v = new Vec3(3, -4, 5)

    const mine = q.rotate(v)
    const theirs = toThreeV(v).applyQuaternion(toThreeQ(q))
    expectVecMatches(mine, theirs, 1e-12)
  })

  it('rotate は out を省略しても入力を壊さない', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 1.0)
    const v = new Vec3(1, 2, 3)
    q.rotate(v)
    expect(v.approxEquals(new Vec3(1, 2, 3))).toBe(true)
  })

  it('rotate は out に入力と同じ実体を渡しても正しい', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2)
    const v = new Vec3(0, 0, -1)
    q.rotate(v, v)
    expect(v.approxEquals(new Vec3(-1, 0, 0), 1e-12)).toBe(true)
  })

  it('rotateInverse が rotate を打ち消す', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(-0.2, 0.6, 0.77).normalize(), 2.1)
    const v = new Vec3(7, -2, 0.5)
    const back = q.rotateInverse(q.rotate(v))
    expect(back.approxEquals(v, 1e-12)).toBe(true)
  })

  it('単位元では body 軸が座標系の規約どおり（Y up、機首 -Z）', () => {
    const q = new Quat()
    expect(q.forward().approxEquals(new Vec3(0, 0, -1))).toBe(true)
    expect(q.up().approxEquals(new Vec3(0, 1, 0))).toBe(true)
    expect(q.right().approxEquals(new Vec3(1, 0, 0))).toBe(true)
  })

  // 回転の向きの規約。ここがずれると操縦が逆になる。
  it('body 右軸まわりの正回転は機首上げ', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2)
    expect(q.forward().approxEquals(new Vec3(0, 1, 0), 1e-12)).toBe(true)
  })

  it('body 上軸まわりの正回転は左ヨー', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2)
    expect(q.forward().approxEquals(new Vec3(-1, 0, 0), 1e-12)).toBe(true)
  })

  it('機首軸（-Z）まわりの正回転は右ロール', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 0, -1), Math.PI / 2)
    // 右翼が下がる
    expect(q.right().approxEquals(new Vec3(0, -1, 0), 1e-12)).toBe(true)
  })

  it('normalize が長さを 1 に戻す', () => {
    const q = new Quat(0.5, 0.5, 0.5, 0.5).set(1, 2, 3, 4).normalize()
    expect(q.length()).toBeCloseTo(1, 15)
  })

  it('長さゼロの normalize は単位元に倒れる（NaN を出さない）', () => {
    const q = new Quat(0, 0, 0, 0).normalize()
    expect(q.isFinite()).toBe(true)
    expect(q.toArray()).toEqual([0, 0, 0, 1])
  })

  it('invert が逆回転になる', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.9)
    const round = q.clone().multiply(q.clone().invert())
    expect(round.approxEquals(new Quat())).toBe(true)
  })

  it('slerp の端点が一致し、中点が three と一致する', () => {
    const a = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.2)
    const b = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 1.9)

    expect(a.clone().slerp(b, 0).approxEquals(a)).toBe(true)
    expect(a.clone().slerp(b, 1).approxEquals(b)).toBe(true)

    const mine = a.clone().slerp(b, 0.37)
    const theirs = toThreeQ(a).slerp(toThreeQ(b), 0.37)
    expectQuatMatches(mine, theirs, 1e-12)
  })

  it('slerp は遠回りしない（内積が負でも短い方を通る）', () => {
    const a = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.1)
    // 同じ回転を表す符号違い
    const b = new Quat(-a.x, -a.y, -a.z, -a.w)
    const mid = a.clone().slerp(b, 0.5)
    expect(mid.approxEquals(a, 1e-9)).toBe(true)
  })

  it('integrateBodyRate が軸角回転と一致する', () => {
    const omega = new Vec3(0.3, -0.7, 0.2)
    const dt = 0.05
    const mag = omega.length()

    const stepped = new Quat().integrateBodyRate(omega, dt)
    const exact = new Quat().setFromAxisAngle(
      omega.clone().normalize(),
      mag * dt,
    )
    expect(stepped.approxEquals(exact, 1e-12)).toBe(true)
  })

  it('角速度がゼロなら姿勢が変わらない', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.5)
    const before = q.clone()
    q.integrateBodyRate(new Vec3(0, 0, 0), 1 / 120)
    expect(q.approxEquals(before)).toBe(true)
  })

  it('12 万ステップ積分しても長さが 1 から 1e-9 以上ずれない', () => {
    const q = new Quat()
    const omega = new Vec3(0.9, -1.3, 2.1)
    for (let i = 0; i < 120_000; i++) {
      q.integrateBodyRate(omega, 1 / 120)
    }
    expect(q.isFinite()).toBe(true)
    expect(Math.abs(q.length() - 1)).toBeLessThan(1e-9)
  })

  it('body 軸まわりに 4 分の 1 回転を 4 回で元に戻る', () => {
    const q = new Quat()
    const omega = new Vec3(0, Math.PI / 2, 0) // 1 秒で 90 度
    for (let i = 0; i < 4 * 120; i++) {
      q.integrateBodyRate(omega, 1 / 120)
    }
    expect(q.approxEquals(new Quat(), 1e-9)).toBe(true)
  })
})
