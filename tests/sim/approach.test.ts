import { describe, it, expect } from 'vitest'
import { World, createWorldFromScript, worldOptionsFromScript } from '@sim/world'
import { ReplayPlayer, type ReplayScript } from '@sim/replay'
import { getScript } from '@sim/scripts'
import { Vec3 } from '@sim/vec3'
import { HOOK_DOWN_ANGLE, hookPointWorld } from '@sim/arrestor'
import { FORD_WIRES } from '@sim/fordDeck'
import { approachCarrier, carrierToWorld, landingAimLocal } from '@sim/pilots/approach'
import { TOUCHDOWN_LIMITS } from '@sim/deckContact'

/**
 * 着艦の進入の操縦役（Phase 9 の段 10）。
 *
 * 自動スロットル（ATC）の分け方で飛ぶ。スロットルが迎角 8.1 度を保ち、機首で進入角 3.5 度の線を
 * 飛び、バンクでラインナップを合わせる（AIAA 2016-1770 PDF 9 頁、ユーザーの判断 2026-10-14）。
 * 合格条件（ユーザーと合意）は、フックが狙う点（1 本目と 2 本目の索の間）から ±18.2 ft（同 PDF
 * 11 頁の 1σ）に着いて 2 本目に掛かり、降下率が 13.65±2.01 ft/s（同 Table 1 の平均 ±1σ）、
 * 迎角 8.1±0.5 度、中心からのずれ 1 m 以内
 */
const FT = 0.3048
const KT = 0.514444
const DEG = Math.PI / 180

interface Pass {
  world: World
  /** フックが甲板に着いた点の、狙う点からの距離 ft（艦首へ向かって正）。着かなければ null */
  hookTouchdownFt: number | null
  /** 車輪が甲板に触れる直前のステップの迎角 rad */
  aoaBeforeTouchdown: number
  frames: { trap?: number; touchdown?: number; stop?: number; left?: number; crash?: number }
}

function fly(script: ReplayScript, steps = 3600): Pass {
  const world = new World(worldOptionsFromScript(script))
  const player = new ReplayPlayer(script)
  const aim = landingAimLocal()
  const [ax, az] = carrierToWorld(script.carrier!, aim.x, aim.z)
  const c = Math.cos(script.carrier!.heading)
  const s = Math.sin(script.carrier!.heading)
  const dx = aim.dirX * c - aim.dirZ * s
  const dz = aim.dirX * s + aim.dirZ * c
  const out: Pass = { world, hookTouchdownFt: null, aoaBeforeTouchdown: 0, frames: {} }
  for (let i = 0; i < steps; i++) {
    const p = world.player
    if (p.lastTouchdown === null && !p.crashed) out.aoaBeforeTouchdown = p.angleOfAttack
    world.step(player.at(i, p))
    if (out.hookTouchdownFt === null && p.hookPosition >= 1 && p.hookAngle < HOOK_DOWN_ANGLE - 1e-6) {
      const tip = hookPointWorld(p.position, p.orientation, p.hookAngle, new Vec3())
      out.hookTouchdownFt = ((tip.x - ax) * dx + (tip.z - az) * dz) / FT
    }
    const f = out.frames
    if (f.trap === undefined && p.arrestor !== null) f.trap = world.frame
    if (f.touchdown === undefined && p.lastTouchdown !== null) f.touchdown = world.frame
    if (f.stop === undefined && p.arrestor?.stopped === true) f.stop = world.frame
    if (f.left === undefined && f.touchdown !== undefined && !p.onDeck && !p.crashed) f.left = world.frame
    if (f.crash === undefined && p.crashed) f.crash = world.frame
  }
  return out
}

describe('狙う点と空母の置き方', () => {
  it('狙う点は 1 本目と 2 本目の索の間で、着艦区域の中心線の上', () => {
    const aim = landingAimLocal()
    const z1 = (FORD_WIRES[0]!.starboard[1] + FORD_WIRES[0]!.port[1]) / 2
    const z2 = (FORD_WIRES[1]!.starboard[1] + FORD_WIRES[1]!.port[1]) / 2
    expect(aim.z).toBeCloseTo((z1 + z2) / 2, 6)
    expect(aim.z).toBeLessThan(z1)
    expect(aim.z).toBeGreaterThan(z2)
    // 中心線 x = 0.157613 z − 17.212
    expect(aim.x).toBeCloseTo(0.157613 * aim.z - 17.212, 2)
  })

  it('approachCarrier は狙う点を前 distance m・左 lateral m に置き、中心線を −Z に向ける', () => {
    const carrier = approachCarrier(1200, 20)
    const aim = landingAimLocal()
    const [x, z] = carrierToWorld(carrier, aim.x, aim.z)
    expect(x).toBeCloseTo(-20, 9)
    expect(z).toBeCloseTo(-1200, 9)
    const [x2, z2] = carrierToWorld(carrier, aim.x + aim.dirX * 100, aim.z + aim.dirZ * 100)
    expect(x2 - x).toBeCloseTo(0, 9)
    expect(z2 - z).toBeCloseTo(-100, 9)
  })
})

