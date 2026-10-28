import { describe, expect, it } from 'vitest'
import { dateForHour, sunFrameForHour } from '@render/geoFrame'

/**
 * 時刻から太陽の向きを出す部分（`geoFrame.ts` の `sunFrameForHour`）。
 *
 * 段 S2b-2 まで、相手は takram を ECEF 経由で通す `solarFrameForHour`
 * （`atmosphereNodes.ts`）で、ECEF の行列の検査（3 本）も持っていた。takram を
 * 外して自前の式（`sky/solar.ts`）に替え、ECEF の検査は消した。式そのものは
 * `solar.test.ts` が takram の 9 時刻の記録と 0.02 度で縛る。
 *
 * ここでは「同じ入力から同じ値が出る」ことと「高度が時刻に対して素直に動く」
 * ことを固定する。
 */
describe('時刻から太陽の向き', () => {
  it('同じ時刻なら同じ値が出る', () => {
    const a = sunFrameForHour(14)
    const b = sunFrameForHour(14)
    expect(a.sunElevationDeg).toBe(b.sunElevationDeg)
    expect(a.sunDirectionWorld).toEqual(b.sunDirectionWorld)
  })

  it('正午前後がいちばん高く、深夜は地平線より下', () => {
    const noon = sunFrameForHour(12)
    const midnight = sunFrameForHour(0)
    expect(noon.sunElevationDeg).toBeGreaterThan(0)
    expect(midnight.sunElevationDeg).toBeLessThan(0)
    // 基準は北緯 35.6 度。夏でも天頂には来ない
    expect(noon.sunElevationDeg).toBeLessThan(90)
  })

  it('朝と夕は正午より低い', () => {
    const morning = sunFrameForHour(7)
    const noon = sunFrameForHour(12)
    const evening = sunFrameForHour(17)
    expect(morning.sunElevationDeg).toBeLessThan(noon.sunElevationDeg)
    expect(evening.sunElevationDeg).toBeLessThan(noon.sunElevationDeg)
  })

  it('向きは単位ベクトル', () => {
    for (const hour of [0, 6, 12, 18]) {
      const d = sunFrameForHour(hour).sunDirectionWorld
      expect(Math.hypot(d.x, d.y, d.z), `${hour} 時`).toBeCloseTo(1, 6)
    }
  })

  it('高度はワールドの Y の逆正弦', () => {
    for (const hour of [8, 12, 16]) {
      const frame = sunFrameForHour(hour)
      const fromWorld = (Math.asin(frame.sunDirectionWorld.y) * 180) / Math.PI
      expect(fromWorld, `${hour} 時`).toBeCloseTo(frame.sunElevationDeg, 9)
    }
  })

  it('午後の太陽は西（+Z）、午前は東（-Z）にある', () => {
    // ワールドは X が南、Y が上、Z が西。機首方向の -Z が東を向く
    expect(sunFrameForHour(16).sunDirectionWorld.z).toBeGreaterThan(0)
    expect(sunFrameForHour(8).sunDirectionWorld.z).toBeLessThan(0)
  })

  it('時刻の解釈は `dateForHour` の 1 か所だけ', () => {
    // **原点も時刻も 1 か所だけ。**別々に持つと絵を見比べても分からない
    expect(dateForHour(12).getUTCHours()).toBe(dateForHour(12).getUTCHours())
    expect(sunFrameForHour(12).sunElevationDeg).toBe(sunFrameForHour(12.0).sunElevationDeg)
  })
})
