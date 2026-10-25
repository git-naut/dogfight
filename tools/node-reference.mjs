// GLSL 経路のプローブの出力を、数値の記録 `tests/e2e/node-reference.json` に固める。
//
// 段 S1（GLSL 退避路の削除）の準備。node-path.spec の突き合わせのうち、CPU に
// 参照実装が無いもの（雲のノイズ・気象マップ・雲影・マーチ、地表と海面の色、
// 画素数の比）は、GLSL 経路を消すと相手を失う。**消す前に GLSL の出力を写して
// おき、TSL をその写しと比べる。**写しが GLSL と同じであることは、GLSL が
// 残っている段 S1a の CI で node-path.spec が確かめる。
//
// 起動引数と構図は `tests/e2e/launch.mjs` と `scenes.mjs` が正本。node-path.spec と
// 同じ URL を同じ順で開く。
//
// 使い方:
//   node tools/node-reference.mjs [--nobuild] [--port N] [--out 書き先]
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import { SCENES, captureParams } from '../tests/e2e/scenes.mjs'
import { launchArgsFor, VIEWPORT, DEFAULT_PROJECT } from '../tests/e2e/launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
// **2 回流して同じものが出るかを見るため、書き先を変えられる**
const OUT = arg('--out', fileURLToPath(new URL('../tests/e2e/node-reference.json', import.meta.url)))
const PORT = Number(arg('--port', 4412))
const BASE = `http://127.0.0.1:${PORT}/dogfight/`
// **`DEFAULT_COVERAGE`（src/render/pipeline/types.ts）と同じ値。**この道具は TS を
// 読めないので写す。食い違いは `tests/render/nodeReference.test.ts` が止める
const SHADOW_COVERAGE = 0.29

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
const browser = await chromium.launch({ args: launchArgsFor(DEFAULT_PROJECT) })

/** バイト列は base64 で持つ。数万個の数を JSON の配列で書くと差分が読めない */
const bytes = (list) => Buffer.from(Uint8Array.from(list)).toString('base64')

try {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => errors.push(e.message))

  // 配信が立つまで待つ
  for (let i = 0; ; i++) {
    try {
      await page.goto(BASE)
      break
    } catch (e) {
      if (i > 60) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  const hookAt = async (query) => {
    await page.goto(`${BASE}?${query}`)
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
    return page.evaluate(() => window.__dogfight)
  }

  const base = await hookAt('capture=1&frame=0&webgl=1')
  const noise = await hookAt('capture=1&frame=0&webgl=1&noiseprobe=1')
  const march = (await hookAt('capture=1&frame=0&webgl=1&marchprobe=1')).marchProbe
  const sprite = (await hookAt('capture=1&frame=0&webgl=1&spriteprobe=1')).spriteProbe
  const tone = (await hookAt('capture=1&frame=0&webgl=1&toneprobe=1')).toneProbe
  const overlay = (await hookAt('capture=1&frame=0&webgl=1&overlayprobe=1')).overlayProbe
  const surface = (await hookAt('capture=1&frame=0&webgl=1&surfaceprobe=1')).surfaceProbe
  const shadow = await hookAt(
    `capture=1&webgl=1&script=level&frame=240&hour=16&coverage=${SHADOW_COVERAGE}&shadowprobe=1`,
  )

  // ---- 空を背にした半透明の物の画素数（node-path.spec の同名の検査と同じ撮り方）----
  const shoot = async (query, off) => {
    const params = captureParams(query)
    params.set('webgl', '1')
    if (off !== null) params.set(off, '0')
    params.set('bloom', '0')
    await page.goto(`${BASE}?${params.toString()}`)
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
    return PNG.sync.read(await page.locator('#viewport').screenshot())
  }
  const changed = (a, b) => {
    let n = 0
    for (let px = 0; px < a.width * a.height; px++) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(a.data[px * 4 + c] - b.data[px * 4 + c]) > 1) {
          n++
          break
        }
      }
    }
    return n
  }
  const vortex = SCENES.find((s) => s.name === 'aircraft-vortex-long')
  const explosionQuery = { script: 'gun-pass', frame: 135, hour: 16, coverage: 0, aircraft: false }
  const translucent = {
    explosion: changed(await shoot(explosionQuery, null), await shoot(explosionQuery, 'explosions')),
    vortex: changed(await shoot(vortex, null), await shoot(vortex, 'trails')),
  }

  if (errors.length > 0) throw new Error(`コンソールに ${errors.length} 件: ${errors.join(' / ')}`)

  const reference = {
    note: 'GLSL 経路の最後の出力。tools/node-reference.mjs が書く。手で直さない',
    project: DEFAULT_PROJECT,
    sunElevation: base.sunElevation,
    sunRadiance: base.sunRadiance,
    skyRadiance: base.skyRadiance,
    noiseSlice: bytes(noise.noiseSlice),
    weatherSlice: bytes(noise.weatherSlice),
    march: {
      samples: march.samples,
      exhausted: march.exhausted,
      tiles: march.tiles,
      resolveUv: bytes(march.resolveUv),
      resolveChanged: march.resolveChanged,
    },
    shadow: {
      coverage: SHADOW_COVERAGE,
      inputs: shadow.shadowInputs,
      bins: shadow.shadowHistogram,
      tiles: shadow.shadowTiles,
    },
    sprite: { soft: bytes(sprite.soft), core: bytes(sprite.core) },
    tone: bytes(tone),
    overlay: { composite: bytes(overlay.composite), marker: bytes(overlay.marker) },
    surface: {
      terrain: bytes(surface.terrain),
      terrainBranches: bytes(surface.terrainBranches),
      water: surface.water.map(bytes),
      waterBranches: surface.waterBranches.map(bytes),
    },
    translucent,
  }
  writeFileSync(OUT, JSON.stringify(reference, null, 2) + '\n')
  console.log(`書いた: ${OUT}`)
  console.log(`  太陽高度 ${base.sunElevation}、雲影の入力 ${JSON.stringify(shadow.shadowInputs)}`)
  console.log(`  半透明の画素 爆発 ${translucent.explosion}・飛行機雲 ${translucent.vortex}`)
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {}
}
