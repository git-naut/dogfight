import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PRESET,
  PRESET_ORDER,
  PerformanceGovernor,
  QUALITY_PRESETS,
  getQuality,
  isPresetName,
  lowerPreset,
  resolvePreset,
} from '@render/quality'

describe('品質プリセットの表', () => {
  it('4 段そろっている', () => {
    expect(PRESET_ORDER).toEqual(['low', 'medium', 'high', 'ultra'])
    for (const name of PRESET_ORDER) {
      expect(QUALITY_PRESETS[name]).toBeDefined()
    }
  })

  it('レンダースケールが段ごとに上がる', () => {
    const scales = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].renderScale)
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]!).toBeGreaterThan(scales[i - 1]!)
    }
  })

  it('異方性フィルタが段ごとに上がる', () => {
    const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].anisotropy)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
  })

  it('影のカスケード段数が段ごとに増える', () => {
    const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].shadowCascades)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
  })

  it('雲のステップ数が段ごとに増える', () => {
    const steps = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].cloudMaxSteps)
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeGreaterThan(steps[i - 1]!)
    }
    const light = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].cloudLightSteps)
    for (let i = 1; i < light.length; i++) {
      expect(light[i]!).toBeGreaterThan(light[i - 1]!)
    }
  })

  it('雲の解像度が段ごとに上がる', () => {
    const scales = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].cloudResolutionScale)
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]!).toBeGreaterThan(scales[i - 1]!)
    }
  })

  it('雲の解像度が 1 を超えない', () => {
    // 画面より高い解像度でマーチしても意味がない
    for (const name of PRESET_ORDER) {
      expect(QUALITY_PRESETS[name].cloudResolutionScale).toBeGreaterThan(0)
      expect(QUALITY_PRESETS[name].cloudResolutionScale).toBeLessThanOrEqual(1)
    }
  })

  it('High は実機の計測に基づく値になっている', () => {
    // Intel Arc 140V の実測で、1/4 のとき雲 2.7 ms・全体 5.2 ms / 16.7 ms。
    // 1/2 なら画素数 4 倍で 13 ms 前後に収まる
    expect(QUALITY_PRESETS.high.cloudResolutionScale).toBeCloseTo(0.5, 6)
  })

  it('光マーチのステップ数がシェーダの上限を超えない', () => {
    // clouds.frag のループは 8 回で打ち切っている
    for (const name of PRESET_ORDER) {
      expect(QUALITY_PRESETS[name].cloudLightSteps).toBeLessThanOrEqual(8)
    }
  })

  it('主マーチのステップ数がシェーダの上限を超えない', () => {
    // clouds.frag のループは 512 回で打ち切っている。プリセットの歩数は
    // それより小さくないと、打ち切りの検出（?probe=2）が働かない
    for (const name of PRESET_ORDER) {
      expect(QUALITY_PRESETS[name].cloudMaxSteps).toBeLessThanOrEqual(512)
    }
  })

  it('low だけ雲のディテールと地面の雲影を切っている', () => {
    expect(QUALITY_PRESETS.low.cloudDetail).toBe(false)
    expect(QUALITY_PRESETS.low.cloudGroundShadow).toBe(false)
    for (const name of ['medium', 'high', 'ultra'] as const) {
      expect(QUALITY_PRESETS[name].cloudDetail).toBe(true)
      expect(QUALITY_PRESETS[name].cloudGroundShadow).toBe(true)
    }
  })

  it('low だけ SMAA を切っている', () => {
    expect(QUALITY_PRESETS.low.smaa).toBe(false)
    expect(QUALITY_PRESETS.medium.smaa).toBe(true)
    expect(QUALITY_PRESETS.high.smaa).toBe(true)
    expect(QUALITY_PRESETS.ultra.smaa).toBe(true)
  })

  it('既定は high', () => {
    expect(DEFAULT_PRESET).toBe('high')
    expect(getQuality(DEFAULT_PRESET).renderScale).toBe(1)
  })

  it('すべての値が正で有限', () => {
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      for (const [key, value] of Object.entries(q)) {
        if (typeof value !== 'number') continue
        expect(Number.isFinite(value), `${name}.${key}`).toBe(true)
        expect(value, `${name}.${key}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('プリセット名の解決', () => {
  it('正しい名前をそのまま返す', () => {
    for (const name of PRESET_ORDER) {
      expect(resolvePreset(name)).toBe(name)
    }
  })

  it('不正な入力は既定へ倒れる', () => {
    for (const bad of ['', 'HIGH', 'extreme', null, undefined]) {
      expect(resolvePreset(bad)).toBe(DEFAULT_PRESET)
    }
  })

  it('isPresetName が型を絞れる', () => {
    expect(isPresetName('ultra')).toBe(true)
    expect(isPresetName('Ultra')).toBe(false)
    expect(isPresetName(42)).toBe(false)
  })

  it('lowerPreset が1段下を返し、最下段では null', () => {
    expect(lowerPreset('ultra')).toBe('high')
    expect(lowerPreset('high')).toBe('medium')
    expect(lowerPreset('medium')).toBe('low')
    expect(lowerPreset('low')).toBeNull()
  })
})

describe('自動降格', () => {
  const frame = (fps: number) => 1 / fps

  it('目標を上回っている間は動かない', () => {
    const governor = new PerformanceGovernor(55, 3)
    for (let i = 0; i < 600; i++) {
      expect(governor.update(frame(60), 'high')).toBeNull()
    }
  })

  it('一瞬の落ち込みでは降格しない', () => {
    const governor = new PerformanceGovernor(55, 3)
    // 1 秒だけ 30fps
    for (let i = 0; i < 30; i++) {
      expect(governor.update(frame(30), 'high')).toBeNull()
    }
    // 戻れば蓄積がリセットされる
    expect(governor.update(frame(60), 'high')).toBeNull()
  })

  it('継続して下回ると 1 段落とす', () => {
    const governor = new PerformanceGovernor(55, 3)
    let result: string | null = null
    for (let i = 0; i < 200 && result === null; i++) {
      result = governor.update(frame(30), 'high')
    }
    expect(result).toBe('medium')
  })

  it('降格の直後は続けて落とさない', () => {
    const governor = new PerformanceGovernor(55, 3, 5)
    let first: string | null = null
    for (let i = 0; i < 200 && first === null; i++) {
      first = governor.update(frame(30), 'high')
    }
    expect(first).toBe('medium')

    // クールダウン中は 30fps が続いても動かない
    for (let i = 0; i < 100; i++) {
      expect(governor.update(frame(30), 'medium')).toBeNull()
    }
  })

  it('最下段からは降格しない', () => {
    const governor = new PerformanceGovernor(55, 3)
    for (let i = 0; i < 600; i++) {
      expect(governor.update(frame(20), 'low')).toBeNull()
    }
  })

  it('不正な dt を無視する', () => {
    const governor = new PerformanceGovernor(55, 3)
    expect(governor.update(0, 'high')).toBeNull()
    expect(governor.update(-1, 'high')).toBeNull()
    expect(governor.update(Number.NaN, 'high')).toBeNull()
  })

  it('reset で蓄積が消える', () => {
    const governor = new PerformanceGovernor(55, 3)
    for (let i = 0; i < 100; i++) governor.update(frame(30), 'high')
    governor.reset()
    // リセット直後は 3 秒ぶん貯まるまで降格しない
    expect(governor.update(frame(30), 'high')).toBeNull()
  })
})
