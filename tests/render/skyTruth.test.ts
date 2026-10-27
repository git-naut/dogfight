import { describe, expect, it } from 'vitest'
import {
  GROUND_RADIUS,
  IRRADIANCE_HEIGHT,
  IRRADIANCE_WIDTH,
  SUN_ILLUMINANCE,
  buildMultiscatterTable,
  buildTransmittanceTable,
  sampleIrradiance,
  skyIrradianceOverPi,
  transmittanceToTop,
} from '@render/sky/reference'
import { IRRADIANCE_TABLE } from '@render/sky/irradianceTable'
import { monteCarloSky } from './skyMonteCarlo'

/**
 * 自前の空（Hillaire）の光の強さを、正解と takram に突き合わせる（段 S2a の関門）。
 *
 * - **直達光**は今の takram と 3% 以内（ユーザーの決定、2026-10-26）。露出 6・
 *   ブルームの閾値・VFX の色は takram の光の尺度で決めてあるので、ここがずれると
 *   それらを全部測り直すことになる
 * - **天空光**は正解と、太陽高度 25 度以上で 3%、25 度未満で 5% 以内（ユーザーの決定）。
 *   25 度の境は結果を見たあとで引いた線。Hillaire の多重散乱の近似は、低い太陽で
 *   青を約 4% 低く出す（刻みを細かくしても残った）
 *
 * **天空光の相手は takram ではない。**今の takram（node の実行時 LUT）の天空光は、
 * 正解より昼に 1.24〜1.61 倍明るい。物理の値を採った（ユーザーの決定）。
 *
 * 正解はモンテカルロ法の光線追跡（`skyMonteCarlo.ts`、近似なし、色ごとに 40 万本、
 * 種は `9001 + 色 × 7 + round(時 × 10)`）で出して記録した。出し直すときはこの式で
 * 同じ値が出る。1 回散乱だけに絞ると、地球の丸みを入れた直接の積分と統計誤差の内で
 * 一致した（2026-10-26）。
 */

/** 正解（地表の上向きの面の天空の照度 / π、太陽の照度 1 あたり）と標準誤差 */
const TRUTH = [
  { hour: 8, sunMu: 0.5318321726871543, value: [0.008646493683004977, 0.01676934196441419, 0.03538956928977256], error: [1.581e-5, 2.451e-5, 4.208e-5] },
  { hour: 9, sunMu: 0.69563552669178, value: [0.009060374962541553, 0.01788305743789703, 0.03847176264676064], error: [1.431e-5, 2.371e-5, 4.165e-5] },
  { hour: 12, sunMu: 0.9281972549087586, value: [0.009519562819435858, 0.019101243254577203, 0.04174750175145808], error: [1.213e-5, 2.129e-5, 3.871e-5] },
  { hour: 16, sunMu: 0.534583678710939, value: [0.008670049951215592, 0.016838167945030798, 0.03548982417979126], error: [1.585e-5, 2.462e-5, 4.209e-5] },
  { hour: 17, sunMu: 0.3441116941726287, value: [0.008036766295948636, 0.014932695799537665, 0.030160864048962753], error: [1.769e-5, 2.418e-5, 3.895e-5] },
  { hour: 18.3, sunMu: 0.07751094128961983, value: [0.0056784233889223155, 0.007701351272683259, 0.011940327859684317], error: [1.451e-5, 1.236e-5, 2.145e-5] },
] as const

/**
 * 今の takram の照度プローブ（`nodeScene.ts` の `refreshRadiance`）の値。
 * 2026-10-26 に `?capture=1&frame=0&hour=…` の `hook.sunRadiance` を読んだもの。
 * 天空（`sky`）は記録として残すだけで、合否には使わない
 */
const TAKRAM = [
  { hour: 8, sunElevation: 0.5607626148069044, sun: [1.7045224905014038, 1.310606598854065, 1.0095454454421997], sky: [0.025334343314170837, 0.039209723472595215, 0.07246923446655273] },
  { hour: 9, sunElevation: 0.7693041704628479, sun: [1.751010537147522, 1.3945249319076538, 1.1371510028839111], sky: [0.02822725847363472, 0.045211225748062134, 0.08539430797100067] },
  { hour: 12, sunElevation: 1.1895382515310964, sun: [1.7899786233901978, 1.4671958684921265, 1.2533135414123535], sky: [0.03228357434272766, 0.05356569588184357, 0.10324878245592117] },
  { hour: 16, sunElevation: 0.5640150497843535, sun: [1.7055206298828125, 1.3123763799667358, 1.0121628046035767], sky: [0.025385024026036263, 0.039315223693847656, 0.07269694656133652] },
  { hour: 17, sunElevation: 0.351292536465886, sun: [1.6028794050216675, 1.1375454664230347, 0.7685433626174927], sky: [0.021645570173859596, 0.031454671174287796, 0.05562465265393257] },
  { hour: 18.3, sunElevation: 0.07758876546918982, sun: [0.9821703433990479, 0.3759409189224243, 0.08183607459068298], sky: [0.013192473910748959, 0.0136696333065629, 0.019179245457053185] },
] as const

