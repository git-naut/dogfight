import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { AIRCRAFT, INDUCED_DRAG_FACTOR, CL_MAX } from '@sim/flightModel'
import { GRAVITY } from '@sim/isa'

/**
 * ドキュメントに書いた数値と実装の突き合わせ。
 *
 * **数値はドキュメントに書いた瞬間から腐る。**`docs/flight-model.md` の
 * 誘導抗力係数は `0.1158` のままだった。これは AR 3.44（F-16）の値で、
 * 実装は AR 3.5157（F/A-18C）から `0.113173` を計算している。Phase 1 の
 * 残骸が 7 か月残っていた。実装側はテストが固定していたので誰も気づかない。
 *
 * 揚力傾斜 4.0 は「2π に有限翼補正を掛けた値」とだけ書いてあり、どの補正式
 * かが無かった。Helmbold の式を当てると 3.654 になって再現できない。実際は
 * `2π AR / (2 + AR)` で 4.00491。**値だけ書いて式を書かないと検算できない。**
 *
 * ここではドキュメントから数値を正規表現で抜き、実装の定数と突き合わせる。
 * 自分のパーサが出した数値を自分で期待値に置くのではなく、**別々に書かれた
 * 2 つを突き合わせる**という `tests/input/controlHelp.test.ts` と同じ作法。
 */
describe('docs/flight-model.md の数値', () => {
  const doc = readFileSync(
    fileURLToPath(new URL('../../docs/flight-model.md', import.meta.url)),
    'utf8',
  )
  // `TRIM_MIN_SPEED` は module 内の const で export されていない。
  // 実装の文字列から読む（`tests/input/controlHelp.test.ts` と同じ作法）
  const source = readFileSync(
    fileURLToPath(new URL('../../src/sim/flightModel.ts', import.meta.url)),
    'utf8',
  )

  /** 表の行「| 名前 | 値 ... |」から最初の数値を抜く */
  function tableValue(label: string): number {
    const row = doc.match(new RegExp(`^\\|\\s*${label}\\s*\\|([^|]*)\\|`, 'm'))
    expect(row, `表に「${label}」の行がない`).not.toBeNull()
    const cell = (row as RegExpMatchArray)[1] as string
    const num = cell.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
    expect(num, `「${label}」の値に数値がない: ${cell}`).not.toBeNull()
    return Number((num as RegExpMatchArray)[0])
  }

  it('抽出そのものが働く', () => {
    // 検査が空振りしていないことを、既知の値で確かめる。
    // ここが落ちるなら表の書式が変わっている
    expect(tableValue('質量')).toBe(16650)
    expect(tableValue('主翼面積')).toBe(37.16)
  })

  it('諸元の表が実装と一致する', () => {
    expect(tableValue('質量')).toBe(AIRCRAFT.mass)
    expect(tableValue('主翼面積')).toBe(AIRCRAFT.wingArea)
    expect(tableValue('最大推力')).toBe(AIRCRAFT.maxThrust)
    expect(tableValue('揚力傾斜')).toBe(AIRCRAFT.liftSlope)
    expect(tableValue('有害抗力係数')).toBe(AIRCRAFT.cd0)
    expect(tableValue('オズワルド効率')).toBe(AIRCRAFT.oswaldEfficiency)
    expect(tableValue('G 制限')).toBe(AIRCRAFT.gLimit)
    // 角度は度で書いてある
    const DEG = 180 / Math.PI
    expect(tableValue('頭打ちの迎角')).toBeCloseTo(AIRCRAFT.clPeakAngle * DEG, 1)
    expect(tableValue('失速角')).toBeCloseTo(AIRCRAFT.stallAngle * DEG, 1)
    expect(tableValue('迎角制限')).toBeCloseTo(AIRCRAFT.aoaLimit * DEG, 1)
    // アスペクト比だけは表が丸めてある（3.52 に対して実装は 3.515740）
    expect(tableValue('アスペクト比')).toBeCloseTo(AIRCRAFT.aspectRatio, 2)
  })

  it('誘導抗力係数の値が実装と一致する', () => {
    // **これが 0.1158 のままだった。**F-16 の AR 3.44 から出る値
    const m = doc.match(/k\s*=\s*1\s*\/\s*\(π AR e\)\s*=\s*([\d.]+)/)
    expect(m, '誘導抗力係数の式が見つからない').not.toBeNull()
    expect(Number((m as RegExpMatchArray)[1])).toBeCloseTo(INDUCED_DRAG_FACTOR, 6)
  })

  it('揚力傾斜の補正式が実装を再現する', () => {
    // 値だけでなく式を書く。式が無いと検算できない
    const m = doc.match(/a\s*=\s*2π AR \/ \(2 \+ AR\)\s*=\s*2π × ([\d.]+) \/ ([\d.]+)\s*=\s*([\d.]+)/)
    expect(m, '揚力傾斜の補正式が見つからない').not.toBeNull()
    const [, ar, denom, result] = m as RegExpMatchArray
    expect(Number(ar)).toBeCloseTo(AIRCRAFT.aspectRatio, 5)
    expect(Number(denom)).toBeCloseTo(2 + AIRCRAFT.aspectRatio, 5)
    const computed = (2 * Math.PI * AIRCRAFT.aspectRatio) / (2 + AIRCRAFT.aspectRatio)
    expect(Number(result)).toBeCloseTo(computed, 4)
    // 実装は丸めた 4.0 を直接持つ
    expect(AIRCRAFT.liftSlope).toBeCloseTo(computed, 2)
  })

  it('翼面荷重がドキュメントの値と一致する', () => {
    // **期待値を 2 度書かない。**ドキュメントから読んだ値と、実装から
    // 計算した値を突き合わせる。片方だけ直したときに通ってしまう形にしない。
    // 実測 4,393.99 を 4,395 と書いていたのをこの検査が捕まえた
    const m = doc.match(/翼面荷重 ([\d,]+) N\/m²/)
    expect(m, '翼面荷重の記述が見つからない').not.toBeNull()
    const inDoc = Number(String((m as RegExpMatchArray)[1]).replace(/,/g, ''))
    const computed = (AIRCRAFT.mass * GRAVITY) / AIRCRAFT.wingArea
    expect(inDoc).toBe(Math.round(computed))
  })

  it('最大揚力係数がドキュメントの値と一致する', () => {
    const m = doc.match(/最大揚力係数を ([\d.]+) に収める/)
    expect(m, '最大揚力係数の記述が見つからない').not.toBeNull()
    expect(Number((m as RegExpMatchArray)[1])).toBeCloseTo(CL_MAX, 1)
  })

  it('トリムの下限速度が実装と一致する', () => {
    const inDoc = doc.match(/`TRIM_MIN_SPEED`\s*の\s*([\d.]+)\s*m\/s/)
    expect(inDoc, 'TRIM_MIN_SPEED の記述が見つからない').not.toBeNull()
    const inCode = source.match(/const TRIM_MIN_SPEED = ([\d.]+)/)
    expect(inCode, '実装に TRIM_MIN_SPEED がない').not.toBeNull()
    expect(Number((inDoc as RegExpMatchArray)[1])).toBe(
      Number((inCode as RegExpMatchArray)[1]),
    )
  })
})
