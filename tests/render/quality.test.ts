import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PRESET,
  PRESET_ORDER,
  PerformanceGovernor,
  higherPreset,
  QUALITY_PRESETS,
  getQuality,
  isPresetName,
  lowerPreset,
  resolvePreset,
  type PresetName,
} from '@render/quality'
import {
  LIGHT_MARCH_LIMIT,
  MARCH_LOOP_LIMIT,
  NEAR_STEP,
  stepGrowthScale,
} from '@render/clouds/geometry'

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

  it('機体まわりの 2 項目が段ごとに増える', () => {
    // 影マップと軌跡の分割数。Low は 0 で機能そのものを切る。環境反射は段 S2b-2 で
    // 大きさを持たなくなり、入れるか切るかの列になった（下の検査）
    for (const key of [
      'aircraftShadowMapSize',
      'trailSegments',
    ] as const) {
      const values = PRESET_ORDER.map((n) => QUALITY_PRESETS[n][key])
      expect(values[0], `${key} の low は 0`).toBe(0)
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `${key} の ${PRESET_ORDER[i]}`).toBeGreaterThan(values[i - 1]!)
      }
    }
  })

  it('影マップの一辺が 2 のべき乗', () => {
    // ミップマップの都合。2 のべき乗でないと three がリサイズしたり品質が落ちたりする
    for (const key of ['aircraftShadowMapSize'] as const) {
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
    // TSL のループ（`marchNodes.ts`）は `LIGHT_MARCH_LIMIT` 回で打ち切っている
    // （段 S1 まではこの値を GLSL の `clouds.frag` が写しで持っていた）
    expect(LIGHT_MARCH_LIMIT).toBe(8)
    for (const name of PRESET_ORDER) {
      expect(QUALITY_PRESETS[name].cloudLightSteps).toBeLessThanOrEqual(LIGHT_MARCH_LIMIT)
    }
  })

  it('主マーチのステップ数がシェーダの上限を超えない', () => {
    // TSL のループは `MARCH_LOOP_LIMIT` 回で打ち切っている。プリセットの歩数は
    // それより小さくないと、打ち切りの検出（`?marchprobe=1` の `exhausted`）が働かない
    expect(MARCH_LOOP_LIMIT).toBe(512)
    for (const name of PRESET_ORDER) {
      expect(QUALITY_PRESETS[name].cloudMaxSteps).toBeLessThanOrEqual(MARCH_LOOP_LIMIT)
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

  it('ブルームの強さが段ごとに下がらず、low だけ 0', () => {
    // **low は掛けない。**全画面に掛かるので、いちばん弱い機械で最初に外す
    expect(QUALITY_PRESETS.low.bloomStrength).toBe(0)
    for (const name of ['medium', 'high', 'ultra'] as const) {
      expect(QUALITY_PRESETS[name].bloomStrength).toBeGreaterThan(0)
    }
    // 段が逆転していないこと。**表の上下と絵の強さを揃える**
    let previous = -1
    for (const name of PRESET_ORDER) {
      const value = QUALITY_PRESETS[name].bloomStrength
      expect(value, `${name} が前の段より弱い`).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('風圧は low だけ切れている', () => {
    // **段ではなく切り替え。**3 つの効果（放射ブラー・色収差・ビネット）は
    // 同じ荷重倍数から導く 1 つの演出なので、強さの段を持たない。持つのは
    // 「掛ける機構があるか」だけ
    expect(QUALITY_PRESETS.low.lensEffects).toBe(false)
    for (const name of ['medium', 'high', 'ultra'] as const) {
      expect(QUALITY_PRESETS[name].lensEffects).toBe(true)
    }
  })

  it('既定は high', () => {
    expect(DEFAULT_PRESET).toBe('high')
    expect(getQuality(DEFAULT_PRESET).renderScale).toBe(1)
  })

  it('環境反射は low だけ切る', () => {
    // 段 S2b-2 で大きさの列（skyEnvironmentSize、low は 0）を置き換えた。low で切る
    // 決まりは前の列から引き継ぐ
    expect(QUALITY_PRESETS.low.skyEnvironment).toBe(false)
    for (const name of PRESET_ORDER.filter((n) => n !== 'low')) {
      expect(QUALITY_PRESETS[name].skyEnvironment, name).toBe(true)
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
      'trailSegments',
      'missileTrailSegments',
      'explosionSprites',
      // 子の火の玉。low では主の 1 個だけ
      'explosionBlobs',
      // 白い煙の尾。low では出さない
      'explosionSmokeTrails',
      'damageSmokeSegments',
      'flareSprites',
      // 発射炎と炎の尾。low では出さない（段 B9）
      'missileFlameSprites',
      // ブルーム。low では掛けない
      'bloomStrength',
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
 * 軽くなったら戻す（Phase 10、ADR 0042）。それまでは一度落ちると戻らなかった。
 * 値は既定（58 fps が 10 秒・切り替え後 5 秒・15 秒以内に落ちたら待ちを 2 倍・最長 60 秒）
 */
describe('自動の昇格', () => {
  const frame = (fps: number) => 1 / fps

  /** fps で seconds 秒ぶん流し、最初に返った切り替えと、その秒を返す */
  function run(
    governor: PerformanceGovernor,
    fps: number,
    seconds: number,
    current: PresetName,
    ceiling: PresetName,
  ): { next: PresetName | null; at: number } {
    const n = Math.round(seconds * fps)
    for (let i = 0; i < n; i++) {
      const next = governor.update(frame(fps), current, ceiling)
      if (next !== null) return { next, at: (i + 1) / fps }
    }
    return { next: null, at: seconds }
  }

  it('1 段上と最上段', () => {
    expect(higherPreset('low')).toBe('medium')
    expect(higherPreset('high')).toBe('ultra')
    expect(higherPreset('ultra')).toBeNull()
  })

  it('58 fps 以上が 10 秒続いたら 1 段戻す', () => {
    const governor = new PerformanceGovernor()
    const result = run(governor, 60, 20, 'medium', 'high')
    expect(result.next).toBe('high')
    expect(result.at).toBeGreaterThan(9.9)
    expect(result.at).toBeLessThan(10.1)
  })

  it('上限（人が選んだ画質）より上へは戻さない', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 60, 60, 'high', 'high').next).toBeNull()
    // 上限を省けば戻さない（今までの呼び方）
    expect(run(governor, 60, 60, 'medium', 'medium').next).toBeNull()
  })

  it('55〜58 fps のあいだでは戻さない', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 56, 60, 'medium', 'high').next).toBeNull()
  })

  it('ときどきの 33 ms のコマは平均で見て、戻すのを遅らせない', () => {
    // 実機で画質を固定しても 10 秒に 0〜4 枚出る（描画の更新を 1 回逃したコマ）
    const governor = new PerformanceGovernor()
    let result: PresetName | null = null
    let seconds = 0
    for (let i = 0; i < 1200 && result === null; i++) {
      const dt = i % 150 === 149 ? 2 / 60 : 1 / 60
      seconds += dt
      result = governor.update(dt, 'medium', 'high')
    }
    expect(result).toBe('high')
    expect(seconds).toBeLessThan(10.1)
  })

  it('重い 2 秒が窓に入れば、その窓では戻さない', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 60, 7, 'medium', 'high').next).toBeNull()
    expect(run(governor, 30, 2, 'medium', 'high').next).toBeNull()
    // 7 + 2 + 1 = 10 秒で窓を閉じる。平均は (420 + 60 + 60) / 10 = 54 fps
    expect(run(governor, 60, 1, 'medium', 'high').next).toBeNull()
    // 次の窓は軽いまま 10 秒で戻す
    expect(run(governor, 60, 11, 'medium', 'high').next).toBe('high')
  })

  it('落とした直後の 5 秒は数えない', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 30, 10, 'high', 'high').next).toBe('medium')
    // 落とした直後から軽くなっても、5 秒 + 10 秒で戻る
    const result = run(governor, 60, 30, 'medium', 'high')
    expect(result.next).toBe('high')
    expect(result.at).toBeGreaterThan(14.9)
    expect(result.at).toBeLessThan(15.1)
  })

  it('戻した直後の 5 秒は判断しない（組み直しの重さで落とさない）', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 60, 20, 'medium', 'high').next).toBe('high')
    // 戻した直後に 4 秒重くても落とさない。判断しない 5 秒が無ければ 3 秒で落ちる
    expect(run(governor, 30, 4, 'high', 'high').next).toBeNull()
  })

  it('重い → 戻る の流れで落ちて戻る', () => {
    const governor = new PerformanceGovernor()
    let current: PresetName = 'high'
    const changes: string[] = []
    const steps: [number, number][] = [[20, 8], [60, 30]]
    for (const [fps, seconds] of steps) {
      for (let i = 0; i < seconds * fps; i++) {
        const next = governor.update(frame(fps), current, 'high')
        if (next !== null) {
          changes.push(next)
          current = next
        }
      }
    }
    // 8 秒の重さで 1 段だけ落ち（3 秒 + 5 秒待ち）、軽くなって戻る
    expect(changes).toEqual(['medium', 'high'])
  })

  it('戻してすぐ落ちたら、次に戻すまでの待ちを 2 倍にする（最長 60 秒）', () => {
    const governor = new PerformanceGovernor()
    expect(governor.upgradeSeconds).toBe(10)
    let current: PresetName = 'medium'
    for (let round = 0; round < 4; round++) {
      const up = run(governor, 60, 120, current, 'high')
      expect(up.next).toBe('high')
      current = 'high'
      // 戻した直後の 5 秒が過ぎてから 3 秒で落ちる → 戻して 15 秒以内
      const down = run(governor, 30, 20, current, 'high')
      expect(down.next).toBe('medium')
      current = 'medium'
    }
    // 10 → 20 → 40 → 60（上限）
    expect(governor.upgradeSeconds).toBe(60)
  })

  it('戻して 15 秒より後に落ちたなら、待ちは延ばさない', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 60, 20, 'medium', 'high').next).toBe('high')
    expect(run(governor, 60, 20, 'high', 'high').next).toBeNull()
    expect(run(governor, 30, 10, 'high', 'high').next).toBe('medium')
    expect(governor.upgradeSeconds).toBe(10)
  })

  it('reset で数えかけの窓が消える', () => {
    const governor = new PerformanceGovernor()
    expect(run(governor, 60, 9, 'medium', 'high').next).toBeNull()
    governor.reset()
    expect(run(governor, 60, 9, 'medium', 'high').next).toBeNull()
  })
})

