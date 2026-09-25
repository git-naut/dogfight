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
export const HIGHLIGHT_FACTOR: number

export interface HighlightStats {
  /** 最大の塊の画素数 */
  pixels: number
  /** 外接矩形の長辺÷短辺。塊が無ければ 0 */
  aspect: number
  box: { x: number; y: number; w: number; h: number } | null
  /** 最大の塊を 1 にした画像 */
  blob: Uint8Array
}

export function highlightStats(
  lum: Float64Array,
  mask: Uint8Array,
  width: number,
  height: number,
  median: number,
  factor?: number,
): HighlightStats
export function judge(base: MaskStats, now: MaskStats): Judgement
export const GLOSS_RISE: number
export function judgeGloss(
  baseSkin: MaskStats,
  nowSkin: MaskStats,
  baseRegion: number,
  nowRegion: number,
  baseHi: HighlightStats,
  nowHi: HighlightStats,
): { medianRise: number; regionRise: number; gain: number; ok: boolean; why: string }
export function maskedMedian(lum: Float64Array, mask: Uint8Array): number
