/**
 * `tools/explosion-judge.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。node が変換なしで実行する必要が
 * あるため（`tools/ac3d.mjs` と同じ作法）。
 */

export const RIM_DARKER: number

export interface RimDip {
  /** 空より `RIM_DARKER` 以上暗い谷があったか */
  found: boolean
  /** 谷の底の線形輝度 */
  min: number
  /** 空に対してどれだけ暗いか（0..1） */
  depth: number
  /** 空の明るさへ抜けたか。抜けなければ判定できない */
  reachedSky: boolean
}

export function rimDip(profile: readonly number[], sky: number, darker?: number): RimDip
export const HOT_CORE: number
export function judgeExplosion(
  profile: readonly number[],
  sky: number,
): { hotCore: boolean; rim: RimDip; ok: boolean; why: string }
export function centroid(
  mask: Uint8Array,
  width: number,
): { x: number; y: number; pixels: number } | null