describe('carrier-trap（合格条件）', () => {
  const pass = fly(getScript('carrier-trap'))
  const p = pass.world.player

  it('フックは狙う点から ±18.2 ft の内側に着き（実測 13.1 ft 先）、2 本目に掛かる', () => {
    expect(Math.abs(pass.hookTouchdownFt!)).toBeLessThan(18.2)
    expect(pass.hookTouchdownFt!).toBeCloseTo(13.1, 1)
    expect(p.landing).toMatchObject({ kind: 'trap', wire: 2 })
  })

  it('接地の降下率は 13.65±2.01 ft/s の内側（実測 12.10 ft/s）、硬い着地ではない', () => {
    const sink = p.lastTouchdown!.sinkRate / FT
    expect(sink).toBeGreaterThan(13.65 - 2.01)
    expect(sink).toBeLessThan(13.65 + 2.01)
    expect(p.lastTouchdown!.sinkRate).toBeLessThan(TOUCHDOWN_LIMITS.hardSinkRate)
  })

  it('接地の直前の迎角は 8.1±0.5 度（実測 7.79 度）、中心からのずれは 1 m 以内', () => {
    expect(Math.abs(pass.aoaBeforeTouchdown / DEG - 8.1)).toBeLessThan(0.5)
    if (p.landing?.kind !== 'trap') throw new Error('掛かっていない')
    expect(Math.abs(p.landing.offCenter)).toBeLessThan(1)
    // 最大速度（152 kt）より遅い
    expect(p.landing.engageSpeed / KT).toBeLessThan(152)
  })

  it('始まりのずれ（中心線の右 20 m）を直し切る', () => {
    expect(Math.abs(p.position.x - -20)).toBeLessThan(0.1)
  })

  it('f2189 に索に掛かり、f2202 に車輪が触れ、f2566 に止まる。墜落しない', () => {
    expect(pass.frames).toMatchObject({ trap: 2189, touchdown: 2202, stop: 2566 })
    expect(p.crashed).toBe(false)
  })
})

describe('carrier-bolter と carrier-hard', () => {
  it('フックを上げたままなら、接地でミリタリーにして走り抜け、飛び去る', () => {
    const pass = fly(getScript('carrier-bolter'))
    const p = pass.world.player
    expect(p.landing).toMatchObject({ kind: 'bolter', reason: 'hookUp' })
    expect(pass.frames.touchdown).toBe(2202)
    expect(pass.frames.left).toBe(2392)
    expect(p.crashed).toBe(false)
    expect(p.position.y).toBeGreaterThan(150)
  })

  /**
   * 浮く途中で甲板に触れ直しても、新しい接地に数えない（`RECONTACT_STEPS`、ユーザーの判断
   * 2026-10-15）。直す前は f2393 と f2398 に降下率ほぼ 0 で触れ直し、接地の記録とボルターの
   * 結果の接地の値が 0 で上書きされていた
   */
  it('ボルターの接地は 1 回だけ数え、記録は本当の接地（12.0 ft/s）のまま', () => {
    const script = getScript('carrier-bolter')
    const world = new World(worldOptionsFromScript(script))
    const player = new ReplayPlayer(script)
    let touchdowns = 0
    let last = world.player.lastTouchdown
    for (let i = 0; i < 3000; i++) {
      world.step(player.at(i, world.player))
      if (world.player.lastTouchdown !== last) {
        touchdowns++
        last = world.player.lastTouchdown
      }
    }
    const p = world.player
    expect(touchdowns).toBe(1)
    expect(p.lastTouchdown!.sinkRate / FT).toBeCloseTo(12.0, 1)
    if (p.landing?.kind !== 'bolter') throw new Error('ボルターになっていない')
    expect(p.landing.touchdown!.sinkRate / FT).toBeCloseTo(12.0, 1)
  })

  it('進入角 8 度なら、降下率が構造設計の範囲を超えて墜落する（deckSink）', () => {
    const pass = fly(getScript('carrier-hard'))
    expect(pass.world.player.landing).toMatchObject({ kind: 'crash', cause: 'deckSink' })
    expect(pass.frames.crash).toBe(1668)
  })
})

/**
 * **台本の 1 本だけ合わせた値ではないことを見る。**始まりを 18 通り変えても、どれも索に掛かり、
 * 降下率は 11.6〜15.0 ft/s に収まる（実測）。1,000 m 手前・横 20 m から始めると、ラインナップを
 * 直し切る前に降りて手前に着くので、ここには入れていない（ADR 0021）
 */
describe('始まりのばらつき', () => {
  for (const distance of [1200, 1500]) {
    for (const lateral of [-20, 0, 20]) {
      for (const high of [-5, 0, 5]) {
        it(`${distance} m 手前・横 ${lateral} m・高さ ${high} m から始めても掛かる`, () => {
          const base = getScript('carrier-trap')
          const glide = (3.5 * Math.PI) / 180
          const spawn = { ...base.spawn, altitude: base.spawn.altitude + (distance - 1200) * Math.tan(glide) + (high - 5) }
          const pass = fly({ ...base, spawn, carrier: approachCarrier(distance, lateral) })
          const p = pass.world.player
          expect(p.landing?.kind).toBe('trap')
          const sink = p.lastTouchdown!.sinkRate / FT
          expect(sink).toBeGreaterThan(11.5)
          expect(sink).toBeLessThan(15.1)
        })
      }
    }
  }
})

describe('操作の分け方（自動スロットル）', () => {
  it('迎角が大きい（遅い）とスロットルを開け、線より高いと機首を下げる', () => {
    const script = getScript('carrier-trap')
    const a = createWorldFromScript(script)
    const base = { ...a.player.at(0, a.world.player) }
    // 同じ始まりで、迎角だけを 2 度大きく見せる
    const b = createWorldFromScript(script)
    b.world.player.angleOfAttack += 2 * DEG
    const slow = b.player.at(0, b.world.player)
    expect(slow.throttle).toBeGreaterThan(base.throttle)
    // 始まりは線より 5 m 高いので、機首を下げる
    expect(base.pitch).toBeLessThan(0)
  })
})
