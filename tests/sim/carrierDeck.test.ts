import { describe, it, expect } from 'vitest'
import { CATAPULTS, DECK_HEIGHT, catapultLaunch } from '@sim/carrierDeck'
import { FORD_CATAPULTS, FORD_DECK_HEIGHT } from '@sim/fordDeck'
import { LAUNCH_DISTANCE } from '@sim/launch'
import { headingOf, wrapAngle } from '@hud/project'
import { SCRIPTS } from '@sim/scripts'
import { worldOptionsFromScript } from '@sim/world'

/**
 * 空母の甲板と射出（Phase 9 の段 4 で Nimitz から Ford へ替えた）。
 *
 * 甲板の値そのものは `tests/tools/fordDeck.test.ts` が原本と突き合わせる。ここでは、射出が
 * その値を使い、帯に沿って走ることを見る。**ずれると射出の軌跡だけが帯から外れ、絵を見ても
 * 気づきにくい。**
 */
const NAMES = Object.keys(CATAPULTS) as (keyof typeof CATAPULTS)[]

describe('甲板の値', () => {
  it('Ford の 4 基と甲板の高さを使う', () => {
    expect(CATAPULTS).toBe(FORD_CATAPULTS)
    expect(NAMES).toEqual(['cat-1', 'cat-2', 'cat-3', 'cat-4'])
    expect(DECK_HEIGHT).toBe(FORD_DECK_HEIGHT)
    expect(DECK_HEIGHT).toBeCloseTo(18.87, 2)
  })
})