/**
 * 影マップのフィルタの列。
 *
 * **既定の経路は読まない。**段 15 の規約どおり実装より先に列を作った
 * （`CLAUDE.md`）。段 18 で経路を切り替えたとき、影が映る 12 枚がここで動く。
 */
describe('機体の外板の細部', () => {
  const RANK: Record<string, number> = { none: 0, procedural: 1 }

  it('全プリセットが知っている値を持つ', () => {
    for (const name of PRESET_ORDER) {
      const detail = QUALITY_PRESETS[name].materialDetail
      expect(RANK[detail], `${name} の materialDetail: ${detail}`).toBeDefined()
    }
  })

  it('プリセットが上がるほど強くなる（下がらない）', () => {
    const ranks = PRESET_ORDER.map((n) => RANK[QUALITY_PRESETS[n].materialDetail]!)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!, `${PRESET_ORDER[i]} が ${PRESET_ORDER[i - 1]} より弱い`)
        .toBeGreaterThanOrEqual(ranks[i - 1]!)
    }
  })

  it('既定のプリセットで効いている', () => {
    // **判定道具は既定の絵で測る。**既定で切れていると、効果を入れても
    // 基準画像にも実機にも出ない
    expect(QUALITY_PRESETS[DEFAULT_PRESET].materialDetail).toBe('procedural')
  })
})

