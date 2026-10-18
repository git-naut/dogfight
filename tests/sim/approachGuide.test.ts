import { describe, it, expect } from 'vitest'
import {
  BALL_BOTTOM_DEG,
  BALL_CELLS,
  BALL_TOP_DEG,
  aoaCueOf,
  ballCellOf,
  createApproachGuide,
  updateApproachGuide,
} from '@sim/approachGuide'
import { createWorldFromScript, type World } from '@sim/world'
import { getScript } from '@sim/scripts'
import { landingNoticeText, lineupMarkOffset } from '../../src/hud/approach'

/**
 * 着艦の進入の計器（Phase 10 の段 B7、ADR 0029）。
 *
 * IFLOLS の 12 セル（Jungemann 2000、PDF 67 頁）。上 10 セルが黄で 0.13 度ずつ、下 2 セルが赤で
 * 0.20 度ずつ。進入の線は上から 6 セル目と 7 セル目の間（図 28、PDF 65 頁）
 */

const DEG = Math.PI / 180

describe('ボールのセル', () => {
  it('上へ 0.78 度・下へ 0.92 度で外れ、合わせて 1.7 度（論文の縦の覆う範囲）', () => {
    expect(BALL_TOP_DEG).toBeCloseTo(0.78, 12)
    expect(BALL_BOTTOM_DEG).toBeCloseTo(0.92, 12)
    expect(BALL_TOP_DEG + BALL_BOTTOM_DEG).toBeCloseTo(1.7, 12)
  })

  it('線の少し上は 6 セル目（5）、少し下は 7 セル目（6）', () => {
    expect(ballCellOf(0.05)).toBe(5)
    expect(ballCellOf(-0.05)).toBe(6)
  })

  it('いちばん上と黄の最後、赤の 2 セル', () => {
    expect(ballCellOf(0.75)).toBe(0)
    expect(ballCellOf(-0.5)).toBe(9)
    expect(ballCellOf(-0.6)).toBe(10)
    expect(ballCellOf(-0.85)).toBe(11)
  })

  it('外れたら上は −1、下はセルの数', () => {
    expect(ballCellOf(0.8)).toBe(-1)
    expect(ballCellOf(-0.95)).toBe(BALL_CELLS)
  })
})

describe('迎角の表示', () => {
  it('8.1±0.5 度はオン・スピード、大きければ遅い、小さければ速い', () => {
    expect(aoaCueOf(8.1 * DEG)).toBe('onSpeed')
    expect(aoaCueOf(8.5 * DEG)).toBe('onSpeed')
    expect(aoaCueOf(8.7 * DEG)).toBe('slow')
    expect(aoaCueOf(7.4 * DEG)).toBe('fast')
  })
})

describe('表示の決まり', () => {
  it('ラインナップの目印は中心線のある方へ出て、3 度で端に留まる', () => {
    // 右へずれていれば中心線は左
    expect(lineupMarkOffset(1.5)).toBeCloseTo(-0.5, 12)
    expect(lineupMarkOffset(-1.5)).toBeCloseTo(0.5, 12)
    expect(lineupMarkOffset(10)).toBe(-1)
    expect(lineupMarkOffset(-10)).toBe(1)
  })

  it('結果の文字は罠なら索の番号つき、ボルターなら BOLTER、墜落と無しは空', () => {
    expect(landingNoticeText({ kind: 'trap', wire: 2, engageSpeed: 60, offCenter: 0, touchdown: null })).toBe('TRAP 2-WIRE')
    expect(landingNoticeText({ kind: 'bolter', reason: 'hookUp', touchdown: null })).toBe('BOLTER')
    expect(landingNoticeText(null)).toBe('')
  })
})

interface Trace {
  world: World
  /** 計器が出ていたあいだの、狙う点まで 50〜250 m のボールのセル */
  closeCells: number[]
  /** 計器が出ていた最後のコマの迎角の表示 */
  lastAoa: string
  /** 計器が出ていたあいだに見たボールのセル */
  cells: Set<number>
}