describe('射出の諸元', () => {
  const AT_ORIGIN = { x: 0, z: 0, heading: 0 }

  it('知らない名前は例外', () => {
    expect(() => catapultLaunch(AT_ORIGIN, 'cat-9', LAUNCH_DISTANCE)).toThrow()
  })

  it('向きが単位ベクトル', () => {
    for (const name of NAMES) {
      const spec = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE)
      expect(spec.direction.length(), `${name}`).toBeCloseTo(1, 5)
      // 水平
      expect(spec.direction.y).toBe(0)
    }
  })

  /** 艦首が −Z なので、射出も −Z 側へ向かう */
  it('射出が艦首側を向く', () => {
    for (const name of NAMES) {
      const spec = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE)
      expect(spec.direction.z, `${name} が艦首を向いていない`).toBeLessThan(-0.9)
    }
  })

  it('開始位置が甲板の高さ', () => {
    for (const name of NAMES) expect(catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE).from.y, name).toBe(DECK_HEIGHT)
  })

  /**
   * **機体は帯に沿って走る**（ユーザーの判断、2026-10-06）。帯は艦の軸から 2〜4 度
   * 傾いているので、射出の向きも同じだけ傾く。期待値は測った角度を数字で書く
   */
  it('射出の向きが帯の向きと一致する', () => {
    const measured = { 'cat-1': 4.03, 'cat-2': 2.21, 'cat-3': 4.37, 'cat-4': 0.04 }
    for (const name of NAMES) {
      const d = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE).direction
      // 艦首へ向かうほど左舷（−X）へ寄る角度
      const angle = (Math.atan2(-d.x, -d.z) * 180) / Math.PI
      expect(angle, name).toBeCloseTo(measured[name], 1)
    }
  })

  /** ミッションの発進に使う 1 本。艦の軸と平行に走る */
  it('cat-4 の射出は艦の軸と 0.5 度以内で平行', () => {
    const d = catapultLaunch(AT_ORIGIN, 'cat-4', LAUNCH_DISTANCE).direction
    expect(Math.abs(Math.atan2(d.x, -d.z))).toBeLessThan((0.5 * Math.PI) / 180)
  })

  /**
   * **開始位置は帯の内側。**終点から行程ぶん手前に取るので、帯（103.5〜108.6 m）
   * より短い行程（91.44 m）なら必ず内側に入る
   */
  it('開始位置が帯の内側にある', () => {
    for (const name of NAMES) {
      const { start, end } = CATAPULTS[name]
      const spec = catapultLaunch(AT_ORIGIN, name, LAUNCH_DISTANCE)
      const bandLength = Math.hypot(end[0] - start[0], end[1] - start[1])
      const fromEnd = Math.hypot(spec.from.x - end[0], spec.from.z - end[1])
      expect(fromEnd, `${name}`).toBeCloseTo(LAUNCH_DISTANCE, 3)
      expect(fromEnd, `${name} が帯からはみ出している`).toBeLessThan(bandLength)
    }
  })

  /** 空母を動かすと射出位置も動く */
  it('空母の位置が反映される', () => {
    const a = catapultLaunch({ x: 0, z: 0, heading: 0 }, 'cat-1', LAUNCH_DISTANCE)
    const b = catapultLaunch({ x: 500, z: -300, heading: 0 }, 'cat-1', LAUNCH_DISTANCE)
    expect(b.from.x - a.from.x).toBeCloseTo(500, 3)
    expect(b.from.z - a.from.z).toBeCloseTo(-300, 3)
    // 向きは変わらない
    expect(b.direction.x).toBeCloseTo(a.direction.x, 6)
  })

  /** 艦首を回すと射出方向も回る */
  it('艦首の向きが反映される', () => {
    const straight = catapultLaunch({ x: 0, z: 0, heading: 0 }, 'cat-1', LAUNCH_DISTANCE)
    const turned = catapultLaunch(
      { x: 0, z: 0, heading: Math.PI / 2 },
      'cat-1',
      LAUNCH_DISTANCE,
    )
    // 右回りが正。90 度回すと −Z（北）向きが +X（東）向きになる（Phase 9 の段 1 までは −X だった）
    expect(straight.direction.z).toBeLessThan(-0.9)
    expect(turned.direction.x).toBeGreaterThan(0.9)
    expect(Math.abs(turned.direction.z)).toBeLessThan(0.2)
  })

  it('射出の向きは heading だけ右回りに回る（HUD の headingOf と同じ約束）', () => {
    // cat-1 そのものが艦の軸から 4.03 度傾いているので、回した差で見る
    const at = (h: number) => {
      const d = catapultLaunch({ x: 0, z: 0, heading: h }, 'cat-1', LAUNCH_DISTANCE).direction
      return headingOf(d.x, d.y, d.z)
    }
    const base = at(0)
    for (const h of [0.35, -0.35, 1.2, -2.5, 3]) {
      expect(wrapAngle(at(h) - base - h), `heading ${h}`).toBeCloseTo(0, 9)
    }
  })
})

/**
 * 台本の発進。**ミッションと射出の台本は艦首の cat-2 から出る**（ユーザーの判断、2026-10-07。
 * 甲板の中央付近から発進させたい）。cat-2 は中心線にいちばん近い帯で、艦の軸から 2.21 度
 * 傾く。段 4 では軸と平行な cat-4（斜め甲板の外側、左舷寄り x −31 m）だった
 */
describe('台本の発進', () => {
  it.each(['mission-01', 'catapult-launch'] as const)('%s は中心線の近くから、cat-2 の帯に沿って射出される', (name) => {
    const script = SCRIPTS[name]
    expect(script.launchFrom).toBe('cat-2')
    const launch = worldOptionsFromScript(script).launch!
    // 空母の座標へ戻す（heading 0 の台本なので、位置を引くだけ）
    expect(script.carrier.heading).toBe(0)
    const x = launch.from.x - script.carrier.x
    const z = launch.from.z - script.carrier.z
    expect(Math.abs(x), '中心線から 1 m 以内').toBeLessThan(1)
    expect(z).toBeGreaterThan(-80)
    expect(z).toBeLessThan(-65)
    const angle = (Math.atan2(-launch.direction.x, -launch.direction.z) * 180) / Math.PI
    expect(angle).toBeCloseTo(2.21, 1)
  })
})
