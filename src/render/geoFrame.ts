import { Matrix4, Vector3 } from 'three'
import { Ellipsoid } from '@takram/three-geospatial'

/**
 * 基準地点・基準日時・局所フレーム。
 *
 * 大気の実装（node 経路の `atmosphereNodes.ts`）と時刻の設定（`capture.ts`・
 * `hud/settings.ts`）が読む。もとは GLSL 経路の `atmosphere.ts` にあったが、
 * 段 S1 で GLSL 経路を捨てるので、どの経路にも属さないここへ移した。
 * 座標系の橋渡しの経緯は docs/decisions/0002-atmosphere-integration.md にある。
 */

const DEG = Math.PI / 180

/**
 * 基準となる地理座標。北緯 35.6 度、東経 139.7 度、標高 0。
 *
 * ライブラリの参照フレームは ECEF（地球中心・メートル）に固定されていて
 * 変更できない。こちらのゲームは地表を原点とする Y-up の局所座標なので、
 * この地点を原点に置く行列で橋渡しする。局所座標が原点近傍に留まるため、
 * ECEF の 6,400 km を float32 で扱うときの精度崩れも起きない。
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

/**
 * 基準地点を原点とする右手系の局所フレームを作る。
 *
 * X が南、Y が上、Z が西。機首方向の -Z が東を向くので、午後の太陽（西）が
 * 背後から当たる。右手系の条件 X × Y = Z も満たす。
 */
export function createLocalFrame(referenceEcef: Vector3): Matrix4 {
  const east = new Vector3()
  const north = new Vector3()
  const up = new Vector3()
  Ellipsoid.WGS84.getEastNorthUpVectors(referenceEcef, east, north, up)

  const south = north.clone().negate()
  const west = east.clone().negate()

  return new Matrix4().makeBasis(south, up, west).setPosition(referenceEcef)
}
