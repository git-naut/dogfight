import { describe, it, expect } from 'vitest'
import { CAPTURE_DEFAULT_SCRIPT, LIVE_DEFAULT_SCRIPT, readCaptureConfig } from '@render/capture'
import { getScript } from '@sim/scripts'

/**
 * `?script=` を省いたときの台本（Phase 9、2026-10-07）。
 *
 * **公開ページは甲板から射出して始まる**（ユーザーの要望）。キャプチャは水平飛行のまま。
 * 基準画像と E2E は台本を書いて呼ぶが、書き忘れたときに甲板の場面へ化けないように分けた
 */
describe('既定の台本', () => {
  it('ライブは mission-01（甲板で待ち、スロットルを開けると射出される）', () => {
    expect(readCaptureConfig('').script).toBe('mission-01')
    expect(readCaptureConfig('?debug=1').script).toBe(LIVE_DEFAULT_SCRIPT)
    const script = getScript(LIVE_DEFAULT_SCRIPT)
    expect(script.name, '台本の一覧に無い名前は level に化ける').toBe('mission-01')
    expect(script.launchFrom).toBe('cat-2')
  })

  it('キャプチャは level のまま', () => {
    expect(readCaptureConfig('?capture=1').script).toBe('level')
    expect(CAPTURE_DEFAULT_SCRIPT).toBe('level')
  })

  it('台本を書けばどちらでもそれを使う', () => {
    expect(readCaptureConfig('?script=gun-pass').script).toBe('gun-pass')
    expect(readCaptureConfig('?capture=1&script=gun-pass').script).toBe('gun-pass')
  })
})
