// 雲の再投影を「飛ばして」確かめる。**E2E より速く回すための道具。**
//
// `playwright test` は webServer が毎回 `npm run build` を走らせるので、
// 1 手が 3 分を超える。調査中はそれでは回らない。ここは dist を作り置きして
// preview を 1 回立て、ライブループを開いて撮るところだけをやる。
//
// **測る前に絵を見る。**`docs/lessons.md` に「最初の測定は空の帯（上から
// 40%）を見ていて、そこには雲も地形も入っていない。測定として無効だった」
// と記録がある。この道具は常に絵を書き出す。数字だけを読まない。
//
// 使い方:
//   node tools/cloud-live.mjs [--build] [--port N] [--script 名]
//                             [--coverage 0.6] [--out 出力先]
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import { VIEWPORT, WEBGPU_ARGS } from '../tests/e2e/launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', 4412))
const SCRIPT = arg('--script', 'zoom-climb')
const COVERAGE = arg('--coverage', '0.6')
const OUT = arg('--out', `${ROOT}test-results/cloud-live`)
const BASE = `http://127.0.0.1:${PORT}/dogfight/`

if (argv.includes('--build')) {
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const server = spawn(
  'npm',
  ['run', 'preview', '--', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', detached: true },
)

/** 上下 2 分割ではなく、雲が実際に覆う場所を数える。帯ごとに出す */
function bandDifference(a, b) {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  const bands = 6
  const rows = Math.floor(pa.height / bands)
  const out = []
  for (let k = 0; k < bands; k++) {
    let n = 0
    for (let y = k * rows; y < (k + 1) * rows; y++) {
      for (let x = 0; x < pa.width; x++) {
        const i = (y * pa.width + x) * 4
        const d = Math.max(
          Math.abs(pa.data[i] - pb.data[i]),
          Math.abs(pa.data[i + 1] - pb.data[i + 1]),
          Math.abs(pa.data[i + 2] - pb.data[i + 2]),
        )
        if (d > 8) n++
      }
    }
    out.push({ band: k, moved: n, total: rows * pa.width })
  }
  return out
}

async function advance(page, frames) {
  const from = await page.evaluate(() => window.__dogfight?.frame ?? 0)
  await page.waitForFunction(
    (n) => (window.__dogfight?.frame ?? 0) >= n,
    from + frames,
    { timeout: 180_000 },
  )
}

async function fly(page, nodePath) {
  const gpu = nodePath ? '&gpu=3' : ''
  await page.goto(`${BASE}?script=${SCRIPT}&coverage=${COVERAGE}${gpu}`, {
    timeout: 180_000,
  })
  await page.waitForFunction(() => (window.__dogfight?.frame ?? 0) > 0, undefined, {
    timeout: 180_000,
  })
  await page.locator('.title-start').click()
  await advance(page, 120)

  const size = await page.evaluate(() => {
    const c = document.querySelector('#viewport')
    return c ? `${c.clientWidth}x${c.clientHeight}` : 'なし'
  })
  console.log(`  viewport=${size}`)
  const before = await page.locator('#viewport').screenshot({ animations: 'disabled', timeout: 60_000 })
  const cloudsAtBefore = await page.evaluate(
    () => window.__dogfight?.cloudRenderCount ?? 0,
  )
  // **姿勢で揃える。**フレーム数で回すと実行ごとにバンクが -98°〜-119° と
  // ばらつき、2 回の測定を並べられない（実測）。ライブは実時間で進むので
  // 入力の効き方がフレームと一致しない
  await page.keyboard.down('KeyA')
  await page.waitForFunction(
    () => Math.abs(((window.__dogfight?.bank ?? 0) * 180) / Math.PI) >= 60,
    undefined,
    { timeout: 180_000 },
  )
  await page.keyboard.up('KeyA')
  await advance(page, 20)
  const after = await page.locator('#viewport').screenshot({ animations: 'disabled', timeout: 60_000 })

  const hook = await page.evaluate(() => ({
    backend: window.__dogfight?.backend ?? '',
    frame: window.__dogfight?.frame ?? 0,
    altitude: window.__dogfight?.altitude ?? 0,
    bank: window.__dogfight?.bank ?? 0,
    // **雲が毎フレーム焼けているか。**止まっていれば最初の 1 枚が画面に
    // 貼り付き、視点についてくるように見える
    cloudRenderCount: window.__dogfight?.cloudRenderCount ?? 0,
  }))
  return { before, after, hook, cloudsAtBefore }
}

const browser = await chromium.launch({ args: [...WEBGPU_ARGS] })
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  mkdirSync(OUT, { recursive: true })
  const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })

  for (const [label, nodePath] of [
    ['legacy', false],
    ['node', true],
  ]) {
    const r = await fly(page, nodePath)
    writeFileSync(`${OUT}/${label}-before.png`, r.before)
    writeFileSync(`${OUT}/${label}-after.png`, r.after)
    const bands = bandDifference(r.before, r.after)
    const line = bands
      .map((b) => `${((100 * b.moved) / b.total).toFixed(0)}%`)
      .join(' ')
    const baked = r.hook.cloudRenderCount - r.cloudsAtBefore
    console.log(
      `${label.padEnd(7)} backend=${r.hook.backend.padEnd(12)} ` +
        `frame=${r.hook.frame} 高度=${r.hook.altitude.toFixed(0)}m ` +
        `バンク=${((r.hook.bank * 180) / Math.PI).toFixed(0)}° | ` +
        `**回している間に雲を焼いた回数 ${baked}**（累計 ${r.hook.cloudRenderCount}） ` +
        `| 帯ごとの変化 ${line}`,
    )
  }
  console.log(`\n絵は ${OUT}。**数字の前に絵を見ること。**`)
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {}
}
