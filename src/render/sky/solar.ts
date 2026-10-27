/**
 * 太陽の位置（段 S2a）。
 *
 * 日時と地点から、局所のワールド座標での太陽の向きを出す。段 S2b で takram
 * （中身は astronomy-engine）を外すと、空も影も雲の光もこの向きを読む。
 * web-ocean は太陽の向きを画面のつまみで決めていて、日時から出す式を持たない
 * ので自前で書く。
 *
 * 式は NOAA の太陽位置計算（Meeus『Astronomical Algorithms』に基づく、NOAA
 * Global Monitoring Laboratory の Solar Calculator と同じ式）。大気差（屈折）は
 * 入れない。takram も幾何学的な向きを返すため。takram との突き合わせは
 * `tests/render/solar.test.ts`（9 時刻で 0.02 度以内）。
 *
 * three にも DOM にも依存しない。角度の入出力はラジアン、内部は度で書く
 * （NOAA の式が度で書かれていて、写し間違いを見つけやすいため）。
 */

/** 向き。単位ベクトル */
export interface Direction {
  x: number
  y: number
  z: number
}

const DEG = Math.PI / 180
const sin = (deg: number) => Math.sin(deg * DEG)
const cos = (deg: number) => Math.cos(deg * DEG)
const tan = (deg: number) => Math.tan(deg * DEG)

/** UNIX 時刻（ms）からユリウス日 */
function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5
}

/**
 * 太陽の赤緯（度）と均時差（分）。
 *
 * NOAA の Solar Calculator の列と 1 対 1 に対応させてある（名前は列名）
 */
export function solarDeclinationAndEquationOfTime(date: Date): {
  declinationDeg: number
  equationOfTimeMin: number
} {
  const t = (julianDay(date) - 2_451_545) / 36_525
  const geomMeanLong = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360
  const geomMeanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const eqOfCtr =
    sin(geomMeanAnom) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    sin(2 * geomMeanAnom) * (0.019993 - 0.000101 * t) +
    sin(3 * geomMeanAnom) * 0.000289
  const trueLong = geomMeanLong + eqOfCtr
  const omega = 125.04 - 1934.136 * t
  const appLong = trueLong - 0.00569 - 0.00478 * sin(omega)
  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliqCorr = meanObliq + 0.00256 * cos(omega)
  const declinationDeg = Math.asin(sin(obliqCorr) * sin(appLong)) / DEG

  const y = tan(obliqCorr / 2) ** 2
  const equationOfTimeMin =
    (4 *
      (y * sin(2 * geomMeanLong) -
        2 * eccent * sin(geomMeanAnom) +
        4 * eccent * y * sin(geomMeanAnom) * cos(2 * geomMeanLong) -
        0.5 * y * y * sin(4 * geomMeanLong) -
        1.25 * eccent * eccent * sin(2 * geomMeanAnom))) /
    DEG
  return { declinationDeg, equationOfTimeMin }
}

/**
 * 局所のワールド座標での太陽の向き。
 *
 * ワールドは X が南、Y が上、Z が西（`geoFrame.ts` の `createLocalFrame`）。
 * 機首方向の -Z が東を向く。
 *
 * @param latitude  緯度 rad（北が正）
 * @param longitude 経度 rad（東が正）
 */
export function sunDirectionLocal(date: Date, latitude: number, longitude: number): Direction {
  const { declinationDeg, equationOfTimeMin } = solarDeclinationAndEquationOfTime(date)
  const utcMinutes = (date.getTime() / 60_000) % 1440
  // 真太陽時（分）から時角（度）。南中で 0、午後が正
  const trueSolarTime = utcMinutes + equationOfTimeMin + (4 * longitude) / DEG
  const hourAngle = trueSolarTime / 4 - 180

  const phi = latitude / DEG
  // 東・北・上の成分
  const east = -cos(declinationDeg) * sin(hourAngle)
  const north = cos(phi) * sin(declinationDeg) - sin(phi) * cos(declinationDeg) * cos(hourAngle)
  const up = sin(phi) * sin(declinationDeg) + cos(phi) * cos(declinationDeg) * cos(hourAngle)

  const length = Math.hypot(east, north, up)
  return { x: -north / length, y: up / length, z: -east / length }
}