function fly(name: string, frames = 120 * 25): Trace {
  const { world, player } = createWorldFromScript(getScript(name))
  const closeCells: number[] = []
  const cells = new Set<number>()
  let lastAoa = ''
  for (let f = 0; f < frames; f++) {
    world.step(player.at(f, world.player))
    const g = world.approach
    if (!g.active) continue
    cells.add(g.ballCell)
    lastAoa = g.aoa
    if (g.range >= 50 && g.range <= 250) closeCells.push(g.ballCell)
  }
  return { world, closeCells, lastAoa, cells }
}

describe('3 本の台本', () => {
  /**
   * 50 m より近くでは角で測る誤差が膨らむ。狙う点の 9 m 手前で 0.15 m 高いだけで +0.92 度に
   * なり、ボールが上へ外れる。接地の直前の物差しは 50〜250 m で見る。
   *
   * 段 10 の進入の操縦役は線より少し低く飛ぶ（−0.05〜−0.28 度、105 m で 0.5 m 低い）。ボールは
   * 6・7・8 セル（65・188・103 コマ）。物差しは上 1・下 2 セル（ユーザーの決定、2026-10-19）
   */
  it('carrier-trap は狙う点の 50〜250 m 手前で、ボールが黄の真ん中から上 1・下 2 セル以内', () => {
    const { closeCells } = fly('carrier-trap')
    expect(closeCells.length).toBeGreaterThan(100)
    for (const c of closeCells) {
      expect(c).toBeGreaterThanOrEqual(4)
      expect(c).toBeLessThanOrEqual(8)
    }
  })

  it('carrier-trap は接地の直前の迎角がオン・スピードで、TRAP 2-WIRE を出し続ける', () => {
    const { world, lastAoa } = fly('carrier-trap')
    expect(lastAoa).toBe('onSpeed')
    expect(landingNoticeText(world.landingNotice)).toBe('TRAP 2-WIRE')
    expect(world.approach.active).toBe(false)
  })

  it('carrier-bolter は BOLTER を出し続ける', () => {
    const { world } = fly('carrier-bolter')
    expect(landingNoticeText(world.landingNotice)).toBe('BOLTER')
  })

  /** 急な角度で上から降りてくるので、ボールは上へ外れたまま（進入の線より上） */
  it('carrier-hard はボールが上へ外れたまま降りる', () => {
    const { cells } = fly('carrier-hard')
    expect([...cells]).toEqual([-1])
  })

  it('脚を上げていれば、進入の線の上でも計器を出さない', () => {
    const { world } = createWorldFromScript(getScript('carrier-trap'))
    const p = world.player
    const guide = createApproachGuide()
    const flyer = { position: p.position, orientation: p.orientation, angleOfAttack: p.angleOfAttack, onDeck: false }
    expect(updateApproachGuide(world.carrier!, { ...flyer, gearPosition: 1 }, guide).active).toBe(true)
    expect(updateApproachGuide(world.carrier!, { ...flyer, gearPosition: 0 }, guide).active).toBe(false)
  })

  it('空母の無い台本では計器を出さない', () => {
    const { world, cells } = fly('level', 120)
    expect(cells.size).toBe(0)
    expect(world.landingNotice).toBe(null)
  })
})

describe('結果は次の試みまで出し続ける', () => {
  it('ボルターのあと、艦尾の後ろへ戻って計器がまた出たら消える', () => {
    const script = getScript('carrier-bolter')
    const { world, player } = createWorldFromScript(script)
    // 始まりの位置を覚えておく（進入の線の上、狙う点の 1,200 m 手前）
    const start = world.player.position.clone()
    let f = 0
    for (; f < 120 * 25; f++) world.step(player.at(f, world.player))
    expect(landingNoticeText(world.landingNotice)).toBe('BOLTER')
    expect(world.player.gearPosition).toBeGreaterThan(0)
    // 進入の始まりへ戻す（飛び直したことにする）
    world.player.position.copy(start)
    world.step(player.at(f, world.player))
    expect(world.approach.active).toBe(true)
    expect(world.landingNotice).toBe(null)
  })
})
