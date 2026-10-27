import { describe, expect, it } from 'vitest'
import { sunDirectionLocal, type Direction } from '@render/sky/solar'
import { REFERENCE_LATITUDE, REFERENCE_LONGITUDE, dateForHour } from '@render/geoFrame'

/**
 * 太陽の位置の式（`src/render/sky/solar.ts`）を takram と突き合わせる（段 S2a）。
 *
 * 段 S2b で takram（中身は astronomy-engine）を外すと、太陽の向きは自前の式が
 * 出す。**ずれると空も影も雲の光も一斉に動く。**takram が基準の 9 時刻で出した
 * 向きを定数で記録し、自前の式との角度の差を 0.02 度以内に縛る（ユーザーの決定、
 * 2026-10-26）。0.02 度は太陽の見かけの半径（約 0.27 度）の 1/13。
 *
 * 記録は `solarFrameForHour(hour).sunDirectionWorld`（`atmosphereNodes.ts`）を
 * 2026-10-26 に印字したもの。ワールド座標は X が南、Y が上、Z が西
 * （`geoFrame.ts` の `createLocalFrame`）。基準の時刻 6 つ（8・9・12・16・17・
 * 18.3 時）に、日の出の前後（4・6 時）と夜（21 時）を足して、地平線の下も縛る。
 */
const TAKRAM: readonly ({ hour: number } & Direction)[] = [
  { hour: 4, x: -0.478812058673, y: -0.25725895139, z: -0.839378844384 },
  { hour: 6, x: -0.196047506184, y: 0.136939436246, z: -0.970985564321 },
  { hour: 8, x: 0.0872147407631, y: 0.531832172687, z: -0.842346798586 },
  { hour: 9, x: 0.204760052487, y: 0.695635526692, z: -0.688596060771 },
  { hour: 12, x: 0.372079663555, y: 0.928197254909, z: -0.0025651410204 },
  { hour: 16, x: 0.091377761578, y: 0.534583678711, z: 0.840160934074 },
  { hour: 17, x: -0.0447119851659, y: 0.344111694173, z: 0.937863519024 },
  { hour: 18.3, x: -0.235221918471, y: 0.0775109412896, z: 0.968846067779 },
  { hour: 21, x: -0.590804382572, y: -0.420199483057, z: 0.688754365484 },
]

/** ユーザーが決めた許容（度） */
const TOLERANCE_DEG = 0.02

const angleDeg = (a: Direction, b: Direction): number => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  const la = Math.hypot(a.x, a.y, a.z)
  const lb = Math.hypot(b.x, b.y, b.z)
  return (Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) * 180) / Math.PI
}

const sunAt = (hour: number): Direction =>
  sunDirectionLocal(dateForHour(hour), REFERENCE_LATITUDE, REFERENCE_LONGITUDE)

describe('太陽の位置の式', () => {
  for (const recorded of TAKRAM) {
    it(`${recorded.hour} 時の向きが takram と ${TOLERANCE_DEG} 度以内`, () => {
      const got = sunAt(recorded.hour)
      const error = angleDeg(got, recorded)
      expect(error, `${recorded.hour} 時のずれ ${error.toFixed(5)} 度`).toBeLessThanOrEqual(
        TOLERANCE_DEG,
      )
    })
  }

  it('返す向きは単位ベクトル', () => {
    for (const { hour } of TAKRAM) {
      expect(Math.hypot(sunAt(hour).x, sunAt(hour).y, sunAt(hour).z)).toBeCloseTo(1, 12)
    }
  })

  it('検査が働くことを、1 時間ずらした向きで確かめる', () => {
    // 1 時間で太陽は約 15 度動く。ずらしても通るなら、許容の比べ方が空回りしている
    const shifted = sunAt(17)
    const error = angleDeg(shifted, TAKRAM.find((r) => r.hour === 16)!)
    expect(error).toBeGreaterThan(5)
  })

  it('南中は 12 時の前後 30 分にあり、南の空にいる', () => {
    // 基準の日時は地方真太陽時の正午を 12 時に置いている（`geoFrame.ts`）。
    // 均時差（8 月中旬で約 -4.5 分）があっても 30 分は越えない
    let best = { hour: 0, y: -2 }
    for (let m = 11 * 60; m <= 13 * 60; m++) {
      const s = sunAt(m / 60)
      if (s.y > best.y) best = { hour: m / 60, y: s.y }
    }
    expect(Math.abs(best.hour - 12)).toBeLessThan(0.5)
    expect(sunAt(best.hour).x, '南中の太陽は南（+X）にいる').toBeGreaterThan(0)
  })
})
