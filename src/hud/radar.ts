/**
 * レーダー（段 34、参考画像の左下に合わせた）。**純関数。three も DOM も触らない。**
 *
 * 機首を上にした向き（ヘディングアップ）の 360 度。自機を中心に、相手の水平の位置だけを見る
 * （高度差は捨てる）。座標の約束は `project.ts` の `headingOf` と同じで、真北が −Z、
 * 方位は右回りが正、+X が東。
 *
 * **距離は平方根で縮める**（段 37、計画書の段 31）。`r = √(min(1, d / RADAR_RANGE))`。
 * 段 34 は比例のまま半幅 6 km にしていて、計画書と食い違っていた。比例だと空戦の距離の相手が
 * 中心に潰れる。
 */

/**
 * 中心から円の縁までの距離 m（段 37）。
 *
 * 計画書は「`mission-01` を 300 秒回し、敵との水平距離の中央値が半径の 50% に来る範囲」と
 * していた。入力なしでは自機がすぐ撃墜されるので、自機が生きている間だけ測った（2026-10-05）。
 *
 * | 台本 | 生きていた時間 | 標本 | 中央値 | p90 | 中央値を半径の 50% にする範囲 |
 * |---|---|---|---|---|---|
 * | mission-01 | 19.1 秒 | 955 | 9,656 m | 11,560 m | 38.6 km |
 * | mission-air | 3.5 秒 | 175 | 3,022 m | 3,274 m | 12.1 km |
 *
 * mission-01 は空母からの接近しか測れておらず、38.6 km だと 500 m の相手が半径の 11% に潰れる。
 * ユーザーの判断で mission-air をもとに 12 km にした。500 m は 20%、10 km は 91% に出る
 */
export const RADAR_RANGE = 12000

/** 距離の輪 m。半径は平方根で縮めるので 29%・50%・71% の所に来る */
export const RADAR_RINGS = [1000, 3000, 6000] as const

/** 距離 m を、円の半径に対する割合 0..1 へ（平方根で縮め、範囲の外は 1） */
export function radarRadius(distance: number, range: number = RADAR_RANGE): number {
  return Math.sqrt(Math.min(1, Math.max(0, distance) / range))
}

/** レーダーの上の点。x は右、y は下が正（画面と同じ向き）。中心が 0、円の縁が半径 1 */
export interface RadarPoint {
  x: number
  y: number
  /** 範囲の外にいて、円の縁へ寄せた */
  clamped: boolean
}

/**
 * 自機から見た相手の水平の差（東 dx、南 dz、m）を、レーダーの上の点へ変える。
 *
 * 機首の向きの成分が上（y が負）、右の成分が右（x が正）。中心からの距離は平方根で縮める
 * （`radarRadius`）。範囲の外は、向きを保ったまま円の縁へ寄せる
 *
 * @param heading 自機の方位 rad（`headingOf`）
 */
export function radarPoint(
  dx: number,
  dz: number,
  heading: number,
  range: number = RADAR_RANGE,
  out: RadarPoint = { x: 0, y: 0, clamped: false },
): RadarPoint {
  const s = Math.sin(heading)
  const c = Math.cos(heading)
  // 機首の向き (sin h, −cos h) と右 (cos h, sin h) へ射影する
  const ahead = dx * s - dz * c
  const right = dx * c + dz * s
  const distance = Math.hypot(ahead, right)
  out.clamped = distance > range
  if (distance < 1e-9) {
    out.x = 0
    out.y = 0
    return out
  }
  const r = radarRadius(distance, range)
  out.x = (right / distance) * r
  out.y = (-ahead / distance) * r
  return out
}

/**
 * 方位の文字（N・E・S・W）を置く向き。機首を上にしたレーダーの上で、その方位が
 * どちらにあるかを単位ベクトル（x 右、y 下）で返す
 *
 * @param bearing 方位 rad。北 0、東 π/2
 */
export function radarBearing(
  bearing: number,
  heading: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const relative = bearing - heading
  out.x = Math.sin(relative)
  out.y = -Math.cos(relative)
  return out
}
