import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  IRRADIANCE_AZIMUTH_STEPS,
  IRRADIANCE_HEIGHT,
  IRRADIANCE_WIDTH,
  IRRADIANCE_ZENITH_STEPS,
  buildMultiscatterTable,
  buildTransmittanceTable,
  irradianceTexel,
  irradianceTexelCoords,
  sampleIrradiance,
  skyIrradianceOverPi,
  type RgbTable,
} from '@render/sky/reference'
import { IRRADIANCE_TABLE } from '@render/sky/irradianceTable'

/**
 * 同梱した天空の照度の表（`src/render/sky/irradianceTable.ts`）を縛る（段 S2b）。
 *
 * 表は CPU 参照（`irradianceTexel`）で作る。全画素を作り直すと 30 秒ほど掛かるので、
 * 普段は四隅と中ほどの画素だけを作り直して比べる。定数や刻みを変えたら、次で作り直す。
 *
 *   WRITE_SKY_IRRADIANCE=1 npx vitest run tests/render/skyIrradiance.test.ts
 */

const transmittance = buildTransmittanceTable()
const multiscatter = buildMultiscatterTable(transmittance)

const shipped: RgbTable = {
  width: IRRADIANCE_WIDTH,
  height: IRRADIANCE_HEIGHT,
  data: Float64Array.from(IRRADIANCE_TABLE),
}

/** 作り直して比べる画素。四隅、地表の行の夕方と昼、中ほどの高さ */
const PROBES: readonly (readonly [number, number])[] = [
  [0, 0],
  [IRRADIANCE_WIDTH - 1, 0],
  [0, IRRADIANCE_HEIGHT - 1],
  [IRRADIANCE_WIDTH - 1, IRRADIANCE_HEIGHT - 1],
  [18, 0],
  [20, 0],
  [40, 0],
  [55, 0],
  [20, 5],
  [40, 9],
]

/** 数表に書くときの有効桁。相対 5e-6 で丸まる */
const DIGITS = 6

describe('天空の照度の表', () => {
  if (process.env.WRITE_SKY_IRRADIANCE === '1') {
    it('表を作り直して書く', () => {
      const values: string[] = []
      for (let y = 0; y < IRRADIANCE_HEIGHT; y++) {
        for (let x = 0; x < IRRADIANCE_WIDTH; x++) {
          for (const v of irradianceTexel(transmittance, multiscatter, x, y)) {
            values.push(Number(v.toPrecision(DIGITS)).toString())
          }
        }
      }
      const lines: string[] = []
      for (let i = 0; i < values.length; i += IRRADIANCE_WIDTH * 3) {
        lines.push('  ' + values.slice(i, i + IRRADIANCE_WIDTH * 3).join(', ') + ',')
      }
      const body = [
        '/**',
        ' * 天空の照度の表（段 S2b）。**手で直さない。**`tests/render/skyIrradiance.test.ts` が',
        ' * CPU 参照（`reference.ts` の `irradianceTexel`）から書き出す。',
        ' *',
        ` * ${IRRADIANCE_WIDTH} × ${IRRADIANCE_HEIGHT} 画素、行ごと（高さが外側）に RGB。値は上向きの面の`,
        ' * 天空の照度 / π（太陽の照度 1 あたり）。横と縦の意味は `irradianceTexelCoords`',
        ' */',
        '// prettier-ignore',
        'export const IRRADIANCE_TABLE: readonly number[] = [',
        ...lines,
        ']',
        '',
      ].join('\n')
      writeFileSync(new URL('../../src/render/sky/irradianceTable.ts', import.meta.url), body)
    }, 120_000)
    return
  }

  it('表の大きさが合う', () => {
    expect(IRRADIANCE_TABLE.length).toBe(IRRADIANCE_WIDTH * IRRADIANCE_HEIGHT * 3)
  })

  for (const [x, y] of PROBES) {
    it(`画素 (${x}, ${y}) が CPU 参照と一致する`, () => {
      const want = irradianceTexel(transmittance, multiscatter, x, y)
      for (let c = 0; c < 3; c++) {
        const got = shipped.data[(y * IRRADIANCE_WIDTH + x) * 3 + c]!
        // 丸めの 5e-6 と、表が空に近い所（太陽が深く沈んだ側）の絶対の下限
        expect(Math.abs(got - want[c]!), `色 ${c}`).toBeLessThanOrEqual(Math.abs(want[c]!) * 1e-5 + 1e-12)
      }
    })
  }

  it('画素の間を引いた値が、その点で積分した値と 1% 以内（地表と 3 km、太陽高度 2〜70 度）', () => {
    // 表の粗さの検査。画素の中心から半画素ずれた所で比べる
    let worst = 0
    for (const altitude of [0, 3]) {
      for (const deg of [2, 5, 10, 20, 35, 50, 70]) {
        const sunMu = Math.sin((deg * Math.PI) / 180)
        const want = skyIrradianceOverPi(
          transmittance,
          multiscatter,
          sunMu,
          IRRADIANCE_ZENITH_STEPS,
          IRRADIANCE_AZIMUTH_STEPS,
          1,
          altitude,
        )
        const got = sampleIrradiance(shipped, sunMu, altitude)
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c]! / want[c]! - 1))
      }
    }
    expect(worst).toBeLessThanOrEqual(0.01)
  })

  it('高さの行の配り方が 0 km から上端までを覆う', () => {
    expect(irradianceTexelCoords(0, 0).altitude).toBe(0)
    expect(irradianceTexelCoords(0, IRRADIANCE_HEIGHT - 1).altitude).toBeCloseTo(60, 9)
    expect(irradianceTexelCoords(IRRADIANCE_WIDTH - 1, 0).sunMu).toBeCloseTo(1, 12)
  })
})