const DIRECT_TOLERANCE = 0.03
/** 太陽高度で分ける境（度）と、それぞれの許容 */
const SKY_BAND_DEG = 25
const SKY_TOLERANCE_HIGH = 0.03
const SKY_TOLERANCE_LOW = 0.05

const transmittance = buildTransmittanceTable()
const multiscatter = buildMultiscatterTable(transmittance)
const irradianceTable = {
  width: IRRADIANCE_WIDTH,
  height: IRRADIANCE_HEIGHT,
  data: Float64Array.from(IRRADIANCE_TABLE),
}

describe('自前の空の光の強さ', () => {
  for (const t of TAKRAM) {
    it(`${t.hour} 時の直達光が takram と ${DIRECT_TOLERANCE * 100}% 以内`, () => {
      const tr = transmittanceToTop(GROUND_RADIUS, Math.sin(t.sunElevation))
      for (let c = 0; c < 3; c++) {
        const ratio = (tr[c]! * SUN_ILLUMINANCE[c]!) / t.sun[c]!
        expect(Math.abs(ratio - 1), `${t.hour} 時の色 ${c} の比 ${ratio.toFixed(4)}`).toBeLessThanOrEqual(
          DIRECT_TOLERANCE,
        )
      }
    })
  }

  for (const truth of TRUTH) {
    const elevationDeg = (Math.asin(truth.sunMu) * 180) / Math.PI
    const tolerance = elevationDeg >= SKY_BAND_DEG ? SKY_TOLERANCE_HIGH : SKY_TOLERANCE_LOW
    it(`${truth.hour} 時（太陽高度 ${elevationDeg.toFixed(1)} 度）の天空光が正解と ${tolerance * 100}% 以内`, () => {
      const got = skyIrradianceOverPi(transmittance, multiscatter, truth.sunMu)
      for (let c = 0; c < 3; c++) {
        const ratio = got[c]! / truth.value[c]!
        expect(Math.abs(ratio - 1), `${truth.hour} 時の色 ${c} の比 ${ratio.toFixed(4)}`).toBeLessThanOrEqual(tolerance)
      }
    })
  }

  for (const truth of TRUTH) {
    const elevationDeg = (Math.asin(truth.sunMu) * 180) / Math.PI
    const tolerance = elevationDeg >= SKY_BAND_DEG ? SKY_TOLERANCE_HIGH : SKY_TOLERANCE_LOW
    it(`${truth.hour} 時の天空光を同梱の表（段 S2b）から引いても正解と ${tolerance * 100}% 以内`, () => {
      // 場面が実際に使うのは表の値。表の刻み（16 × 32）と補間の誤差を足しても帯の内に入るか
      const got = sampleIrradiance(irradianceTable, truth.sunMu, 0)
      for (let c = 0; c < 3; c++) {
        const ratio = got[c]! / truth.value[c]!
        expect(Math.abs(ratio - 1), `${truth.hour} 時の色 ${c} の比 ${ratio.toFixed(4)}`).toBeLessThanOrEqual(tolerance)
      }
    })
  }

  it('検査が働くことを、takram の天空光で確かめる', () => {
    // takram は正解より昼に 1.24〜1.61 倍明るい。正午の takram を正解の代わりに
    // 置いたら落ちなければ、比べ方が空回りしている
    const noon = TRUTH.find((t) => t.hour === 12)!
    const takram = TAKRAM.find((t) => t.hour === 12)!
    const got = skyIrradianceOverPi(transmittance, multiscatter, noon.sunMu)
    // takram の天空は空の輝度換算込みなので、正解の側の尺度へ戻して比べる
    const skyIlluminanceGreen = 1.7426
    const ratio = got[1]! / (takram.sky[1]! / skyIlluminanceGreen)
    expect(Math.abs(ratio - 1)).toBeGreaterThan(SKY_TOLERANCE_LOW)
  })

  it('正解を出したモンテカルロが今も同じ値を出す（本数を減らして統計誤差の内）', () => {
    // 4,000 本なら誤差は記録の 10 倍ほど。5 標準偏差の内に入ることを見る
    const noon = TRUTH.find((t) => t.hour === 12)!
    const green = monteCarloSky(noon.sunMu, 1, 4000, 4242)
    expect(Math.abs(green.value - noon.value[1]) / green.error).toBeLessThan(5)
  })
})
