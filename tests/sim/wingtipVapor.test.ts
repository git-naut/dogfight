import { describe, expect, it } from 'vitest'
import { AIRCRAFT } from '../../src/sim/flightModel'
import { SCRIPTS } from '../../src/sim/scripts'
import { createWorldFromScript } from '../../src/sim/world'

/** 台本を N フレーム進めて水蒸気を読む */
function vaporAt(name: keyof typeof SCRIPTS, frames: number): number {
  const { world, player } = createWorldFromScript(SCRIPTS[name])
  for (let f = 0; f < frames; f++) world.step(player.at(f))
  return world.player.wingtipVapor
}

/**
 * 翼端の水蒸気。
 *
 * 駆動量は マッハ数 × 揚力係数。荷重倍数だけで見ると定常旋回（3.0〜3.3 G）を
 * 取りこぼし、揚力係数だけで見ると速い引き起こし（6.86 G・340 m/s で
 * Cl 0.453）を取りこぼす。どちらも実際に踏んだ。
 */
describe('wingtipVapor', () => {
  it('水平飛行では出ない', () => {
    expect(vaporAt('low-pass', 2500)).toBeLessThan(0.1)
  })

  it('高速で荷重倍数の低い引き起こしでは出ない。3.39 G でも足りない', () => {
    expect(vaporAt('island-run', 2000)).toBeLessThan(0.25)
  })

  it('定常旋回では出る。荷重倍数は 3.08 しかない', () => {
    expect(vaporAt('bank-left', 1800)).toBeGreaterThan(0.3)
  })

  it('速い急上昇でも出る。揚力係数は旋回より低い', () => {
    expect(vaporAt('zoom-climb', 200)).toBeGreaterThan(0.35)
  })

  it('高 G の引き起こしがいちばん濃い', () => {
    expect(vaporAt('pull-up', 900)).toBeGreaterThan(vaporAt('zoom-climb', 200))
  })

  it('立ち上がりは速く、消えるのは遅い', () => {
    expect(AIRCRAFT.vaporFallTau).toBeGreaterThan(AIRCRAFT.vaporRiseTau * 5)
  })

  it('引くのをやめても 1.5 秒は閾値を保つ。軌跡が切れ端にならないため', () => {
    // zoom-climb は 2 秒で舵を戻す。その 1.5 秒後を見る
    const 舵を戻した直後 = vaporAt('zoom-climb', 2 * 120)
    const その15秒後 = vaporAt('zoom-climb', Math.round(3.5 * 120))
    expect(舵を戻した直後).toBeGreaterThan(0.35)
    expect(その15秒後).toBeGreaterThan(0.25)
    // 減っていること。残り続けたら物理として嘘になる
    expect(その15秒後).toBeLessThan(舵を戻した直後)
  })

  it('十分に時間が経てば閾値を割る', () => {
    expect(vaporAt('zoom-climb', 8 * 120)).toBeLessThan(0.25)
  })
})
