import { describe, it, expect } from 'vitest'
import { World, advanceScript, createWorldFromScript, runScript } from '@sim/world'
import { ReplayPlayer, type ReplayScript } from '@sim/replay'
import { SCRIPT_NAMES, getScript } from '@sim/scripts'
import { PILOT_AXES } from '@sim/pilots/pilot'
import { climbAngleOf } from '@sim/ai/steering'
import { PILOT_HOLD_F1800 } from '../fixtures/pilotHold'

/**
 * 台本の操縦役（Phase 9 の段 9）。
 *
 * 操縦軸とスロットルは操縦役が、ボタンはキーフレームが決める。操縦役のある台本のキーフレームに
 * 操縦軸とスロットルを書いたら落とす（ユーザーの判断、2026-10-14）。確かめ役は `hold`（翼を水平に
 * して上昇角 0、速さを保つ）と台本 `pilot-hold`
 */
const DEG = 180 / Math.PI

function stateOf(world: World): number[] {
  const { position: p, velocity: v, orientation: q } = world.player
  return [p.x, p.y, p.z, v.x, v.y, v.z, q.x, q.y, q.z, q.w, world.player.throttle]
}

describe('pilot-hold（操縦役 hold）', () => {
  it('30 度の傾きを 3 秒で水平に戻し、上昇角 0 を保つ', () => {
    const p = runScript(getScript('pilot-hold'), 360).player
    expect(Math.abs(p.bank * DEG)).toBeLessThan(0.5)
    expect(Math.abs(climbAngleOf(p.velocity) * DEG)).toBeLessThan(0.5)
  })

  it('15 秒（f1800）で速さが 220 m/s から ±1 m/s の内側に入り、高度は 20 m も変わらない', () => {
    const p = runScript(getScript('pilot-hold'), 1800).player
    expect(p.crashed).toBe(false)
    expect(Math.abs(p.speed - 220)).toBeLessThan(1)
    expect(Math.abs(climbAngleOf(p.velocity) * DEG)).toBeLessThan(0.1)
    expect(Math.abs(p.position.y - 1500)).toBeLessThan(20)
  })

  it('操縦役を外すと立て直さない（効いているのは操縦役）', () => {
    const script: ReplayScript = { ...getScript('pilot-hold'), name: 'no-pilot' }
    delete script.pilot
    const p = runScript(script, 360).player
    expect(Math.abs(p.bank * DEG)).toBeGreaterThan(20)
  })

  it('テストの経路の f1800 の状態を記録する（E2E がキャプチャの経路と照らす）', () => {
    expect(stateOf(runScript(getScript('pilot-hold'), 1800))).toEqual([...PILOT_HOLD_F1800])
  })

  it('createWorldFromScript と advanceScript で分けて進めても同じ状態になる', () => {
    const { world, player } = createWorldFromScript(getScript('pilot-hold'))
    advanceScript(world, player, 900)
    // 2 回に分けると、2 回目はフレーム 0 から数え直す。`ReplayPlayer` はフレームの昇順を前提にし、
    // キーフレームが無いのでずれない。操縦役の状態（積分）は持ち越される
    advanceScript(world, player, 900)
    expect(stateOf(world)).toEqual([...PILOT_HOLD_F1800])
  })
})

describe('軸の持ち主', () => {
  it('操縦役のある台本のキーフレームに、操縦軸とスロットルが書かれていない', () => {
    for (const name of SCRIPT_NAMES) {
      const script = getScript(name)
      if (script.pilot === undefined) continue
      for (const kf of script.keyframes) {
        for (const axis of PILOT_AXES) {
          expect(kf.input[axis], `${name} の f${kf.frame} に ${axis}`).toBeUndefined()
        }
      }
    }
  })

  it('ボタンはキーフレームが決め、操縦役は上書きしない', () => {
    const script: ReplayScript = {
      ...getScript('pilot-hold'),
      keyframes: [
        { frame: 10, input: { gearToggle: true, fireGun: true } },
        { frame: 12, input: { gearToggle: false } },
      ],
    }
    const { world, player } = createWorldFromScript(script)
    for (let i = 0; i < 20; i++) {
      const input = player.at(i, world.player)
      if (i >= 10) expect(input.fireGun, `f${i}`).toBe(true)
      world.step(input)
    }
    expect(world.player.gearCommandDown).toBe(true)
  })

  it('操縦役が操縦軸とスロットルを置く（キーフレームの既定値のままにしない）', () => {
    const { world, player } = createWorldFromScript(getScript('pilot-hold'))
    const input = player.at(0, world.player)
    // 右に 30 度傾いているので、左へ戻すロールが出る
    expect(input.roll).toBeLessThan(-0.1)
    expect(input.yaw).toBe(0)
  })

  it('操縦役のある台本で自機を渡し忘れると投げる（黙って効かなくならない）', () => {
    const player = new ReplayPlayer(getScript('pilot-hold'))
    expect(() => player.at(0)).toThrow()
    expect(player.piloted).toBe(true)
    expect(new ReplayPlayer(getScript('level')).piloted).toBe(false)
  })
})
