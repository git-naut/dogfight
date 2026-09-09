// 既定の 42 枚と node 経路の絵を突き合わせ、差分の台帳の材料を出す。
//
// **段 20b の前提。**計画は「差分の理由をあらかじめ台帳にする。理由の付かない
// 差分が 1 枚でも残っている間は撮り直さない」と書いている。撮り直す前に、
// どの枚がどれだけ動くかを数で出しておく。
//
// `tools/exact.mjs` は「1 画素も動いていないこと」を確かめる道具で、判定が
// 0 か 1 しかない。こちらは**動く前提**で、動きの量と場所を出す。
//
// 比べる相手は committed の基準画像。段 20b で置き換わるのがそれなので、
// 「撮り直したら何が変わるか」に直接答える。
//
// 使い方:
//   node tools/pathdiff.mjs [--nobuild] [--port N] [-g 名前の一部]
//                           [--names a,b,c] [--out ledger.json]
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import { SCENES, captureParams } from '../tests/e2e/scenes.mjs'
import { WEBGPU_ARGS, VIEWPORT, DEFAULT_PROJECT, snapshotSuffix } from '../tests/e2e/launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SNAP = fileURLToPath(new URL('../tests/e2e/smoke.spec.ts-snapshots', import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', 4413))
const FILTER = arg('-g', null)
const NAMES = arg('--names', null)?.split(',')
const OUT = arg('--out', null)
const BASE = `http://127.0.0.1:${PORT}/dogfight/`
// 基準画像は既定の project のもの。node 経路の絵をそれと比べる
const SUFFIX = snapshotSuffix(DEFAULT_PROJECT)

const scenes = SCENES.filter(
  (s) =>
    (NAMES === undefined || NAMES === null || NAMES.includes(s.name)) &&
    (FILTER === null || s.name.includes(FILTER)),
)

if (!argv.includes('--nobuild')) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' })
  if (build.status !== 0) {
    console.error(build.stdout.slice(-3000), build.stderr.slice(-2000))
    process.exit(1)
  }
}
const server = spawn(
  'npm',
  ['run', 'preview', '--', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', detached: true },
)

// **WebGPU の起動引数が要る。**node 経路の場面は WebGL2 フォールバックでは
// 立たない（大気の構造体が GLSL のコンパイルで落ちる）
const browser = await chromium.launch({ args: [...WEBGPU_ARGS] })

/**
 * 2 枚の PNG の差を測る。
 *
 * **平均も出す。**画素数と最大階調だけでは「全面が薄く動いた」と
 * 「一部が大きく動いた」を区別できない。ライティングの置き換えは前者、
 * 影のフィルタの変更は後者になるはずで、そこが帰属の手掛かりになる。
 *
 * 上下の帯も分ける。空は上、地表と海面は下に出るので、どちらが動いたかで
 * 大気の変更とライティングの変更を切り分けられる。
 */
function measure(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { size: `${a.width}x${a.height} と ${b.width}x${b.height}` }
  }
  const half = Math.floor(a.height / 2)
  let differing = 0
  let worst = 0
  let sum = 0
  let topSum = 0
  let bottomSum = 0
  let topCount = 0
  let bottomCount = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3]),
    )
    if (d > 0) differing++
    if (d > worst) worst = d
    sum += d
    const y = (i >> 2) / a.width | 0
    if (y < half) {
      topSum += d
      topCount++
    } else {
      bottomSum += d
      bottomCount++
    }
  }
  const total = a.width * a.height
  return {
    differing,
    worst,
    total,
    mean: sum / total,
    topMean: topSum / topCount,
    bottomMean: bottomSum / bottomCount,
  }
}

const rows = []
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))

  console.log(
    '構図'.padEnd(22) + '差分画素'.padStart(12) + '最大'.padStart(6) +
      '平均'.padStart(8) + '上帯'.padStart(8) + '下帯'.padStart(8),
  )
  console.log('-'.repeat(66))

  for (const scene of scenes) {
    const params = captureParams(scene)
    params.set('gpu', '3')
    await page.goto(`${BASE}?${params.toString()}`, { timeout: 300000 })
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300000 })
    const buf = await page.locator('#viewport').screenshot()

    const baseline = `${SNAP}/${scene.name}${SUFFIX}`
    if (!existsSync(baseline)) {
      console.log(`${scene.name.padEnd(22)} 基準画像なし`)
      continue
    }
    const r = measure(PNG.sync.read(buf), PNG.sync.read(readFileSync(baseline)))
    if (r.size !== undefined) {
      console.log(`${scene.name.padEnd(22)} 寸法が違う: ${r.size}`)
      continue
    }
    rows.push({ name: scene.name, ...r })
    const pct = ((100 * r.differing) / r.total).toFixed(2) + '%'
    console.log(
      scene.name.padEnd(22) +
        pct.padStart(12) +
        String(r.worst).padStart(6) +
        r.mean.toFixed(2).padStart(8) +
        r.topMean.toFixed(2).padStart(8) +
        r.bottomMean.toFixed(2).padStart(8),
    )
  }

  if (rows.length > 0) {
    const all = (f) => rows.map(f)
    const min = (xs) => Math.min(...xs)
    const max = (xs) => Math.max(...xs)
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
    console.log('-'.repeat(66))
    console.log(
      `${rows.length} 枚。差分画素の割合 ` +
        `${((100 * min(all((r) => r.differing / r.total)))).toFixed(2)}〜` +
        `${((100 * max(all((r) => r.differing / r.total)))).toFixed(2)}%、` +
        `最大階調 ${min(all((r) => r.worst))}〜${max(all((r) => r.worst))}、` +
        `平均 ${avg(all((r) => r.mean)).toFixed(2)}`,
    )
    const allMoved = rows.every((r) => r.differing > 0)
    console.log(
      allMoved
        ? '**全枚が動いている。**計画の見込み（大気とポストで 42 枚）と一致する。'
        : `動いていない枚が ${rows.filter((r) => r.differing === 0).length} ある。**理由が要る。**`,
    )
  }
  if (errors.length > 0) {
    console.log(`\nコンソールに ${errors.length} 件:`)
    for (const e of errors.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`)
  }
  if (OUT !== null) {
    writeFileSync(OUT, JSON.stringify(rows, null, 2))
    console.log(`\n${OUT} に書いた`)
  }
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {}
}
