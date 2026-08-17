import { describe, it, expect } from 'vitest'
import { runScript, createWorldFromScript } from '@sim/world'
import { SCRIPTS, SCRIPT_NAMES, getScript, isScriptName } from '@sim/scripts'
import { spawnFromSpec, ReplayPlayer } from '@sim/replay'
import { airDensity } from '@sim/isa'
import { trimCondition } from '@sim/flightModel'

/**
 * 入力スクリプトによるリグレッション検証。
 *
 * 飛行モデルの係数をいじると、単体テストは通るのに手触りが壊れることがある。
 * 「この入力列でこう飛ぶ」を数値で固定しておけば、その退行を検出できる。
 */

const DEG = Math.PI / 180
const SEC = 120

describe('初期条件の展開', () => {
  it('トリムが解けていて開始直後に沈まない', () => {
    const spawn = spawnFromSpec({ altitude: 2000, speed: 250 })
    const { alpha, throttle } = trimCondition(250, airDensity(2000))

    expect(spawn.position.y).toBe(2000)
    expect(spawn.velocity.length()).toBeCloseTo(250, 9)
    expect(spawn.throttle).toBeCloseTo(throttle, 12)
    // 機首は迎角ぶん上を向いている
    expect(spawn.orientation.forward().y).toBeCloseTo(Math.sin(alpha), 9)
  })

  it('上昇角を指定すると速度ベクトルが傾く', () => {
    const spawn = spawnFromSpec({ altitude: 1000, speed: 200, climbAngle: 20 * DEG })
    expect(spawn.velocity.y).toBeCloseTo(200 * Math.sin(20 * DEG), 9)
    expect(spawn.velocity.length()).toBeCloseTo(200, 9)
  })

  it('バンクを指定すると機体が傾く', () => {
    const spawn = spawnFromSpec({ altitude: 1000, speed: 250, bank: 45 * DEG })
    // 右バンクなので機体右方向が下を向く
    expect(spawn.orientation.right().y).toBeLessThan(-0.6)
  })
})

describe('キーフレームの畳み込み', () => {
  it('指定のないキーは直前の値を引き継ぐ', () => {
    const player = new ReplayPlayer({
      name: 'test',
      seed: 1,
      spawn: { altitude: 1000, speed: 200 },
      keyframes: [
        { frame: 0, input: { pitch: 0.5 } },
        { frame: 10, input: { roll: -1 } },
      ],
    })

    expect(player.at(0).pitch).toBe(0.5)
    expect(player.at(5).roll).toBe(0)
    const at10 = player.at(10)
    expect(at10.roll).toBe(-1)
    expect(at10.pitch).toBe(0.5) // 引き継がれている
  })

  it('初期スロットルがトリム値になっている', () => {
    const spec = { altitude: 3000, speed: 280 }
    const player = new ReplayPlayer({ name: 't', seed: 1, spawn: spec, keyframes: [] })
    const expected = trimCondition(280, airDensity(3000)).throttle
    expect(player.at(0).throttle).toBeCloseTo(expected, 12)
  })
})

describe('スクリプトの登録', () => {
  it('5 本すべて引ける', () => {
    expect(SCRIPT_NAMES).toEqual([
      'level',
      'bank-left',
      'pull-up',
      'low-pass',
      'island-run',
    ])
    for (const name of SCRIPT_NAMES) {
      expect(getScript(name).name).toBe(name)
    }
  })

  it('未知の名前は level に倒れる', () => {
    expect(isScriptName('nope')).toBe(false)
    expect(getScript('nope').name).toBe('level')
  })
})

