import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
 * そこで実装が実際に見ている `KeyboardEvent.code` をソースから抜き、
 * `CONTROL_HELP` の `codes` と突き合わせる。`layering.test.ts` と同じ作法。
 *
 * **抽出の対象を 1 ファイルに絞ってはいけない。**Phase 7 まで、この検査は
 * `src/input/keyboard.ts` だけを読んでいた。ポーズ（Escape）の判定は
 * `main.ts` にあり、しかも `event.key` を使っていたので、正規表現にも
 * 当たらなかった。**二重に抽出の外にあり、1 件を取りこぼしていた。**
 * いまはキーボードを見ているファイルを `src/` から探して全部読む。
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url))

/** `src/` 以下の .ts を全部集める */
function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/**
 * キーボードの入力を見ているファイル。
 *
 * 一覧を手で書くと、新しく足したファイルが抜ける。**探し方のほうを
 * 書いておく。**
 */
function keyHandlingFiles(): { path: string; source: string }[] {
  return collectTsFiles(SRC)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => source.includes('keydown') || source.includes('KeyboardEvent'))
}

/** 実装が入力の判定に使っているキーコード */
function codesUsedByImplementation(): Set<string> {
  const found = new Set<string>()
  const patterns = [
    /held\('([A-Za-z]+)'\)/g,
    /pressed\.has\('([A-Za-z]+)'\)/g,
    /event\.code [!=]== '([A-Za-z]+)'/g,
  ]
  for (const { source } of keyHandlingFiles()) {
    for (const re of patterns) {
      for (const m of source.matchAll(re)) {
        const code = m[1]
        if (code !== undefined) found.add(code)
      }
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

  it('キーボードを見ているファイルを取りこぼしていない', () => {
    // **1 ファイルしか見つからないなら、探し方が壊れている。**
    // Phase 7 まではそもそも 1 ファイルしか読んでいなかった
    const files = keyHandlingFiles().map((f) => f.path.slice(SRC.length + 1))
    expect(files.length, `見つかったファイル: ${files.join(', ')}`).toBeGreaterThanOrEqual(3)
    expect(files).toContain('input/keyboard.ts')
    expect(files).toContain('main.ts')
  })

  it('キーの判定に event.key を使っていない', () => {
    // `event.key` はキーボードのレイアウトで変わる。物理キーで決めたい。
    // **加えて、上の突合が拾えない。**Escape がこれで抜けていた
    const offenders = keyHandlingFiles()
      .filter(({ source }) => /event\.key [!=]== /.test(source))
      .map((f) => f.path.slice(SRC.length + 1))
    expect(offenders, `event.key で判定している: ${offenders.join(', ')}`).toEqual([])
  })

  it('撃つ操作が載っている', () => {
    const actions = CONTROL_HELP.map((c) => c.action)
    expect(actions).toContain('機銃')
    expect(actions).toContain('ミサイル')
    expect(actions).toContain('フレア')
  })

  it('ポーズが載っている', () => {
    // 判定が `keyboard.ts` の外にあるものも正本へ書く
    expect(CONTROL_HELP.map((c) => c.action)).toContain('ポーズ')
  })

  it('1 行版が全項目を含む', () => {
    const line = controlHelpLine()
    for (const entry of CONTROL_HELP) {
      expect(line).toContain(entry.keys)
      expect(line).toContain(entry.action)
    }
  })
})
