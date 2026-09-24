/**
 * `tools/detail-judge.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。node が変換なしで実行する必要が
 * あるため（`tools/ac3d.mjs` と同じ作法）。
 */

type Bytes = ArrayLike<number>

export interface MaskStats {
  /** 縮めたマスクの画素数 */
  pixels: number
  /** 線形輝度の中央値 */
  median: number
  /** 線形輝度の 99 パーセンタイル */
  p99: number
  /** 5x5 の箱平均との差が閾値を越えた画素の数 */
  detail: number
}

export interface Judgement {
  medianRise: number
  p99Rise: number
  detailGain: number
  ok: boolean
  why: string
}

export const NOISE_FLOOR: number
export const ERODE: number
export const DETAIL_THRESHOLD: number

export function luminance(r: number, g: number, b: number): number
export function diffMask(a: Bytes, b: Bytes, width: number, height: number, floor?: number): Uint8Array
export function erode(mask: Uint8Array, width: number, height: number, r?: number): Uint8Array
export function largestComponent(mask: Uint8Array, width: number, height: number): Uint8Array
export function luminancePlane(data: Bytes, width: number, height: number): Float64Array
export function maskStats(
  lum: Float64Array,
  mask: Uint8Array,
  width: number,
  threshold?: number,
  r?: number,
): MaskStats
export function judge(base: MaskStats, now: MaskStats): Judgement
