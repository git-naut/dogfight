// 基準画像と「画素が 1 つも違わない」ことを確かめる。
//
// `toHaveScreenshot` は 1 画素あたり threshold 0.05 / 画面の 0.005 まで許すので、
// **「通った」と「動いていない」は別物。**Phase 4 では機体をまるごと差し替えても
// 基準画像 10 枚のうち 4 枚が通った。等価なはずのリファクタを確かめるときは
// 許容差を挟まずに数える。
//
// 構図は `tests/e2e/scenes.mjs`、起動引数は `tests/e2e/launch.mjs` が正本。
// この道具は写しを持たない。**基準画像の正しさを確かめる道具が、
// 基準画像を撮る側と違う設定で走っていては意味がない。**
//
// 使い方:
//   node tools/exact.mjs [--nobuild] [--port N] [--project 名]
//                        [-g 名前の一部] [--names a,b,c（完全一致）]
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import { SCENES, captureParams } from '../tests/e2e/scenes.mjs'
import { SWIFTSHADER_ARGS, VIEWPORT, DEFAULT_PROJECT, snapshotSuffix } from '../tests/e2e/launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SNAP = fileURLToPath(new URL('../tests/e2e/smoke.spec.ts-snapshots', import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', 4411))
const PROJECT = arg('--project', DEFAULT_PROJECT)
const FILTER = arg('-g', null)
// 名前の完全一致で絞る。-g は部分一致なので aircraft-vortex が 5 枚に広がる
const NAMES = arg('--names', null)?.split(',')
const BASE = `http://127.0.0.1:${PORT}/dogfight/`
const SUFFIX = snapshotSuffix(PROJECT)

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

const browser = await chromium.launch({ args: [...SWIFTSHADER_ARGS] })

/** 2 枚の PNG で違う画素を数える。差の最大階調と差分の外接矩形も返す */
function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { size: `${a.width}x${a.height} と ${b.width}x${b.height}` }
  }
  let differing = 0
  let worst = 0
  let x0 = a.width
  let y0 = a.height
  let x1 = -1
  let y1 = -1
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3]),
    )
    if (d > 0) {
      differing++
      if (d > worst) worst = d
      // **差分の場所を出す。**枚数と画素数だけでは「予想した場所が動いたか」が
      // 分からない。移行の A/B では、動いた理由と場所の対応が読めることが要る
      const p = i >> 2
      const x = p % a.width
      const y = (p / a.width) | 0
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  const box = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  return { differing, worst, total: a.width * a.height, box }
}

let moved = 0
let missing = 0
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })
  let served = null

  for (const scene of scenes) {
    await page.goto(`${BASE}?${captureParams(scene).toString()}`, { timeout: 300000 })
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300000 })
    if (served === null) {
      // 落とし忘れたサーバに繋がっていないか。古い dist を掴むと嘘の結論が出る
      served = await page.evaluate(() =>
        [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).join(' '),
      )
      console.log(`配信された JS: ${served}\n`)
    }
    const buf = await page.locator('#viewport').screenshot()

    const baseline = `${SNAP}/${scene.name}${SUFFIX}`
    if (!existsSync(baseline)) {
      console.log(`${scene.name.padEnd(22)} 基準画像なし（新規）`)
      missing++
      continue
    }
    const r = compare(PNG.sync.read(buf), PNG.sync.read(readFileSync(baseline)))
    if (r.size !== undefined) {
      console.log(`${scene.name.padEnd(22)} 寸法が違う: ${r.size}`)
      moved++
    } else if (r.differing === 0) {
      console.log(`${scene.name.padEnd(22)} 一致（${r.total} 画素すべて）`)
    } else {
      const b = r.box
      console.log(
        `${scene.name.padEnd(22)} 差分 ${r.differing} 画素` +
          ` (${((100 * r.differing) / r.total).toFixed(4)}%) 最大 ${r.worst} 階調` +
          ` 外接 ${b.w}x${b.h} @(${b.x},${b.y})`,
      )
      moved++
    }
  }
  console.log(
    `\n合計 ${scenes.length} 枚（project ${PROJECT}）。動いた ${moved} 枚、基準なし ${missing} 枚。` +
      (moved === 0 ? '画素は 1 つも動いていない。' : '**動いている。**'),
  )
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {}
}
process.exit(moved === 0 ? 0 : 1)
