import { describe, expect, it } from 'vitest'
import {
  AERIAL_SLICES,
  aerialPerspective,
  aerialSliceDistance,
  aerialSliceOf,
  buildMultiscatterTable,
  buildTransmittanceTable,
  medium,
  skyRadiance,
} from '@render/sky/reference'

/**
 * 霞の CPU 参照（`aerialPerspective`、段 S2b）を縛る。
 *
 * GPU との一致は node-path.spec が見る。**両側が同じ誤りを持てばそこは通る**ので、
 * ここでは CPU 参照の性質を、独立の相手（空の見え方の積分と、媒質の解析式）と比べる。
 *
 * - 遠くまで積分した霞の光は、同じ視線の空の放射輝度（48 歩）と一致する。霞は 32 歩で
 *   刻むので 2.5% 以内（実測は 3 時刻 × 3 高度 × 36 方向で最大 1.8%）。**差は水平線の
 *   継ぎ目になる**（遠い地形が霞で空の色へ寄る先が、空の色とずれる）
 * - 近い距離の透過率は、地表の減衰係数から exp(-σd) で出る
 */
const transmittance = buildTransmittanceTable()
const multiscatter = buildMultiscatterTable(transmittance)

const dirOf = (elevationDeg: number, azimuthDeg: number): [number, number, number] => {
  const e = (elevationDeg * Math.PI) / 180
  const a = (azimuthDeg * Math.PI) / 180
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)]
}

describe('霞の CPU 参照', () => {
  // 16 時・17 時・18.3 時の太陽（太陽の方位は +x）
  for (const sunMu of [0.534583678710939, 0.3441116941726287, 0.07751094128961983]) {
    const sun: [number, number, number] = [Math.sqrt(1 - sunMu * sunMu), sunMu, 0]
    for (const altitude of [0.1, 2, 8]) {
      it(`太陽の余弦 ${sunMu.toFixed(3)}・高さ ${altitude} km で、遠くまでの霞が空の放射輝度と一致する`, () => {
        for (const el of [-30, -10, -2, 0.5, 5, 30]) {
          const tolerance = 0.025
          for (const az of [0, 90, 180]) {
            const dir = dirOf(el, az)
            const sky = skyRadiance(transmittance, multiscatter, altitude, dir, sunMu)
            const got = aerialPerspective(transmittance, multiscatter, altitude, dir, sun, 1e9).inscatter
            for (let c = 0; c < 3; c++) {
              const ratio = got[c]! / sky[c]!
              expect(Math.abs(ratio - 1), `仰角 ${el} 方位 ${az} 色 ${c} の比 ${ratio.toFixed(4)}`).toBeLessThanOrEqual(
                tolerance,
              )
            }
          }
        }
      })
    }
  }

  it('地表の水平の 1 km の透過率が exp(-σd) と 1e-3 以内', () => {
    const sun: [number, number, number] = [0.8, 0.6, 0]
    const got = aerialPerspective(transmittance, multiscatter, 0, [0, 0, 1], sun, 1).transmittance
    const sigma = medium(0).extinction
    for (let c = 0; c < 3; c++) {
      // 1 km 進むと高さが 0.08 m 上がるだけなので、密度は地表のままとみなせる
      expect(Math.abs(got[c]! / Math.exp(-sigma[c]!) - 1), `色 ${c}`).toBeLessThanOrEqual(1e-3)
    }
  })

  it('距離 0 では霞が無く、距離とともに光が増えて透過率が減る', () => {
    const sun: [number, number, number] = [0.8, 0.6, 0]
    // **上へ向ける。**下へ向けると 19 km 先で地面に当たり、その先は値が動かない
    const dir = dirOf(3, 45)
    const zero = aerialPerspective(transmittance, multiscatter, 1, dir, sun, 0)
    expect(zero.inscatter).toEqual([0, 0, 0])
    expect(zero.transmittance).toEqual([1, 1, 1])
    let previous = zero
    for (let s = 0; s < AERIAL_SLICES; s += 4) {
      const next = aerialPerspective(transmittance, multiscatter, 1, dir, sun, aerialSliceDistance(s))
      for (let c = 0; c < 3; c++) {
        expect(next.inscatter[c]!).toBeGreaterThan(previous.inscatter[c]!)
        expect(next.transmittance[c]!).toBeLessThan(previous.transmittance[c]!)
      }
      previous = next
    }
  })

  it('奥行きの枚と距離の写し方が互いに逆', () => {
    for (let s = 0; s < AERIAL_SLICES; s++) {
      expect(aerialSliceOf(aerialSliceDistance(s))).toBeCloseTo(s, 9)
    }
    // 最後の枚がカメラの遠方（200 km）に当たる
    expect(aerialSliceDistance(AERIAL_SLICES - 1)).toBeCloseTo(200, 9)
    expect(aerialSliceOf(0)).toBe(-1)
  })
})