describe('level — 水平飛行の基準線', () => {
  it('10 秒間 高度と速度を保つ', () => {
    const world = runScript(SCRIPTS.level, SEC * 10)
    const p = world.player

    expect(p.crashed).toBe(false)
    expect(Math.abs(p.altitude - 2000)).toBeLessThan(50)
    expect(Math.abs(p.speed - 250)).toBeLessThan(10)
    expect(Math.abs(p.bank)).toBeLessThan(1 * DEG)
    expect(Math.abs(p.sideslip)).toBeLessThan(1 * DEG)
    expect(p.loadFactor).toBeCloseTo(1, 1)
  })

  it('60 秒でも高度が 200 m 以上ずれない', () => {
    const world = runScript(SCRIPTS.level, SEC * 60)
    expect(Math.abs(world.player.altitude - 2000)).toBeLessThan(200)
  })

  it('まっすぐ飛ぶ（横方向に流れない）', () => {
    const world = runScript(SCRIPTS.level, SEC * 20)
    // 20 秒で 5 km 進むうち、横ずれは 10 m 未満
    expect(Math.abs(world.player.position.x)).toBeLessThan(10)
    expect(-world.player.position.z).toBeGreaterThan(4500)
  })
})

describe('bank-left — 左旋回', () => {
  it('左にバンクして左へ回る', () => {
    const world = runScript(SCRIPTS['bank-left'], SEC * 6)
    const p = world.player

    expect(p.crashed).toBe(false)
    expect(p.bank).toBeLessThan(-30 * DEG)
    // 左旋回なので x は負側へ膨らむ
    expect(p.position.x).toBeLessThan(-100)
    expect(Math.abs(p.sideslip)).toBeLessThan(6 * DEG)
  })

  it('旋回で速度が落ちる', () => {
    const world = runScript(SCRIPTS['bank-left'], SEC * 6)
    expect(world.player.speed).toBeLessThan(260)
  })
})

describe('pull-up — 上昇', () => {
  it('高度が上がり機首が上を向く', () => {
    const world = runScript(SCRIPTS['pull-up'], SEC * 4)
    const p = world.player
    expect(p.altitude).toBeGreaterThan(1200)
    expect(p.orientation.forward().y).toBeGreaterThan(0.3)
    expect(p.crashed).toBe(false)
  })
})

describe('low-pass — 低空通過', () => {
  it('地面すれすれを保ったまま加速する', () => {
    const world = runScript(SCRIPTS['low-pass'], SEC * 5)
    const p = world.player
    expect(p.crashed).toBe(false)
    expect(p.altitude).toBeGreaterThan(100)
    expect(p.altitude).toBeLessThan(400)
    expect(p.speed).toBeGreaterThan(320)
  })
})

describe('再生の決定論', () => {
  it.each(SCRIPT_NAMES)('%s は 2 回再生しても同じ結果になる', (name) => {
    const a = runScript(SCRIPTS[name], SEC * 5)
    const b = runScript(SCRIPTS[name], SEC * 5)

    expect(a.frame).toBe(b.frame)
    expect(a.player.position.toArray()).toEqual(b.player.position.toArray())
    expect(a.player.velocity.toArray()).toEqual(b.player.velocity.toArray())
    expect(a.player.orientation.toArray()).toEqual(b.player.orientation.toArray())
  })

  it('途中経過も一致する（部分再生と通し再生が同じ）', () => {
    const full = runScript(SCRIPTS['bank-left'], SEC * 3)

    const { world, player } = createWorldFromScript(SCRIPTS['bank-left'])
    for (let i = 0; i < SEC * 3; i++) world.step(player.at(i))

    expect(world.player.position.toArray()).toEqual(full.player.position.toArray())
  })
})

describe('island-run — 島を越える', () => {
  it('海上から主峰の稜線を越え、40 秒間墜落しない', () => {
    const world = runScript(SCRIPTS['island-run'], SEC * 40)
    const p = world.player

    expect(p.crashed).toBe(false)
    // 主峰の稜線（約 1,500 m）より上にいる
    expect(p.position.y).toBeGreaterThan(1_500)
    // 島を越えて向こう側の海に出ている
    expect(p.groundHeight).toBe(0)
  })

  it('稜線の上で対地高度が海抜より小さくなる', () => {
    const world = runScript(SCRIPTS['island-run'], SEC * 30)
    const p = world.player

    expect(p.groundHeight).toBeGreaterThan(1_000)
    expect(p.agl).toBeLessThan(p.altitude - 1_000)
    // 地面には当たらない
    expect(p.agl).toBeGreaterThan(300)
  })
})
