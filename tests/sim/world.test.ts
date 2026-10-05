import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { World, createWorldFromScript, neutralInput, worldOptionsFromScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'
import { FIXED_DT } from '@sim/loop'

describe('World', () => {
  it('step ごとに frame が 1 増える', () => {
    const world = new World({ seed: 1 })
    const input = neutralInput()
    expect(world.frame).toBe(0)
    world.step(input)
    world.step(input)
    expect(world.frame).toBe(2)
  })

  it('time は frame から計算され、誤差が蓄積しない', () => {
    const world = new World({ seed: 1 })
    const input = neutralInput()
    const steps = 120 * 600 // 10 分相当

    for (let i = 0; i < steps; i++) world.step(input)

    // time += dt で積算していたらここで誤差が乗る。
    // frame * dt なら掛け算 1 回なので厳密に一致する。
    expect(world.time).toBe(steps * FIXED_DT)
    expect(world.time).toBeCloseTo(600, 9)
  })

  it('同じシードの World は同じ乱数状態をたどる', () => {
    const a = new World({ seed: 4242 })
    const b = new World({ seed: 4242 })
    for (let i = 0; i < 500; i++) {
      expect(a.rng.next()).toBe(b.rng.next())
    }
    expect(a.rng.snapshot).toBe(b.rng.snapshot)
  })

  it('neutralInput は舵中立・スロットル中間で返る', () => {
    const input = neutralInput()
    expect(input.pitch).toBe(0)
    expect(input.roll).toBe(0)
    expect(input.yaw).toBe(0)
    expect(input.throttle).toBe(0.5)
    expect(input.fireGun).toBe(false)
    expect(input.fireMissile).toBe(false)
  })
})

describe('空母の配置（段 37）', () => {
  it('台本の空母を保持する。空母の無い台本では null', () => {
    // mission-01 の空母は Z 8,000・艦首は北（scripts.ts）
    const withCarrier = createWorldFromScript(SCRIPTS['mission-01']).world
    expect(withCarrier.carrier).toEqual({ x: 0, z: 8000, heading: 0 })
    expect(createWorldFromScript(SCRIPTS['level']).world.carrier).toBeNull()
  })
})

describe('World の組み立ての一本化（Phase 9 の段 1）', () => {
  it('ライブ（main.ts）は台本から World を自分で組み立てず、worldOptionsFromScript を通す', () => {
    // 段 1 までは main.ts の spawnWorld が createWorldFromScript の中身を書き写していて、
    // 台本に項目を足すたびに 2 か所を直す必要があった（片方だけだとライブで射出が始まらない等）
    const main = readFileSync(fileURLToPath(new URL('../../src/main.ts', import.meta.url)), 'utf8')
    expect(main.includes('new World(worldOptionsFromScript(script, DEFAULT_SEED))')).toBe(true)
    expect(main.match(/new World\(\{/g), 'main.ts が World の設定を自分で組んでいる').toBeNull()
  })

  it('種だけを差し替えられ、ほかの設定は台本と同じ', () => {
    const script = SCRIPTS['mission-01']
    const own = worldOptionsFromScript(script)
    const live = worldOptionsFromScript(script, 12345)
    expect(own.seed).toBe(script.seed)
    expect(live.seed).toBe(12345)
    expect({ ...live, seed: own.seed }).toEqual(own)
  })
})
