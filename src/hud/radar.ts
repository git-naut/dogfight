/**
 * レーダー（段 34、Phase 10 の段 B5 で録画に合わせて作り替えた）。**純関数。three も DOM も触らない。**
 *
 * 機首を上にした向き（ヘディングアップ）。自機から見た相手の水平の位置だけを見る（高度差は捨てる）。
 * 座標の約束は `project.ts` の `headingOf` と同じで、真北が −Z、方位は右回りが正、+X が東。
 *
 * **録画（ACE COMBAT 7 の講座 lesson 3）の形。**自機は枠の左右の真ん中・上から 66.4% に置き、前を
 * 広く見せる。距離は比例で、円は一辺の 12%・24%・49% の 3 本（1:2:4）。縮尺は敵との距離で
 * 自動で変わる（録画の説明書の画面の文）。値は `~/.claude/plans/dogfight-ac7-ref/measure/l3_summary.json`。
 *
 * 段 B4 までは自機が真ん中で、距離を平方根で縮め、範囲は 12 km に固定していた
 */

/** 自機の位置。枠の上から一辺の何割か（録画 y 924 − 724 = 200、一辺 300 → 0.664 は枠の線の太さ込み） */
export const RADAR_OWN_Y = 0.664

/** いちばん外の円の半径。一辺の何割か（録画 148 / 300） */
export const RADAR_OUTER_RING = 0.493

/** 円の半径。いちばん外の円に対する割合（録画 36・73・148 画素 ≒ 1:2:4） */
export const RADAR_RINGS = [0.25, 0.5, 1] as const

/**
 * 縮尺の段 m。いちばん外の円の半径が表す距離。**決まり方は推測**（録画には「敵との距離に応じて
 * 自動的に変化」としか無い）。いちばん近い相手がいちばん外の円に入る、いちばん小さい段を選ぶ
 * （ユーザーの決定、2026-10-18）。その瞬間の距離だけで決めるので、キャプチャでも同じ絵になる。
 * 段が切り替わる瞬間は一度に変わる
 */
export const RADAR_STEPS = [2000, 4000, 8000, 16000, 32000] as const

/** 相手がいないときの縮尺 m */
export const RADAR_DEFAULT_RANGE = 8000

/**
 * 縮尺を選ぶ。
 *
 * @param nearest いちばん近い相手までの水平の距離 m。相手がいなければ null
 */
export function radarRange(nearest: number | null): number {
  if (nearest === null) return RADAR_DEFAULT_RANGE
  for (const step of RADAR_STEPS) if (nearest <= step) return step
  return RADAR_STEPS[RADAR_STEPS.length - 1]!
}

/**
 * レーダーの上の点。自機が原点、いちばん外の円の半径が 1。x は右、y は下が正（画面と同じ向き）
 */
export interface RadarPoint {
  x: number
  y: number
  /** 枠の外にいて、枠の縁へ寄せた */
  clamped: boolean
}

/**
 * 枠の縁。自機を原点にした、いちばん外の円の半径を 1 とする単位で。前（上）は広く、後ろ（下）は狭い
 */
export const RADAR_BOX = {
  left: -0.5 / RADAR_OUTER_RING,
  right: 0.5 / RADAR_OUTER_RING,
  top: -RADAR_OWN_Y / RADAR_OUTER_RING,
  bottom: (1 - RADAR_OWN_Y) / RADAR_OUTER_RING,
} as const

/**
 * 自機から見た相手の水平の差（東 dx、南 dz、m）を、レーダーの上の点へ変える。
 *
 * 機首の向きの成分が上（y が負）、右の成分が右（x が正）。距離は比例で、`range` がいちばん外の円。
 * 枠の外は、自機からの向きを保ったまま枠の縁へ寄せる
 *
 * @param heading 自機の方位 rad（`headingOf`）
 * @param range いちばん外の円の半径が表す距離 m（`radarRange`）
 */
export function radarPoint(
  dx: number,
  dz: number,
  heading: number,
  range: number,
  out: RadarPoint = { x: 0, y: 0, clamped: false },
): RadarPoint {
  const s = Math.sin(heading)
  const c = Math.cos(heading)
  // 機首の向き (sin h, −cos h) と右 (cos h, sin h) へ射影する
  const ahead = dx * s - dz * c
  const right = dx * c + dz * s
  out.x = right / range
  out.y = -ahead / range
  // 枠の外なら、原点からの向きを保って縁まで縮める
  let k = 1
  if (out.x < RADAR_BOX.left) k = Math.min(k, RADAR_BOX.left / out.x)
  if (out.x > RADAR_BOX.right) k = Math.min(k, RADAR_BOX.right / out.x)
  if (out.y < RADAR_BOX.top) k = Math.min(k, RADAR_BOX.top / out.y)
  if (out.y > RADAR_BOX.bottom) k = Math.min(k, RADAR_BOX.bottom / out.y)
  out.clamped = k < 1
  out.x *= k
  out.y *= k
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
