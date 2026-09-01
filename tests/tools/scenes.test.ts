import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { SCENES, captureParams } from '../e2e/scenes.mjs'
import { DEFAULT_PROJECT, snapshotSuffix } from '../e2e/launch.mjs'
import { DEFAULT_COVERAGE } from '@render/pipeline/types'
import { getScript, isScriptName } from '@sim/scripts'

/**
 * 基準画像の構図の検査。
 *
 * **数はドキュメントに書いた瞬間から腐る。**Phase 7 の終わりに調べたら、
 * 基準画像の枚数が 4 通りの古い値で書かれていた。`docs/hud.md` が 34 枚と
 * 19 枚、`src/hud/hud.ts` が 37 枚、`tests/e2e/smoke.spec.ts` が 39 枚。
 * 実際は 42 枚。どれも人が数えて書き、数え直す仕組みがなかった。
 *
 * ここで固定するのは、その数を書いてある場所と対になる量だけ。カットを
 * 足したらこのテストが落ちるので、書き換える場所が名指しで分かる。
 *
 * 対応する記述の場所。
 *
 * - 総数 42 … `docs/hud.md`、`tests/e2e/smoke.spec.ts` のタイトル画面の節
 * - HUD 入り 13 … `docs/hud.md`
 * - 空母が写らない 38 … `src/render/scene.ts`、`src/sim/replay.ts`、
 *   `src/sim/scripts.ts`、`docs/carrier.md`
 * - ミッションが走らない 40 … `src/hud/hud.ts` の 2 箇所
 */
describe('基準画像の構図', () => {
  const snapshotDir = fileURLToPath(new URL('../e2e/smoke.spec.ts-snapshots', import.meta.url))

  it('42 枚ある', () => {
    expect(SCENES.length).toBe(42)
  })

  it('名前が重複しない', () => {
    expect(new Set(SCENES.map((s) => s.name)).size).toBe(SCENES.length)
  })

  it('基準画像のファイルと 1 対 1 で対応する', () => {
    const suffix = snapshotSuffix(DEFAULT_PROJECT)
    const onDisk = readdirSync(snapshotDir)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, -suffix.length))
      .sort()
    expect(onDisk).toEqual([...SCENES.map((s) => s.name)].sort())
  })

  it('台本の名前が実在する', () => {
    for (const scene of SCENES) {
      expect(isScriptName(scene.script), `${scene.name} の台本 ${scene.script}`).toBe(true)
    }
  })

  it('watches は実測に基づく', () => {
    // **宣言ではなく測った結果を書く。**段 6 で 56 件を宣言して測り、
    // 発火しなかった 7 件を落として 49 件になった。空の 4 枚は画素では
    // 何も見張っていない（数値の検査が担う）。
    //
    // 増やしたら `MUTATE=1 npx playwright test pixel-mutate` で確かめる。
    const total = SCENES.reduce((sum, s) => sum + (s.watches?.length ?? 0), 0)
    expect(total).toBe(49)
    const empty = SCENES.filter((s) => (s.watches ?? []).length === 0).map((s) => s.name)
    expect(empty).toEqual([
      'aircraft-vortex-fade',
      'hud-dlz',
      'hud-mission-failed',
      'missile-warning',
    ])
  })

  it('HUD を含むのは 13 枚', () => {
    expect(SCENES.filter((s) => s.hud === true).length).toBe(13)
  })

  it('空母が写らないのは 38 枚', () => {
    const withCarrier = SCENES.filter((s) => getScript(s.script).carrier !== undefined)
    expect(withCarrier.map((s) => s.name)).toEqual([
      'hud-mission',
      'hud-mission-failed',
      'catapult',
      'carrier',
    ])
    expect(SCENES.length - withCarrier.length).toBe(38)
  })

  it('ミッションが走らないのは 40 枚', () => {
    const withMission = SCENES.filter((s) => getScript(s.script).missionSeconds !== undefined)
    expect(withMission.map((s) => s.name)).toEqual(['hud-mission', 'hud-mission-failed'])
    expect(SCENES.length - withMission.length).toBe(40)
  })
})

/**
 * キャプチャ URL の組み立て。
 *
 * `tests/e2e/smoke.spec.ts` と `tools/exact.mjs` が同じ関数を呼ぶことで、
 * 既定値のずれを構造的に防いでいる。以前は写しを持っていて、雲量の既定が
 * 片方 0、もう片方はアプリ既定の 0.3 だった。**基準画像の正しさを確かめる
 * 道具が、基準画像を撮る側と違う絵を撮っていた。**
 */
describe('キャプチャ URL', () => {
  it('雲量の既定は 0（快晴）', () => {
    expect(captureParams({}).get('coverage')).toBe('0')
  })

  it('台本とフレームの既定は level の 240', () => {
    const p = captureParams({})
    expect(p.get('script')).toBe('level')
    expect(p.get('frame')).toBe('240')
    expect(p.get('capture')).toBe('1')
  })

  it('描画の切り分けは false のときだけ 0 を送る', () => {
    expect(captureParams({}).has('targets')).toBe(false)
    expect(captureParams({ targets: false }).get('targets')).toBe('0')
    expect(captureParams({ targets: true }).has('targets')).toBe(false)
  })

  it('HUD は指定したときだけ 1 か 0 を送る', () => {
    expect(captureParams({}).has('hud')).toBe(false)
    expect(captureParams({ hud: true }).get('hud')).toBe('1')
    expect(captureParams({ hud: false }).get('hud')).toBe('0')
  })

  it('構図をそのまま渡すと、その構図の値が入る', () => {
    const scene = SCENES.find((s) => s.name === 'clouds-dense')
    expect(scene).toBeDefined()
    const p = captureParams(scene)
    expect(p.get('script')).toBe('level')
    expect(p.get('frame')).toBe('480')
    expect(p.get('coverage')).toBe('0.8')
    expect(p.get('hour')).toBe('16')
  })
})

describe('雲量', () => {
  it('雲ありのカットが本番の既定と揃っている', () => {
    // **道具ごとに違う雲量で撮っていた過去がある**（`docs/lessons.md`）。
    // 快晴（0）と濃い雲（0.8）は意図した外れ値で、それ以外は本番の既定に
    // 揃える。揃っていないと、基準画像が出荷される絵を写さなくなる
    const cloudy = SCENES.map((s) => s.coverage).filter(
      (c) => c !== undefined && c !== 0 && c !== 0.8,
    )
    expect(cloudy.length, '雲ありのカットが無い').toBeGreaterThan(5)
    for (const c of cloudy) {
      expect(c, '本番の既定とずれている').toBe(DEFAULT_COVERAGE)
    }
  })
})