describe('発光体のブルーム', () => {
  it('ブルームを掛けないプリセットでは入らない', () => {
    // **払わない費用を宣言しない。**ブルームが無ければ emissive を書いても誰も読まない
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      if (q.bloomStrength === 0) expect(q.bloomEmissive, name).toBe(false)
    }
  })

  it('既定のプリセットでは入る', () => {
    expect(QUALITY_PRESETS[DEFAULT_PRESET].bloomEmissive).toBe(true)
  })
})

describe('キャノピーの clearcoat', () => {
  it('上のプリセットほど入る（一度入ったら切れない）', () => {
    const on = PRESET_ORDER.map((n) => QUALITY_PRESETS[n].canopyClearcoat)
    for (let i = 1; i < on.length; i++) {
      if (on[i - 1]) expect(on[i], `${PRESET_ORDER[i]} で切れる`).toBe(true)
    }
  })

  it('low は入れず、既定のプリセットでは入る', () => {
    expect(QUALITY_PRESETS.low.canopyClearcoat).toBe(false)
    expect(QUALITY_PRESETS[DEFAULT_PRESET].canopyClearcoat).toBe(true)
  })
})

describe('影のフィルタ', () => {
  // `pcfSoft` は three 0.186 で無くなったので表から落とした（`quality.ts`）。
  // **ここに残すと「表に無い値を知っている検査」になる**ので一緒に消す
  const RANK: Record<string, number> = { basic: 0, pcf: 1 }

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
