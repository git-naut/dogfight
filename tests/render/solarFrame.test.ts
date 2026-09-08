import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { solarFrameForHour } from '@render/atmosphereNodes'
import { dateForHour } from '@render/atmosphere'

/**
 * 時刻から太陽の向きを出す部分。
 *
 * **ワールドの Y と ECEF の Z は別物。**行列を通さずに内積を取ると緯度
 * ぶんずれる。基準は東経 139.7 度・北緯 35.6 度で、そこの局所の上方向を
 * ECEF へ回してから測らなければ高度にならない。
 *
 * GLSL 経路と同じ原点・同じ時刻を使うことが前提で、別々に持つと**絵を
 * 見比べても分からないずれ方をする。**ここでは「同じ入力から同じ値が
 * 出る」ことと「高度が時刻に対して素直に動く」ことを固定する。
 */
describe('時刻から太陽の向き', () => {
  it('同じ時刻なら同じ値が出る', () => {
    const a = solarFrameForHour(14)
    const b = solarFrameForHour(14)
    expect(a.sunElevationDeg).toBe(b.sunElevationDeg)
    expect(a.sunDirectionECEF.toArray()).toEqual(b.sunDirectionECEF.toArray())
    expect(a.sunDirectionWorld.toArray()).toEqual(b.sunDirectionWorld.toArray())
  })

  it('正午前後がいちばん高く、深夜は地平線より下', () => {
    const noon = solarFrameForHour(12)
    const midnight = solarFrameForHour(0)
    expect(noon.sunElevationDeg).toBeGreaterThan(0)
    expect(midnight.sunElevationDeg).toBeLessThan(0)
    // 基準は北緯 35.6 度。夏でも天頂には来ない
    expect(noon.sunElevationDeg).toBeLessThan(90)
  })

  it('朝と夕は正午より低い', () => {
    const morning = solarFrameForHour(7)
    const noon = solarFrameForHour(12)
    const evening = solarFrameForHour(17)
    expect(morning.sunElevationDeg).toBeLessThan(noon.sunElevationDeg)
    expect(evening.sunElevationDeg).toBeLessThan(noon.sunElevationDeg)
  })

  it('向きは単位ベクトル', () => {
    for (const hour of [0, 6, 12, 18]) {
      const frame = solarFrameForHour(hour)
      expect(frame.sunDirectionECEF.length(), `${hour} 時の ECEF`).toBeCloseTo(1, 6)
      expect(frame.sunDirectionWorld.length(), `${hour} 時のワールド`).toBeCloseTo(1, 6)
      expect(frame.moonDirectionECEF.length(), `${hour} 時の月`).toBeCloseTo(1, 6)
    }
  })

  it('高度はワールドの Y と一致する。**行列を通さない読み方をしない**', () => {
    // `sunDirectionWorld.y` の逆正弦が高度そのもの。行列を通さずに
    // `sunDirectionECEF.y` で測ると、緯度ぶん（35.6 度）ずれる
    for (const hour of [8, 12, 16]) {
      const frame = solarFrameForHour(hour)
      const fromWorld = (Math.asin(frame.sunDirectionWorld.y) * 180) / Math.PI
      expect(fromWorld, `${hour} 時`).toBeCloseTo(frame.sunElevationDeg, 4)
    }
  })

  it('ワールドから ECEF への行列は向きを保つ', () => {
    const frame = solarFrameForHour(10)
    const back = frame.sunDirectionWorld
      .clone()
      .transformDirection(frame.worldToECEF)
    expect(back.x).toBeCloseTo(frame.sunDirectionECEF.x, 6)
    expect(back.y).toBeCloseTo(frame.sunDirectionECEF.y, 6)
    expect(back.z).toBeCloseTo(frame.sunDirectionECEF.z, 6)
  })

  it('局所の上方向は ECEF では基準の位置の方向になる', () => {
    // 行列そのものが基準の場所を向いていることを確かめる。ここが狂うと
    // 高度も雲のライティングも一緒にずれるので、絵からは切り分けられない
    const frame = solarFrameForHour(12)
    const up = new Vector3(0, 1, 0).transformDirection(frame.worldToECEF)
    // 東経 139.7 度・北緯 35.6 度の外向き法線
    const lon = (139.7 * Math.PI) / 180
    const lat = (35.6 * Math.PI) / 180
    expect(up.x).toBeCloseTo(Math.cos(lat) * Math.cos(lon), 3)
    expect(up.y).toBeCloseTo(Math.cos(lat) * Math.sin(lon), 3)
    expect(up.z).toBeCloseTo(Math.sin(lat), 3)
  })

  it('時刻の解釈は `atmosphere.ts` と同じものを使う', () => {
    // **原点も時刻も 1 か所だけ。**別々に持つと絵を見比べても分からない
    expect(dateForHour(12).getUTCHours()).toBe(dateForHour(12).getUTCHours())
    const a = solarFrameForHour(12)
    const b = solarFrameForHour(12.0)
    expect(a.sunElevationDeg).toBe(b.sunElevationDeg)
  })
})
