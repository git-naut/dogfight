import { describe, expect, it } from 'vitest'
import { NODE_REFERENCE as ref } from '../e2e/nodeReference'
import { DEFAULT_COVERAGE } from '@render/pipeline/types'
import { SHADOW_TILES } from '@render/clouds/geometry'
import {
  MARCH_PROBE_HEIGHT,
  MARCH_PROBE_WIDTH,
  byteDifference,
} from '@render/clouds/marchProbe'
import {
  SPRITE_PROBE_SIDE,
  spriteDrawnPixels,
  spriteProbeExpected,
} from '@render/weapons/spriteProbe'
import {
  TONE_PROBE_COUNT,
  toneProbeExpected,
  toneProbeLevels,
} from '@render/toneProbe'
import {
  OVERLAY_PROBE_COUNT,
  OVERLAY_PROBE_EARLY_COUNT,
  OVERLAY_PROBE_LATE_COUNT,
  overlayMarkerCounts,
  overlayProbeExpected,
} from '@render/overlayProbe'
import {
  SURFACE_PROBE_SIDE,
  WATER_PROBE_REGIONS,
  surfaceBranchCounts,
  surfaceLevels,
} from '@render/terrain/surfaceProbe'
import { DEFAULT_PROJECT } from '../e2e/launch.mjs'

/**
 * GLSL 経路の出力の記録（`tests/e2e/node-reference.json`）そのものを検査する。
 *
 * **記録が空の絵なら、TSL を何と比べても一致してしまう。**node-path.spec が
 * GLSL 側に掛けていた「枝を通っている」「階調を使い切っている」の下限を、
 * GLSL を捨てたあとも記録の側で見張る。下限は node-path.spec の値をそのまま
 * 移した。
 *
 * CPU に参照がある 3 つ（円形スプライト・AgX・雲の合成）は、ここで記録と
 * CPU 参照を突き合わせる。ブラウザを立てずに、写した式が GLSL と同じ絵を
 * 出すことを毎回確かめられる。
 */
