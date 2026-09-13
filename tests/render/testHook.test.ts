import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * TestHook の項目が実際に載っていることを機械的に守る。
 *
 * **宣言しただけで代入を忘れると、値は初期値のまま静かに嘘をつく。**
 * 実際に踏んだ。`missilesFired` などの 4 項目を `TestHook` に足したのに
 * `publish` への代入だけが抜け、E2E が「ミサイルが 1 発も出ていない」と
 * 報告した。sim の単体テストは全部通ったままで、絵にはミサイルが写っていた。
 * 一括編集が途中で中断して、その 1 か所だけ適用されなかったのが原因。
 *
 * 型では守れない。`TestHook` は変更可能なオブジェクトなので、初期値さえ
 * 揃っていれば代入がなくても型検査は通る。
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const capture = readFileSync(`${ROOT}src/render/capture.ts`, 'utf8')
const main = readFileSync(`${ROOT}src/main.ts`, 'utf8')

/** TestHook の項目名 */
function hookFields(): string[] {
  const start = capture.indexOf('export interface TestHook {')
  expect(start, 'TestHook の宣言が見つからない').toBeGreaterThan(-1)
  const end = capture.indexOf('\n}', start)
  const body = capture.slice(start, end)
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!)
}

/** main.ts が hook.X = ... と代入している項目名 */
function assignedFields(): Set<string> {
  return new Set([...main.matchAll(/hook\.(\w+)\s*=/g)].map((m) => m[1]!))
}

/**
 * 毎フレーム更新しなくてよい項目。
 *
 * `hour` は起動時のクエリで決まり動かない。GPU のフレーム時間は
 * `?debug=1` の計器が `view` から直接読んでいて、フックの側は使われていない
 * （Phase 3 から残っている枠）。
 */
const STATIC_ALLOWED = new Set(['hour', 'gpuFrameMs'])

describe('TestHook', () => {
  const fields = hookFields()

  it('項目が 60 個以上ある', () => {
    expect(fields.length).toBeGreaterThan(60)
  })

  it('すべての項目が main.ts で代入されている', () => {
    const assigned = assignedFields()
    const missing = fields.filter((f) => !assigned.has(f) && !STATIC_ALLOWED.has(f))
    expect(missing, '宣言だけで代入がない項目').toEqual([])
  })

  it('存在しない項目へ代入していない', () => {
    const declared = new Set(fields)
    const extra = [...assignedFields()].filter((f) => !declared.has(f))
    expect(extra, 'TestHook にない項目への代入').toEqual([])
  })

  it('E2E は写しを持たず、本家の型を読む', () => {
    // **かつては 264 行の写しだった。**「本家に足したらここも足す」と書いて
    // あったが、Phase 3.5 で 5 項目ずれていたのを揃えた履歴があり、
    // `requiltDiff` を足したときにも `src` 側だけに足して E2E から見えなかった。
    //
    // 写しを捨てて `import type` で本家を読む形にした。**`import type` は
    // コンパイル時に消える**ので、E2E の実行時に `three` は引き込まれない。
    // ここが見張るのは「写しを作り直していないこと」。
    const spec = readFileSync(`${ROOT}tests/e2e/harness.ts`, 'utf8')
    expect(
      spec.includes("import type { TestHook } from '../../src/render/capture'"),
      '本家の型を読んでいない',
    ).toBe(true)
    expect(
      spec.includes('interface TestHook {'),
      '写しが復活している。項目は本家（src/render/capture.ts）にだけ置く',
    ).toBe(false)
  })

  it('検査そのものが働くことを、既知の抜けで確かめる', () => {
    // 素通りするだけの検査にならないよう、抜けを作れば見つかることを見る
    const declared = ['alpha', 'beta', 'gamma']
    const assigned = new Set(['alpha', 'gamma'])
    expect(declared.filter((f) => !assigned.has(f))).toEqual(['beta'])
  })
})
