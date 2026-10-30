import { describe, expect, it } from 'vitest'
import { NODE_REFERENCE as ref } from '../e2e/nodeReference'
import { byteDifference } from '@render/pixelCompare'
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
