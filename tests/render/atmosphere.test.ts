import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'
import { createLocalFrame, dateForHour, DEFAULT_HOUR } from '@render/atmosphere'

/**
 * 局所座標と ECEF の橋渡しを検証する。
 *
 * 大気ライブラリは参照フレームが ECEF に固定されている。こちらは地表を
 * 原点とする Y-up の局所座標なので、変換行列の軸の割り当てを間違えると
 * 太陽が真下から照らすような絵になる。目で気づきにくいので数値で押さえる。
 */

const DEG = Math.PI / 180
const REFERENCE = new Geodetic(139.7 * DEG, 35.6 * DEG, 0).toECEF()

describe('局所フレーム', () => {
  const frame = createLocalFrame(REFERENCE)

  it('原点が基準地点の ECEF 座標になる', () => {
    const origin = new Vector3().setFromMatrixPosition(frame)
    expect(origin.distanceTo(REFERENCE)).toBeLessThan(1e-6)
  })

  it('基底が正規直交である', () => {
    const x = new Vector3()
    const y = new Vector3()
    const z = new Vector3()
    frame.extractBasis(x, y, z)

    for (const [name, v] of [['X', x], ['Y', y], ['Z', z]] as const) {
      expect(Math.abs(v.length() - 1), name).toBeLessThan(1e-9)
    }
    expect(Math.abs(x.dot(y))).toBeLessThan(1e-9)
    expect(Math.abs(y.dot(z))).toBeLessThan(1e-9)
    expect(Math.abs(z.dot(x))).toBeLessThan(1e-9)
  })

  it('右手系である（X × Y = Z）', () => {
    const x = new Vector3()
    const y = new Vector3()
    const z = new Vector3()
    frame.extractBasis(x, y, z)

    const cross = new Vector3().crossVectors(x, y)
    expect(cross.distanceTo(z)).toBeLessThan(1e-9)
    // 行列式が +1（鏡映が混ざっていない）
    expect(frame.determinant()).toBeCloseTo(1, 9)
  })

  it('局所の上方向が地表の法線と一致する', () => {
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(REFERENCE, east, north, up)

    const localUp = new Vector3(0, 1, 0).transformDirection(frame)
    expect(localUp.distanceTo(up)).toBeLessThan(1e-9)
  })

  it('機首方向（-Z）が東を向く', () => {
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(REFERENCE, east, north, up)

    // 午後の太陽が背後から当たるように機首を東へ向けてある
    const localForward = new Vector3(0, 0, -1).transformDirection(frame)
    expect(localForward.distanceTo(east)).toBeLessThan(1e-9)
  })

  it('局所の右方向（+X）が南を向く', () => {
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(REFERENCE, east, north, up)

    const localRight = new Vector3(1, 0, 0).transformDirection(frame)
    expect(localRight.distanceTo(north.clone().negate())).toBeLessThan(1e-9)
  })

  it('局所の高度がそのまま楕円体からの高さになる', () => {
    // 高度 2000 m の点を ECEF へ写すと、地心距離が 2000 m 伸びる
    const at2000 = new Vector3(0, 2000, 0).applyMatrix4(frame)
    const rise = at2000.length() - REFERENCE.length()
    expect(Math.abs(rise - 2000)).toBeLessThan(1)
  })
})

describe('時刻の指定', () => {
  it('同じ時刻からは同じ Date が出る（決定論）', () => {
    expect(dateForHour(16).getTime()).toBe(dateForHour(16).getTime())
  })

  it('1 時間ずらすと 1 時間ぶん進む', () => {
    const diff = dateForHour(17).getTime() - dateForHour(16).getTime()
    expect(diff).toBe(3_600_000)
  })

  it('既定は午後', () => {
    expect(DEFAULT_HOUR).toBeGreaterThan(12)
    expect(DEFAULT_HOUR).toBeLessThan(19)
  })

  it('実時間に依存しない', () => {
    // 実装が Date.now() を使っていたら、間を空けた 2 回で値がずれる
    const first = dateForHour(DEFAULT_HOUR).getTime()
    const busy = Array.from({ length: 100_000 }, (_, i) => i).reduce((a, b) => a + b, 0)
    expect(busy).toBeGreaterThan(0)
    expect(dateForHour(DEFAULT_HOUR).getTime()).toBe(first)
  })
})
