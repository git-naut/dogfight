import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import {
  OVERLAY_COMPOSITE_GLSL,
  OVERLAY_EARLY_OUT_GLSL,
  OVERLAY_PROBE_BASE_RATIO,
  OVERLAY_PROBE_CLOUD_RATIO,
  OVERLAY_PROBE_COUNT,
  OVERLAY_PROBE_EARLY_COUNT,
  OVERLAY_PROBE_FULL_COLUMN,
  OVERLAY_PROBE_LATE_COUNT,
  OVERLAY_PROBE_SIDE,
  overlayMarkerCounts,
  overlayProbeExpected,
  overlayProbeSample,
} from '@render/overlayProbe'

/**
 * 雲を大気へ差し込む合成。
 *
 * `AerialPerspectiveNode` に `overlay` が無いので自前で書く。式は takram の
 * 断片シェーダから写した。**写しは原本と照合する。**ライブラリを上げて式が
 * 変われば、ここが落ちる。
 */

const TAKRAM_FRAG = fileURLToPath(
  new URL(
    '../../node_modules/@takram/three-atmosphere/src/shaders/aerialPerspectiveEffect.frag',
    import.meta.url,
  ),
)

describe('写した式が原本と一致する', () => {
  const source = readFileSync(TAKRAM_FRAG, 'utf8')

  it('早期打ち切りの条件が原本にある', () => {
    expect(source).toContain(OVERLAY_EARLY_OUT_GLSL)
  })

  it('合成の行が原本にある', () => {
    expect(source).toContain(OVERLAY_COMPOSITE_GLSL)
  })

  it('合成の行は 2 か所にある', () => {
    // 深度 1 で抜ける枝と、地物のある枝の 2 か所。片方だけ変わっても
    // 気づけるように数まで固定する
    const count = source.split(OVERLAY_COMPOSITE_GLSL).length - 1
    expect(count).toBe(2)
  })

  it('照合そのものが働いている', () => {
    // 原本を読めていなければ上の 3 件は空振りで通る
    expect(source).toContain('void mainImage(')
    expect(source.includes('if (overlay.a == 0.5) {')).toBe(false)
  })
})

describe('固定入力が両方の枝を通る', () => {
  it('不透明度がちょうど 1 に届く', () => {
    // **除算では作らない。**`min(col / 47.0, 1.0)` と書いたら SwiftShader が
    // 逆数の乗算へ畳み込み、`47 * fl(1/47) = 0.99999994` で列 47 の 64 画素が
    // 早期打ち切りの枝を通らなかった（実測 1,024 対 期待 1,088）
    const at = overlayProbeSample(OVERLAY_PROBE_FULL_COLUMN, 0)
    expect(at.overlay.a).toBe(1)
  })

  it('境目より右も 1 のまま', () => {
    const right = overlayProbeSample(OVERLAY_PROBE_SIDE - 1, 0)
    expect(right.overlay.a).toBe(1)
  })

  it('その手前は 1 に届かない', () => {
    const before = overlayProbeSample(OVERLAY_PROBE_FULL_COLUMN - 1, 0)
    expect(before.overlay.a).toBeLessThan(1)
  })

  it('先頭の列は透明', () => {
    // 早期打ち切りの側だけを通ると、合成の式そのものが検査されない
    expect(overlayProbeSample(0, 0).overlay.a).toBe(0)
  })

  it('枝ごとの画素数の合計が全画素になる', () => {
    expect(OVERLAY_PROBE_EARLY_COUNT + OVERLAY_PROBE_LATE_COUNT).toBe(
      OVERLAY_PROBE_COUNT,
    )
  })

  it('どちらの枝も全画素の 1 割を超える', () => {
    // 片側が数画素だと、写し間違いがバイト数に埋もれる
    expect(OVERLAY_PROBE_EARLY_COUNT).toBeGreaterThan(OVERLAY_PROBE_COUNT / 10)
    expect(OVERLAY_PROBE_LATE_COUNT).toBeGreaterThan(OVERLAY_PROBE_COUNT / 10)
  })

  it('3 成分が別々に通る', () => {
    // 比が等しいと、成分を取り違えても一致してしまう
    const base = OVERLAY_PROBE_BASE_RATIO
    const cloud = OVERLAY_PROBE_CLOUD_RATIO
    expect(new Set([base.r, base.g, base.b]).size).toBe(3)
    expect(new Set([cloud.r, cloud.g, cloud.b]).size).toBe(3)
  })

  it('下地と雲で明るさの向きが逆', () => {
    // 同じ向きだと、下地と雲を取り違えても似た絵になる
    const dark = overlayProbeSample(10, 0)
    const bright = overlayProbeSample(10, OVERLAY_PROBE_SIDE - 1)
    expect(bright.base.r).toBeGreaterThan(dark.base.r)
    expect(bright.overlay.r).toBeLessThan(dark.overlay.r)
  })
})

