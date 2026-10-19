/**
 * 兵装の欄の自機の輪郭と発射機の印（段 C3、ADR 0030）。**純関数と形の表。**
 */

/** RGBA。0〜255 と 0〜1 */
export type Rgba = readonly [number, number, number, number]

import { DAMAGE_RED_RGBA, DAMAGE_YELLOW_RGBA, SILHOUETTE_RGBA } from './palette'

/**
 * 輪郭の色の段。損傷 0 で HUD の緑、0.41 で黄（録画のコマ 600 の 0% と 19990 の 41% の色の差を
 * HUD の緑に掛けた）、0.75 で赤（**推測**。録画に 41% より大きい損傷は写っていない）。間は線形に
 */
export const SILHOUETTE_STOPS: readonly (readonly [number, Rgba])[] = [
  [0, SILHOUETTE_RGBA],
  [0.41, DAMAGE_YELLOW_RGBA],
  [0.75, DAMAGE_RED_RGBA],
]

/** 損傷（0〜1）での輪郭の色 */
export function silhouetteColor(damage: number): Rgba {
  const stops = SILHOUETTE_STOPS
  if (damage <= stops[0]![0]) return stops[0]![1]
  for (let i = 1; i < stops.length; i++) {
    const [d1, c1] = stops[i]!
    if (damage <= d1) {
      const [d0, c0] = stops[i - 1]!
      const t = (damage - d0) / (d1 - d0)
      return [0, 1, 2, 3].map((k) => c0[k]! + (c1[k]! - c0[k]!) * t) as unknown as Rgba
    }
  }
  return stops[stops.length - 1]![1]
}

export function rgbaText(c: Rgba): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${c[3].toFixed(3)})`
}

/**
 * 発射機の印の形。録画のコマ 600 の左の印（幅 16・高さ 82）を、上の先端を (0, 0) として画素で
 * 拾った。先端・胴（幅 8）・翼（幅 13、上から 19）・下の広い部分（幅 16、上から 62 より下）
 */
export const LAUNCHER_SHAPE: readonly number[] = [
  0, 0, 4, 8, 4, 15, 6.5, 19, 4, 23, 4, 58, 8, 63, 8, 82, -8, 82, -8, 63, -4, 58, -4, 23, -6.5, 19, -4,
  15, -4, 8,
]
