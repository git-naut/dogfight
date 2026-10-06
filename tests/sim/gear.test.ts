import { describe, it, expect } from 'vitest'
import {
  GEAR_DRAG_COEFFICIENT,
  GEAR_SPEED_LIMIT,
  GEAR_TRANSIT_SECONDS,
  createAircraftSample,
} from '@sim/aircraft'
import { AIRCRAFT, dragMagnitude } from '@sim/flightModel'
import { airDensity, dynamicPressure } from '@sim/isa'
import { FIXED_DT } from '@sim/loop'
import { neutralInput, type InputState } from '@sim/input'
import { World, createWorldFromScript, runScript, worldOptionsFromScript } from '@sim/world'
import { getScript, SCRIPTS } from '@sim/scripts'
import type { ReplayScript } from '@sim/replay'

/**
 * 降着装置（Phase 9 の段 5）。G キーで出し入れし、脚は `GEAR_TRANSIT_SECONDS` かけて動き、
 * 出ている割合に比例して抗力が増える。段 4 までは対地 80 m で瞬時に出し入れしていた。
 *
 * 秒数・抗力・速度の上限は推測の値（ADR 0018）。ここでは値そのものより、値どおりに
 * 振る舞うことを固定する
 */

/** 高度 1,000 m を 120 m/s で水平に飛ぶ台本。`gearDown` だけ変える */
function level(gearDown: boolean, speed = 120): ReplayScript {
  return {
    name: 'gear-test',
    seed: 1,
    spawn: { altitude: 1000, speed, ...(gearDown ? { gearDown: true } : {}) },
    keyframes: [],
  }
}

function worldOf(script: ReplayScript): World {
  return new World(worldOptionsFromScript(script))
}

/** `frames` ステップ進める。`input` は毎ステップ同じものを渡す */
function run(world: World, frames: number, input: Partial<InputState> = {}): void {
  // 台本のトリムのスロットルを保つ
  const base = { ...neutralInput(), throttle: world.player.throttle, ...input }
  for (let i = 0; i < frames; i++) world.step(base)
}

const FRAMES_PER_TRANSIT = Math.round(GEAR_TRANSIT_SECONDS / FIXED_DT)

describe('脚の状態', () => {
  it('既定は上げ切りで始まる。台本の spawn.gearDown で出し切りから始められる', () => {
    expect(worldOf(level(false)).player.gearPosition).toBe(0)
    const down = worldOf(level(true)).player
    expect(down.gearPosition).toBe(1)
    expect(down.gearCommandDown).toBe(true)
  })

  it('押しっぱなしでも切り替わるのは 1 回だけ', () => {
    const world = worldOf(level(false))
    run(world, 30, { gearToggle: true })
    expect(world.player.gearCommandDown).toBe(true)
    // 離してもう一度押すと戻る
    run(world, 1, { gearToggle: false })
    run(world, 1, { gearToggle: true })
    expect(world.player.gearCommandDown).toBe(false)
  })

  it(`脚は ${GEAR_TRANSIT_SECONDS} 秒かけて一定の速さで動く`, () => {
    const world = worldOf(level(false))
    run(world, 1, { gearToggle: true })
    // 押したステップから動き始める
    expect(world.player.gearPosition).toBeCloseTo(1 / FRAMES_PER_TRANSIT, 9)
    run(world, FRAMES_PER_TRANSIT / 2 - 1)
    expect(world.player.gearPosition).toBeCloseTo(0.5, 9)
    run(world, FRAMES_PER_TRANSIT / 2)
    expect(world.player.gearPosition).toBe(1)
    // 出し切ったら止まる
    run(world, 60)
    expect(world.player.gearPosition).toBe(1)
  })

  it('出している途中で押すと、その位置から引き返す', () => {
    const world = worldOf(level(false))
    run(world, 1, { gearToggle: true })
    run(world, FRAMES_PER_TRANSIT / 4 - 1)
    const middle = world.player.gearPosition
    run(world, 1, { gearToggle: true })
    expect(world.player.gearPosition).toBeLessThan(middle)
  })

  it('墜落したあとは切り替わらない', () => {
    const world = worldOf(level(false))
    world.player.crashed = true
    run(world, 1, { gearToggle: true })
    expect(world.player.gearCommandDown).toBe(false)
  })
})

