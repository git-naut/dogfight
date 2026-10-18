/**
 * 着艦の進入の計器の、表示の決まり（段 B7、ADR 0029）。**純関数。**値は sim の
 * `src/sim/approachGuide.ts` が測る。ここは画面の上の置き方と文字だけ
 */
import type { LandingResult } from '../sim/arrestor'
import { LINEUP_FULL_DEG } from '../sim/approachGuide'

/**
 * ラインナップの目印（着艦区域の中心線）を、目盛りの中心から片側の幅の何倍に置くか。−1〜1。
 *
 * 目印は**中心線のある方**に出す。右へずれていれば中心線は左にあるので、目印は左に出て、
 * 目印の方へ寄せれば合う（計器着陸の針と同じ読み方）。`LINEUP_FULL_DEG` で端に届き、それより
 * ずれても端に留める
 */
export function lineupMarkOffset(lineupDeg: number): number {
  const v = -lineupDeg / LINEUP_FULL_DEG
  return v < -1 ? -1 : v > 1 ? 1 : v
}

/** 結果の帯に出す着艦の結果。罠は掛かった索の番号を添える。結果が無ければ空 */
export function landingNoticeText(landing: LandingResult | null): string {
  if (landing === null) return ''
  if (landing.kind === 'trap') return `TRAP ${landing.wire}-WIRE`
  if (landing.kind === 'bolter') return 'BOLTER'
  return ''
}
