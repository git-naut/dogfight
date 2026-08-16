import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

/**
 * sim 層が描画に依存していないことを機械的に守る。
 *
 * この一方向の依存が崩れると、vitest が three を読み込もうとして遅くなり、
 * ブラウザ API に触れた瞬間 node 環境で落ち、決定論も失われる。
 * 規約をドキュメントに書くだけでは守られないのでテストにする。
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SIM_DIR = join(ROOT, 'src/sim')

const FORBIDDEN = [
  { pattern: /from\s+['"]three['"]/, reason: "three からの import" },
  { pattern: /from\s+['"]three\//, reason: 'three のサブモジュール import' },
  { pattern: /require\(\s*['"]three/, reason: 'three の require' },
  { pattern: /from\s+['"]\.\.\/render\//, reason: 'render 層への import' },
  { pattern: /from\s+['"]\.\.\/hud\//, reason: 'hud 層への import' },
  { pattern: /\bdocument\./, reason: 'DOM API の使用' },
  { pattern: /\bwindow\./, reason: 'window の使用' },
  { pattern: /Math\.random\s*\(/, reason: 'Math.random（Rng を使うこと）' },
  { pattern: /\bperformance\.now\s*\(/, reason: '実時間の参照（frame から導出すること）' },
  { pattern: /\bDate\.now\s*\(/, reason: '実時間の参照（frame から導出すること）' },
]

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** ソースからコメントを落とす。説明文で禁止語に言及できるようにするため。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function findViolations(source: string): string[] {
  const code = stripComments(source)
  return FORBIDDEN.filter((rule) => rule.pattern.test(code)).map((rule) => rule.reason)
}

describe('レイヤ規約', () => {
  const files = collectTsFiles(SIM_DIR)

  it('src/sim にファイルが存在する', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // 素通りするだけの検査にならないよう、既知の違反で発火することを確かめる。
  it.each([
    ["import * as THREE from 'three'", 'three からの import'],
    ["import { Sky } from 'three/addons/objects/Sky.js'", 'three のサブモジュール import'],
    ["const THREE = require('three')", 'three の require'],
    ["import { createScene } from '../render/scene'", 'render 層への import'],
    ["import { hud } from '../hud/hud'", 'hud 層への import'],
    ['const el = document.querySelector("#a")', 'DOM API の使用'],
    ['const w = window.innerWidth', 'window の使用'],
    ['const r = Math.random()', 'Math.random（Rng を使うこと）'],
    ['const t = performance.now()', '実時間の参照（frame から導出すること）'],
    ['const t = Date.now()', '実時間の参照（frame から導出すること）'],
  ])('違反サンプル %s を検出する', (sample, reason) => {
    expect(findViolations(sample)).toContain(reason)
  })

  it('コメント内の言及は違反にしない', () => {
    const sample = [
      '// Math.random() は使わず Rng を通す',
      "/* three の Vector3 に API を合わせてある */",
      'export const x = 1',
    ].join('\n')
    expect(findViolations(sample)).toEqual([])
  })

  it.each(files.map((f) => [relative(ROOT, f), f] as const))(
    '%s が描画・実時間・Math.random に依存していない',
    (_label, file) => {
      expect(findViolations(readFileSync(file, 'utf8'))).toEqual([])
    },
  )
})