describe('脚の抗力', () => {
  /**
   * 同じ台本を脚の有無だけ変えて 1 ステップ回し、速度の変化の差を力へ直す。**期待値は
   * 定数から作るが、式は `dragMagnitude` を通さない書き方で書く**（q·S·ΔCd）
   */
  it('出し切ると、抗力が q·S·ΔCd だけ増える', () => {
    const up = worldOf(level(false))
    const down = worldOf(level(true))
    run(up, 1)
    run(down, 1)
    const q = dynamicPressure(airDensity(1000), 120)
    const expected = q * AIRCRAFT.wingArea * GEAR_DRAG_COEFFICIENT
    // 1 ステップぶんの速度差 × 質量 / dt が、速度方向の力の差
    const dv = up.player.speed - down.player.speed
    expect((dv * AIRCRAFT.mass) / FIXED_DT).toBeCloseTo(expected, -1)
    expect(expected).toBeGreaterThan(5000)
    // 書き方を変えた式と一致する（`dragMagnitude` の係数の扱いを確かめる）
    expect(dragMagnitude(q, GEAR_DRAG_COEFFICIENT)).toBeCloseTo(expected, 6)
  })

  it('脚を出したまま 10 秒飛ぶと、上げているときより遅くなる', () => {
    const up = worldOf(level(false))
    const down = worldOf(level(true))
    run(up, 1200)
    run(down, 1200)
    // 実測で 119.9 m/s と 116.8 m/s。入力なしなので高度も動き、差は抗力だけでは決まらない
    expect(up.player.speed - down.player.speed).toBeGreaterThan(2)
  })
})

describe('甲板の上', () => {
  it('射出の台本は脚を出し切って甲板で待つ', () => {
    const { world } = createWorldFromScript(SCRIPTS['catapult-launch'])
    expect(world.player.gearPosition).toBe(1)
  })

  /** 実機も車輪に重さが掛かっているあいだは脚が上がらない */
  it('甲板で待つあいだと射出中は G を受け付けない', () => {
    const { world } = createWorldFromScript(SCRIPTS['catapult-launch'])
    // 甲板で押す
    for (let f = 0; f < 30; f++) world.step({ ...neutralInput(), throttle: 0, gearToggle: f >= 10 })
    expect(world.player.gearCommandDown).toBe(true)
    // 押したまま射出して飛び立つ。**押しっぱなしなので、飛び立っても切り替わらない**
    for (let f = 0; f < 400; f++) world.step({ ...neutralInput(), throttle: 1, gearToggle: true })
    expect(world.catapult?.phase).toBe('airborne')
    expect(world.player.gearCommandDown).toBe(true)
    // 離して押し直すと上がり始める
    world.step({ ...neutralInput(), throttle: 1, gearToggle: false })
    world.step({ ...neutralInput(), throttle: 1, gearToggle: true })
    expect(world.player.gearCommandDown).toBe(false)
  })

  it.each(['catapult-launch', 'mission-01'] as const)('%s は f720 で脚を上げ、f1320 に上がり切る', (name) => {
    expect(runScript(getScript(name), 719).player.gearPosition).toBe(1)
    const half = runScript(getScript(name), 720 + FRAMES_PER_TRANSIT / 2).player.gearPosition
    expect(half).toBeCloseTo(0.5, 2)
    expect(runScript(getScript(name), 720 + FRAMES_PER_TRANSIT).player.gearPosition).toBe(0)
  })
})

describe('速度の上限', () => {
  it('250 kt', () => {
    expect(GEAR_SPEED_LIMIT).toBeCloseTo(128.61, 2)
  })

  it('脚が出ていて上限を超えると警告の旗が立ち、上げていれば立たない', () => {
    const sample = createAircraftSample()
    const fast = worldOf(level(true, 150))
    run(fast, 1)
    expect(fast.player.sample(1, sample).gearOverspeed).toBe(true)

    const slow = worldOf(level(true, 120))
    run(slow, 1)
    expect(slow.player.sample(1, sample).gearOverspeed).toBe(false)

    const up = worldOf(level(false, 150))
    run(up, 1)
    expect(up.player.sample(1, sample).gearOverspeed).toBe(false)
  })

  it('サンプルの gearDown は脚が少しでも出ているとき true（描画が脚を出す）', () => {
    const sample = createAircraftSample()
    const world = worldOf(level(false))
    expect(world.player.sample(1, sample).gearDown).toBe(false)
    run(world, 1, { gearToggle: true })
    const s = world.player.sample(1, sample)
    expect(s.gearDown).toBe(true)
    expect(s.gearPosition).toBeGreaterThan(0)
    expect(s.gearPosition).toBeLessThan(0.01)
  })
})
