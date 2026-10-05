import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * HUD へ渡す武装の状態（`HudArmament`）の全項目検査（段 37、計画書の段 30）。
 *
 * **器に載せただけでは出ない。**段 32 までは `HudArmament.flares` が main.ts で毎フレーム
 * 代入されているのに、hud.ts に読む所が 1 つも無かった（計画書が名指ししたデッド配線）。
 * 逆に `missilesLeft` は sim にあるのに `HudArmament` に項目が無かった。
 *
 * `TestHook` の全項目検査（`tests/render/testHook.test.ts`）と同じ形で、宣言した項目が
 * main.ts で代入され、hud.ts で読まれていることをソースから確かめる。型では守れない。
 * 器は変更可能なオブジェクトなので、初期値さえあれば代入も読みも無くても型検査は通る
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const hud = readFileSync(`${ROOT}src/hud/hud.ts`, 'utf8')
const main = readFileSync(`${ROOT}src/main.ts`, 'utf8')

/** `HudArmament` の項目名 */
function armamentFields(): string[] {
  const start = hud.indexOf('export interface HudArmament {')
  expect(start, 'HudArmament の宣言が見つからない').toBeGreaterThan(-1)
  const end = hud.indexOf('\n}', start)
  return [...hud.slice(start, end).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!)
}

/**
 * main.ts が書いている項目名。`armament.X = …`、`armament.X ??= …`、`armament.X[n] ??= …`、
 * `armament.X.y = …`（入れ子の器の中身を書く形）のどれか
 */
function writtenFields(): Set<string> {
  return new Set(
    [...main.matchAll(/armament\.(\w+)(?:\.\w+|\[\w+\])*\s*(?:\?\?)?=(?!=)/g)].map((m) => m[1]!),
  )
}

/** hud.ts が読んでいる項目名。`armament.X` の形（宣言の中は除く） */
function readFields(): Set<string> {
  const start = hud.indexOf('export interface HudArmament {')
  const end = hud.indexOf('\n}', start)
  const body = hud.slice(0, start) + hud.slice(end)
  return new Set([...body.matchAll(/armament\.(\w+)/g)].map((m) => m[1]!))
}

describe('HudArmament', () => {
  const fields = armamentFields()

  it('項目が 9 個ある', () => {
    // 段 37 の時点。足したらこの数も変える（足したことに気づくため）
    expect(fields).toEqual([
      'rounds',
      'missiles',
      'contacts',
      'contactCount',
      'carrier',
      'lock',
      'flares',
      'threat',
      'mission',
    ])
  })

  it('すべての項目が main.ts で書かれている', () => {
    const written = writtenFields()
    expect(
      fields.filter((f) => !written.has(f)),
      '宣言だけで main.ts が書いていない項目',
    ).toEqual([])
  })

  it('すべての項目が hud.ts で読まれている（デッド配線が無い）', () => {
    const read = readFields()
    expect(
      fields.filter((f) => !read.has(f)),
      'main.ts が書いているのに hud.ts が読まない項目',
    ).toEqual([])
  })
})
