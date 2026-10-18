/**
 * 着艦の進入の計器が読む値（Phase 10 の段 B7、ADR 0029）。**純関数。**
 *
 * グライドパスの表示は IFLOLS の 12 セル（Jungemann 2000、UTK 修士論文、PDF 67 頁）。上の 10 セルは
 * 黄で 1 セル 0.13 度、下の 2 セルは赤で 1 セル 0.20 度、合わせて 1.7 度。進入の線の上でボールが来る
 * 高さは本文に無い。図 28（PDF 65 頁）で、データムの腕が表示器の縦の中央（上から 6 番目と 7 番目の
 * 間）にあると読んだ。上へ 0.78 度、下へ 0.92 度で外れる
 *
 * 角は、操縦役 `approach` と同じく下ろし切ったフックの先端から測る。上げたままでも同じ線
 */
import { Vec3 } from './vec3'
import type { Quat } from './quat'
import { FORD_DECK_HEIGHT } from './fordDeck'
import { HOOK_DOWN_ANGLE, hookPointWorld } from './arrestor'
import type { CarrierPose } from './deckContact'
import { carrierToWorld, landingAimLocal } from './pilots/approach'

const DEG = Math.PI / 180

/** 進入角 rad。ADR 0021 の 3.5 度（台本の `GLIDE` と同じ） */
export const GLIDE_SLOPE = 3.5 * DEG
/** 計器を出す距離 m。狙う点の手前この距離まで */
export const GUIDE_RANGE = 3000
/** 黄のセルの数と 1 セルの角 度 */
export const YELLOW_CELLS = 10
export const YELLOW_CELL_DEG = 0.13
/** 赤のセルの数と 1 セルの角 度 */
export const RED_CELLS = 2
export const RED_CELL_DEG = 0.2
/** セルの総数 */
export const BALL_CELLS = YELLOW_CELLS + RED_CELLS
/** データムの腕の上にあるセルの数（図 28 で上から 6 番目と 7 番目の間） */
export const DATUM_CELL = 6
/** 進入の線から上へ外れる角 度（0.78） */
export const BALL_TOP_DEG = DATUM_CELL * YELLOW_CELL_DEG
/** 進入の線から下へ外れる角 度（0.92） */
export const BALL_BOTTOM_DEG = (YELLOW_CELLS - DATUM_CELL) * YELLOW_CELL_DEG + RED_CELLS * RED_CELL_DEG

/** 進入の迎角 度（ADR 0019・0021）と、オン・スピードとみなす幅 度（**推測**） */
export const APPROACH_AOA_DEG = 8.1
export const ON_SPEED_BAND_DEG = 0.5
/** ラインナップの表示の端 度（**推測**） */
export const LINEUP_FULL_DEG = 3

export type AoaCue = 'onSpeed' | 'slow' | 'fast'

export interface ApproachGuide {
  /** 計器を出すか。脚を出し、甲板に触れておらず、狙う点の手前 `GUIDE_RANGE` 以内で、中心線から 45 度の内 */
  active: boolean
  /** 狙う点まで中心線に沿った距離 m。手前が正 */
  range: number
  /** 進入の線からの上下のずれ 度。上が正 */
  glideErrorDeg: number
  /**
   * ボールのセル。0 が上、11 が下。上へ外れたら -1、下へ外れたら `BALL_CELLS`
   */
  ballCell: number
  /** 中心線からの左右のずれ 度。右が正 */
  lineupDeg: number
  /** 迎角の表示 */
  aoa: AoaCue
}

export function createApproachGuide(): ApproachGuide {
  return { active: false, range: 0, glideErrorDeg: 0, ballCell: -1, lineupDeg: 0, aoa: 'onSpeed' }
}

/** 進入の線からのずれ（度、上が正）をボールのセルへ */
export function ballCellOf(errorDeg: number): number {
  const fromTop = BALL_TOP_DEG - errorDeg
  if (fromTop < 0) return -1
  const yellowSpan = YELLOW_CELLS * YELLOW_CELL_DEG
  if (fromTop < yellowSpan) return Math.floor(fromTop / YELLOW_CELL_DEG)
  const red = Math.floor((fromTop - yellowSpan) / RED_CELL_DEG)
  return red < RED_CELLS ? YELLOW_CELLS + red : BALL_CELLS
}

/** 迎角（rad）を表示の 3 つの形へ。迎角が大きい（遅い）と緑の下向き */
export function aoaCueOf(angleOfAttack: number): AoaCue {
  const deg = angleOfAttack / DEG
  if (deg > APPROACH_AOA_DEG + ON_SPEED_BAND_DEG) return 'slow'
  if (deg < APPROACH_AOA_DEG - ON_SPEED_BAND_DEG) return 'fast'
  return 'onSpeed'
}

/** 計器が見る自機の状態 */
export interface GuideFlyer {
  readonly position: Vec3
  readonly orientation: Quat
  readonly angleOfAttack: number
  readonly gearPosition: number
  readonly onDeck: boolean
}

const hook = new Vec3()

/** 空母 `carrier` への進入の計器の値を `out` に書く */
export function updateApproachGuide(carrier: CarrierPose, flyer: GuideFlyer, out: ApproachGuide): ApproachGuide {
  const aim = landingAimLocal()
  const [ax, az] = carrierToWorld(carrier, aim.x, aim.z)
  const c = Math.cos(carrier.heading)
  const s = Math.sin(carrier.heading)
  const dx = aim.dirX * c - aim.dirZ * s
  const dz = aim.dirX * s + aim.dirZ * c
  hookPointWorld(flyer.position, flyer.orientation, HOOK_DOWN_ANGLE, hook)
  // 手前が正（狙う点へ向かって進む向きに、狙う点がどれだけ先にあるか）
  const along = (ax - hook.x) * dx + (az - hook.z) * dz
  // 右（進む向きを上から見て右回りに 90 度）が正
  const side = (hook.x - ax) * -dz + (hook.z - az) * dx
  out.range = along
  out.active =
    flyer.gearPosition > 0 && !flyer.onDeck && along > 0 && along <= GUIDE_RANGE && Math.abs(side) <= along
  const height = hook.y - FORD_DECK_HEIGHT
  out.glideErrorDeg = (Math.atan2(height, Math.max(along, 1)) - GLIDE_SLOPE) / DEG
  out.ballCell = ballCellOf(out.glideErrorDeg)
  out.lineupDeg = Math.atan2(side, Math.max(along, 1)) / DEG
  out.aoa = aoaCueOf(flyer.angleOfAttack)
  return out
}