describe('CPU で組んだ期待値', () => {
  const expected = overlayProbeExpected()

  it('画素の数が合う', () => {
    expect(expected.length).toBe(OVERLAY_PROBE_COUNT * 4)
  })

  it('階調を使い切っている', () => {
    // 全部 0 か全部 255 なら、式を間違えても一致してしまう（段 17 の入口で
    // AgX の下限を外したのと同じ形）
    const levels = new Set<number>()
    for (let i = 0; i < OVERLAY_PROBE_COUNT; i++) levels.add(expected[i * 4]!)
    expect(levels.size).toBeGreaterThan(32)
    expect(Math.max(...levels)).toBeGreaterThan(200)
  })

  it('不透明の列は雲の色そのものになる', () => {
    // 早期打ち切りは値としては何も変えない。`base * (1 - 1) + overlay.rgb`
    // と同じ値になることを期待値の側でも確かめておく
    const row = 20
    const col = OVERLAY_PROBE_SIDE - 1
    const { overlay } = overlayProbeSample(col, row)
    const at = (row * OVERLAY_PROBE_SIDE + col) * 4
    expect(expected[at]).toBe(Math.round(overlay.r * 255))
    expect(expected[at + 1]).toBe(Math.round(overlay.g * 255))
    expect(expected[at + 2]).toBe(Math.round(overlay.b * 255))
  })

  it('透明の列は下地そのものになる', () => {
    const row = 40
    const { base } = overlayProbeSample(0, row)
    const at = row * OVERLAY_PROBE_SIDE * 4
    expect(expected[at]).toBe(Math.round(base.r * 255))
    expect(expected[at + 1]).toBe(Math.round(base.g * 255))
  })

  it('前乗算を掛け直すと別の絵になる', () => {
    // `+ overlay.rgb` を `+ overlay.rgb * overlay.a` と写し間違えたときに
    // 差が出ることを確かめる。出ないなら固定入力が弱い
    let differ = 0
    for (let row = 0; row < OVERLAY_PROBE_SIDE; row++) {
      for (let col = 0; col < OVERLAY_PROBE_SIDE; col++) {
        const { base, overlay } = overlayProbeSample(col, row)
        if (overlay.a === 1) continue
        const right = base.r * (1 - overlay.a) + overlay.r
        const wrong = base.r * (1 - overlay.a) + overlay.r * overlay.a
        if (Math.round(right * 255) !== Math.round(wrong * 255)) differ++
      }
    }
    expect(differ).toBeGreaterThan(OVERLAY_PROBE_COUNT / 4)
  })
})

describe('枝の数え方', () => {
  const marker = (early: number, late: number, other: number): Uint8Array => {
    const total = early + late + other
    const out = new Uint8Array(total * 4)
    for (let i = 0; i < total; i++) {
      const r = i < early ? 255 : 0
      const g = i >= early && i < early + late ? 255 : 0
      out[i * 4] = r
      out[i * 4 + 1] = g
      out[i * 4 + 3] = 255
    }
    return out
  }

  it('赤を早期打ち切り、緑を合成として数える', () => {
    expect(overlayMarkerCounts(marker(3, 5, 0))).toEqual({
      early: 3,
      late: 5,
      other: 0,
    })
  })

  it('どちらでもない画素を別に数える', () => {
    // 枝の書き分けが壊れたときに、片方の数が合っているだけで通さない
    expect(overlayMarkerCounts(marker(2, 2, 4)).other).toBe(4)
  })

  it('空なら 0', () => {
    expect(overlayMarkerCounts(new Uint8Array(0))).toEqual({
      early: 0,
      late: 0,
      other: 0,
    })
  })
})
