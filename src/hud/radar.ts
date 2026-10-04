/**
 * レーダー（段 34、参考画像の左下に合わせた）。**純関数。three も DOM も触らない。**
 *
 * 機首を上にした向き（ヘディングアップ）。自機を中心に、相手の水平の位置だけを見る
 * （高度差は捨てる）。座標の約束は `project.ts` の `headingOf` と同じで、真北が −Z、
 * 方位は右回りが正、+X が東。
 */

/** 中心から正方形の縁までの距離 m */
export const RADAR_RANGE = 6000

/** 距離の輪 m */
export const RADAR_RINGS = [2000, 4000] as const

/** レーダーの上の点。x は右、y は下が正（画面と同じ向き）。中心が 0、縁が ±1 */
export interface RadarPoint {
  x: number
  y: number
  /** 範囲の外にいて、縁へ寄せた */
  clamped: boolean
}

/**
 * 自機から見た相手の水平の差（東 dx、南 dz、m）を、レーダーの上の点へ変える。
 *
 * 機首の向きの成分が上（y が負）、右の成分が右（x が正）。範囲の外は、向きを保ったまま
 * 正方形の縁へ寄せる
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
  let x = right / range
  let y = -ahead / range
  const edge = Math.max(Math.abs(x), Math.abs(y))
  out.clamped = edge > 1
  if (out.clamped) {
    x /= edge
    y /= edge
  }
  out.x = x
  out.y = y
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