describe('GLSL 経路の出力の記録', () => {
  it('既定の project で撮ってある', () => {
    expect(ref.project).toBe(DEFAULT_PROJECT)
  })

  it('雲影は既定の雲量で、太陽が地平線の上にいる構図で焼いてある', () => {
    // 道具は TS を読めないので雲量を写している。食い違いをここで止める
    expect(ref.shadow.coverage).toBe(DEFAULT_COVERAGE)
    expect(ref.shadow.inputs.coverage).toBe(DEFAULT_COVERAGE)
    // 太陽が地平線の上にいないと影マップは全面 1 になる
    expect(ref.shadow.inputs.sunY).toBeGreaterThan(0.02)
  })

  it('雲影の分布と配置が比較の役に立つ広がりを持つ', () => {
    // 1 つのビンに寄っていたら比較が空回りする
    const nonEmpty = ref.shadow.bins.filter((v) => v > 0).length
    expect(nonEmpty).toBeGreaterThan(1)
    expect(ref.shadow.tiles.length).toBe(SHADOW_TILES * SHADOW_TILES)
    const spread = Math.max(...ref.shadow.tiles) - Math.min(...ref.shadow.tiles)
    expect(spread).toBeGreaterThan(0.01)
  })

  it('ノイズと気象マップは 16x16 の RGBA で、値が散っている', () => {
    for (const slice of [ref.noiseSlice, ref.weatherSlice]) {
      expect(slice.length).toBe(16 * 16 * 4)
      expect(new Set(slice).size).toBeGreaterThan(16)
    }
  })

  it('マーチは打ち切りと透過率で抜ける枝の両方を通り、足し込みが履歴を読む', () => {
    const pixels = MARCH_PROBE_WIDTH * MARCH_PROBE_HEIGHT
    expect(ref.march.samples.hit).toBe(pixels)
    expect(ref.march.samples.max).toBeGreaterThan(100)
    expect(ref.march.exhausted).toBeGreaterThan(10)
    expect(ref.march.exhausted).toBeLessThan(pixels / 2)
    expect(Math.min(...ref.march.tiles)).toBeGreaterThan(0.05)
    expect(ref.march.resolveChanged).toBeGreaterThan(1000)
    expect(ref.march.resolveUv.length).toBe(pixels * 4)
  })

  it('円形スプライトの CPU 参照が GLSL の絵とバイト一致する', () => {
    // **実測で 1 バイトも違わなかった（2026-10-26）。**記録も CPU も動かないので
    // 許容を挟まない。式を 1 つ書き違えればここで落ちる
    const pixels = SPRITE_PROBE_SIDE * SPRITE_PROBE_SIDE
    for (const [key, opaqueCore] of [
      ['soft', false],
      ['core', true],
    ] as const) {
      const glsl = ref.sprite[key]
      expect(glsl.length).toBe(pixels * 4)
      const d = byteDifference(spriteProbeExpected(opaqueCore), glsl)
      expect(d.differing, `${key} で違うバイト（最大差 ${d.max}）`).toBe(0)
    }
    // 捨てられた画素ばかりでないこと。芯は暈より狭いこと
    const soft = spriteDrawnPixels(ref.sprite.soft)
    const core = spriteDrawnPixels(ref.sprite.core)
    expect(soft).toBeGreaterThan(pixels / 4)
    expect(core).toBeGreaterThan(100)
    expect(core).toBeLessThan(soft)
  })

  it('AgX の CPU 参照が GLSL の絵とバイト一致する', () => {
    expect(ref.tone.length).toBe(TONE_PROBE_COUNT * 4)
    // 全部 0 か全部 255 なら曲線を間違えても一致する
    expect(toneProbeLevels(ref.tone)).toBeGreaterThan(100)
    // 実測で 1 バイトも違わなかった（2026-10-26）
    const d = byteDifference(toneProbeExpected(), ref.tone)
    expect(d.differing, `AgX で違うバイト（最大差 ${d.max}）`).toBe(0)
  })

  it('雲の合成の CPU 参照が GLSL の絵と 1 階調以内で一致し、両方の枝を通る', () => {
    expect(ref.overlay.composite.length).toBe(OVERLAY_PROBE_COUNT * 4)
    const d = byteDifference(overlayProbeExpected(), ref.overlay.composite)
    expect(d.max).toBeLessThanOrEqual(1)
    expect(overlayMarkerCounts(ref.overlay.marker)).toEqual({
      early: OVERLAY_PROBE_EARLY_COUNT,
      late: OVERLAY_PROBE_LATE_COUNT,
      other: 0,
    })
  })

  it('地表と海面は枝をすべて通り、階調を使い切っている', () => {
    const pixels = SURFACE_PROBE_SIDE * SURFACE_PROBE_SIDE
    expect(ref.surface.terrain.length).toBe(pixels * 4)
    expect(ref.surface.water.length).toBe(WATER_PROBE_REGIONS.length)
    expect(ref.surface.waterBranches.length).toBe(WATER_PROBE_REGIONS.length)

    const tb = surfaceBranchCounts(ref.surface.terrainBranches)
    expect(tb.other).toBe(0)
    expect(tb.r).toBeGreaterThan(pixels / 10)
    expect(tb.r).toBeLessThan(pixels)
    expect(tb.g).toBeGreaterThan(50)
    expect(tb.b).toBeGreaterThan(pixels / 10)

    let tap = 0
    let bicubic = 0
    let foam = 0
    let wave = 0
    let far = 0
    for (const branches of ref.surface.waterBranches) {
      const wb = surfaceBranchCounts(branches)
      expect(wb.other).toBe(0)
      tap += wb.r
      bicubic += wb.g
      foam += wb.b
      wave += wb.a
      far += pixels - wb.a
    }
    for (const n of [tap, bicubic, foam, wave, far]) expect(n).toBeGreaterThan(pixels / 10)

    expect(surfaceLevels(ref.surface.terrain)).toBeGreaterThan(32)
    for (const water of ref.surface.water) expect(surfaceLevels(water)).toBeGreaterThan(16)
  })

  it('空を背にした半透明の物が写っている', () => {
    // 構図が崩れていれば node 経路との比が空回りする
    expect(ref.translucent.explosion).toBeGreaterThan(500)
    expect(ref.translucent.vortex).toBeGreaterThan(500)
  })

  it('太陽と空の放射輝度が白で固定されていない', () => {
    expect(ref.sunRadiance[0]).toBeGreaterThan(0)
    expect(ref.sunRadiance[0]).not.toBeCloseTo(ref.sunRadiance[2], 3)
    for (const v of ref.skyRadiance) expect(v).toBeGreaterThan(0)
    expect(ref.sunElevation).toBeGreaterThan(0)
  })
})
