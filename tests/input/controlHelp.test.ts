import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { CONTROL_HELP, controlHelpLine } from '@input/keyboard'

/**
 * 操作説明が実装とずれていないことを機械で守る。
 *
 * **文字列の一元化だけでは足りない。**`debugPanel.ts` に説明を書いていた
 * ときは `Space`（機銃）`KeyF`（ミサイル）`KeyC`（フレア）が抜けていて、
 * 撃つ手段が画面のどこにも出ていなかった。正本を `keyboard.ts` へ移しても、
 * キーを足したとき `CONTROL_HELP` に書き忘れれば同じことが起きる。
 *
 * そこで `poll()` が実際に見ている `KeyboardEvent.code` をソースから抜き、
 * `CONTROL_HELP` の `codes` と突き合わせる。`layering.test.ts` と同じ作法。
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/input/keyboard.ts', import.meta.url)),
  'utf8',
)

/** 実装が入力の判定に使っているキーコード */
function codesUsedByImplementation(): Set<string> {
  const found = new Set<string>()
  const patterns = [
    /held\('([A-Za-z]+)'\)/g,
    /pressed\.has\('([A-Za-z]+)'\)/g,
    /event\.code === '([A-Za-z]+)'/g,
  ]
  for (const re of patterns) {
    for (const m of SOURCE.matchAll(re)) {
      const code = m[1]
      if (code !== undefined) found.add(code)
    }
  }
  return found
}

describe('操作説明', () => {
  it('実装が見ているキーがすべて説明に出ている', () => {
    const declared = new Set(CONTROL_HELP.flatMap((c) => c.codes))
    const missing = [...codesUsedByImplementation()].filter((c) => !declared.has(c))
    expect(missing, `説明に無いキー: ${missing.join(', ')}`).toEqual([])
  })

  it('説明に書いたキーを実装が見ている', () => {
    const used = codesUsedByImplementation()
    const stale = CONTROL_HELP.flatMap((c) => c.codes).filter((c) => !used.has(c))
    expect(stale, `実装が見ていないキー: ${stale.join(', ')}`).toEqual([])
  })

  /** 抽出そのものが空振りしていたら上の 2 件は無条件に通る */
  it('抽出が機能している', () => {
    expect(codesUsedByImplementation().size).toBeGreaterThan(10)
  })

  it('撃つ操作が載っている', () => {
    const actions = CONTROL_HELP.map((c) => c.action)
    expect(actions).toContain('機銃')
    expect(actions).toContain('ミサイル')
    expect(actions).toContain('フレア')
  })

  it('1 行版が全項目を含む', () => {
    const line = controlHelpLine()
    for (const entry of CONTROL_HELP) {
      expect(line).toContain(entry.keys)
      expect(line).toContain(entry.action)
    }
  })
})
