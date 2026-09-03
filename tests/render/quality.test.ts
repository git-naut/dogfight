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
import { NEAR_STEP, stepGrowthScale } from '@render/clouds/geometry'

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

  it('機体まわりの 3 項目が段ごとに増える', () => {
    // 影マップ、環境反射、軌跡の分割数。Low は 0 で機能そのものを切る
    for (const key of [
      'aircraftShadowMapSize',
      'environmentMapSize',
      'trailSegments',
    ] as const) {
      const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n][key])
      expect(values[0], `${key} の low は 0`).toBe(0)
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `${key} の ${PRESET_ORDER[i]}`).toBeGreaterThan(values[i - 1]!)
      }
    }
  })

  it('影マップと環境反射の一辺が 2 のべき乗', () => {
    // キューブマップとミップマップの都合。2 のべき乗でないと three が
    // リサイズしたり品質が落ちたりする
    for (const key of ['aircraftShadowMapSize', 'environmentMapSize'] as const) {
      for (const name of PRESET_ORDER) {
        const size = QUALITY_PRESETS[name][key]
        if (size === 0) continue
        expect(Math.log2(size) % 1, `${key} の ${name} が ${size}`).toBe(0)
      }
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

  it('地形パッチの分割が段ごとに上がる', () => {
    const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].terrainPatchCells)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
  })

  it('地形の LOD 段数が段ごとに減らない', () => {
    // High と Ultra は同じ 7 段。段数を増やすより手前を細かくするほうが効く
    const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].terrainLodLevels)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    }
  })

  it('LOD の切り替え距離の倍率が段ごとに上がる', () => {
    const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].lodDistanceScale)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
  })

  it('地形の三角形数が予算に収まる', () => {
    // パッチは レベル0 が 4x4 の 16 枚、以降のリングが各 12 枚。
    // ポリゴン予算はシーン合計 1.5M（CLAUDE.md）
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      const patches = 16 + (q.terrainLodLevels - 1) * 12
      const triangles = patches * q.terrainPatchCells ** 2 * 2
      expect(triangles).toBeLessThan(1_000_000)
    }
  })

  it('low だけ地表の法線摂動と海面のスペキュラを切っている', () => {
    expect(QUALITY_PRESETS.low.terrainDetailNormals).toBe(false)
    expect(QUALITY_PRESETS.low.waterSpecular).toBe(false)
    for (const name of ['medium', 'high', 'ultra'] as const) {
      expect(QUALITY_PRESETS[name].terrainDetailNormals).toBe(true)
      expect(QUALITY_PRESETS[name].waterSpecular).toBe(true)
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

  it('大気の LUT の倍率が段ごとに下がらず、1 を超えない', () => {
    // **1 を超えさせない。**原本より大きくしても情報は増えず、起動時の
    // GPU 計算だけが面積の 2 乗で伸びる
    let previous = 0
    for (const name of PRESET_ORDER) {
      const scale = QUALITY_PRESETS[name].atmosphereLutScale
      expect(scale, `${name} の atmosphereLutScale`).toBeGreaterThanOrEqual(previous)
      expect(scale, `${name} の atmosphereLutScale`).toBeLessThanOrEqual(1)
      previous = scale
    }
  })

  it('遠景の霞の光線行進は上の段だけで入る', () => {
    // 毎フレームの費用なので、下の段では切る
    expect(QUALITY_PRESETS.low.aerialRaymarchScattering).toBe(false)
    expect(QUALITY_PRESETS.ultra.aerialRaymarchScattering).toBe(true)
    let seenTrue = false
    for (const name of PRESET_ORDER) {
      const on = QUALITY_PRESETS[name].aerialRaymarchScattering
      // 一度 true になったら下がらない
      if (seenTrue) expect(on, `${name} の aerialRaymarchScattering`).toBe(true)
      seenTrue ||= on
    }
  })

  it('空から焼く環境反射の一辺が 2 のべき乗で、段ごとに減らない', () => {
    let previous = 0
    for (const name of PRESET_ORDER) {
      const size = QUALITY_PRESETS[name].skyEnvironmentSize
      expect(size, `${name} の skyEnvironmentSize`).toBeGreaterThanOrEqual(previous)
      if (size > 0) {
        expect(Number.isInteger(Math.log2(size)), `${name} の skyEnvironmentSize`).toBe(
          true,
        )
      }
      previous = size
    }
  })

  it('雲のマーチの上限距離が段によらず同じ', () => {
    // **これは費用の段ではなく絵の決めごと。**段によって遠くの雲が
    // 出たり消えたりすると、品質を落としたときに構図が変わる
    const values = PRESET_ORDER.map((name) => QUALITY_PRESETS[name].cloudMaxDistance)
    expect(new Set(values).size, `段ごとに違う: ${values.join(', ')}`).toBe(1)
  })

  it('歩数が上限距離を歩幅の伸びで覆い切る', () => {
    // `stepGrowthScale` の契約。足りないとマーチが途中で止まり、止まる位置が
    // 空振りの歩数で決まるのでカメラの移動で前後する（遠くの雲が現れたり
    // 消えたりする形）
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      const g = stepGrowthScale(q.cloudMaxSteps, q.cloudMaxDistance)
      const reach = g * (Math.exp((NEAR_STEP * q.cloudMaxSteps) / g) - 1)
      // 二分法なので厳密には届かない（実測で 11999.999999999989）。
      // 1e-9 の相対誤差まで許す
      expect(reach, `${name} の到達距離`).toBeGreaterThanOrEqual(
        q.cloudMaxDistance * (1 - 1e-9),
      )
    }
  })

  it('上の 2 段は上限距離でも手前の 4 倍より細かく刻む', () => {
    // 「近くは細かいが遠くは粗い」を実機で指摘された経緯がある。
    // 下の 2 段は歩数が少ないので粗くなるのを許す
    for (const name of ['high', 'ultra'] as const) {
      const q = QUALITY_PRESETS[name]
      const g = stepGrowthScale(q.cloudMaxSteps, q.cloudMaxDistance)
      const far = NEAR_STEP * (1 + q.cloudMaxDistance / g)
      expect(far / NEAR_STEP, `${name} の上限での粗さ`).toBeLessThanOrEqual(4)
    }
  })

  it('すべての値が有限で、0 を許すのは機能を切る枠だけ', () => {
    // 0 は「その機能を使わない」の意味。Low で影と環境反射と軌跡を切る
    const zeroAllowed = new Set([
      'aircraftShadowMapSize',
      'environmentMapSize',
      'trailSegments',
      'missileTrailSegments',
      'explosionSprites',
      'damageSmokeSegments',
      'flareSprites',
      // 空から焼く環境反射。low では焼かない
      'skyEnvironmentSize',
    ])
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      for (const [key, value] of Object.entries(q)) {
        if (typeof value !== 'number') continue
        expect(Number.isFinite(value), `${name}.${key}`).toBe(true)
        if (zeroAllowed.has(key)) {
          expect(value, `${name}.${key}`).toBeGreaterThanOrEqual(0)
        } else {
          expect(value, `${name}.${key}`).toBeGreaterThan(0)
        }
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

/**
 * 影マップのフィルタの列。
 *
 * **既定の経路は読まない。**段 15 の規約どおり実装より先に列を作った
 * （`CLAUDE.md`）。段 18 で経路を切り替えたとき、影が映る 12 枚がここで動く。
 */
describe('影のフィルタ', () => {
  const RANK: Record<string, number> = { basic: 0, pcf: 1, pcfSoft: 2 }

  it('全プリセットが値を持つ', () => {
    for (const name of PRESET_ORDER) {
      const filter = QUALITY_PRESETS[name].shadowFilter
      expect(RANK[filter], `${name} の shadowFilter: ${filter}`).toBeDefined()
    }
  })

  it('プリセットが上がるほど強くなる（下がらない）', () => {
    const ranks = PRESET_ORDER.map((n) => RANK[QUALITY_PRESETS[n].shadowFilter]!)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!, `${PRESET_ORDER[i]} が ${PRESET_ORDER[i - 1]} より弱い`)
        .toBeGreaterThanOrEqual(ranks[i - 1]!)
    }
  })

  it('影を焼かないプリセットは強いフィルタを名乗らない', () => {
    // **払わない費用を宣言しない。**影マップが 0 なら係数は常に 1 になる
    for (const name of PRESET_ORDER) {
      const preset = QUALITY_PRESETS[name]
      if (preset.aircraftShadowMapSize === 0) {
        expect(preset.shadowFilter, `${name}`).toBe('basic')
      }
    }
  })

  it('検査そのものが働くことを、知らない値で確かめる', () => {
    expect(RANK['notAFilter']).toBeUndefined()
  })
})
