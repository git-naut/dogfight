import { sunDirectionLocal, type Direction } from './sky/solar'

/**
 * 基準地点・基準日時・時刻ごとの太陽。
 *
 * 空（`sky/hillaireSky.ts`）と時刻の設定（`capture.ts`・`hud/settings.ts`）が読む。
 * もとは GLSL 経路の `atmosphere.ts` にあり、段 S1 でここへ移した。段 S2b-2 で
 * takram を外し、ECEF の局所フレーム（`createLocalFrame`）も消した。座標系の
 * 橋渡しの経緯は docs/decisions/0002-atmosphere-integration.md にある。
 */

const DEG = Math.PI / 180

/**
 * 基準となる地理座標。北緯 35.6 度、東経 139.7 度、標高 0。
 *
 * ワールドはこの地点を原点とする右手系で、X が南、Y が上、Z が西。機首方向の
 * -Z が東を向くので、午後の太陽（西）が背後から当たる。
 */
export const REFERENCE_LONGITUDE = 139.7 * DEG
export const REFERENCE_LATITUDE = 35.6 * DEG

/**
 * 基準の日時。基準地点の地方真太陽時で正午にあたる UTC。
 *
 * 太陽方向は実時間の Date から計算されるので、そのまま使うと絵が毎回変わり
 * スクリーンショット回帰が成立しない。固定値を基準にして、時刻はここからの
 * 時間差で表す。
 */
const SOLAR_NOON_UTC = Date.UTC(2026, 7, 16, 2, 45)

/** 既定の時刻。午後の斜光で太陽高度 30 度前後になる */
export const DEFAULT_HOUR = 16

/** 局所時刻（0〜24）から Date を作る。12 が基準地点の南中。 */
export function dateForHour(hour: number): Date {
  return new Date(SOLAR_NOON_UTC + (hour - 12) * 3_600_000)
}

/** 時刻ごとの太陽 */
export interface SunFrame {
  /** ワールド座標の太陽の向き（X が南、Y が上、Z が西）。単位ベクトル */
  sunDirectionWorld: Direction
  /** 太陽高度 deg。地平線より下なら負 */
  sunElevationDeg: number
}

/**
 * 局所時刻（0〜24）から太陽の向きと高度を出す。式は `sky/solar.ts`（NOAA）。
 *
 * 段 S2b-2 まで、この役は takram（astronomy-engine）を ECEF 経由で通していた
 * （`atmosphereNodes.ts` の `solarFrameForHour`）。自前の式は 9 時刻で takram と
 * 0.007 度以内（`tests/render/solar.test.ts`）
 */
export function sunFrameForHour(hour: number): SunFrame {
  const d = sunDirectionLocal(dateForHour(hour), REFERENCE_LATITUDE, REFERENCE_LONGITUDE)
  return {
    sunDirectionWorld: d,
    sunElevationDeg: Math.asin(Math.max(-1, Math.min(1, d.y))) / DEG,
  }
}
