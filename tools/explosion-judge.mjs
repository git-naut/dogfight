// 爆発の形を、中心を通る線の明るさの分布で判定する（段 29）。
//
// **計画書の判定。**「中心を通る線の線形輝度の分布に、火と空のあいだの局所
// 極小（黒煙の縁）が出ること」。参考画像の特徴は 5 つ（複数の球の連なり、
// 白く飛んだ芯、黒い煙の縁、白い煙の長い尾、破片が見えない）で、そのうち
// 数で見られるのが黒煙の縁。
//
// **自機を消して撮る。**追従カメラは自機の後ろ上方から前を見るので、前方
// 296 m の標的の爆発は画面の中央、自機のすぐ上に重なって大半が隠れる
// （`explosion-gun` の基準画像では小さなしみにしか見えなかった）。
//
// **爆発の領域は撮って作る。**`?aircraft=0` の絵と `?aircraft=0&explosions=0`
// の絵の差を `NOISE_FLOOR` で切り、最大の塊を取る（`tools/detail-judge.mjs`
// の関数を使う）。
//
//   node tools/explosion-judge.mjs [--nobuild] [--port N] [--frames 120,150,200]
//     [--query k=v&k=v] [--out 保存先]
//
// 台本は `gun-pass`（フレーム 108 に 296 m 先で撃墜、強さ 1.0）。
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { fileURLToPath } from 'node:url'
import { launchArgsFor, VIEWPORT } from '../tests/e2e/launch.mjs'
import { captureParams } from '../tests/e2e/scenes.mjs'
import { diffMask, largestComponent, luminancePlane } from './detail-judge.mjs'

/** 空より何割暗ければ縁とみなすか */
export const RIM_DARKER = 0.1

/**
 * 中心から外へたどった明るさの列で、黒煙の縁を探す。
 *
 * `profile[0]` が中心、末尾が外側。空の明るさ `sky` に届く（空の 95% 以上に
 * 戻る）までのあいだの最小が、空より `RIM_DARKER` 以上暗ければ縁がある。
 * 空へ抜けないまま線が終わったら判定できない（`reachedSky: false`）
 */
export function rimDip(profile, sky, darker = RIM_DARKER) {
  // 火（空より明るい）を抜けて、初めて空の明るさまで落ちた所から谷を探す。
  // **火の上で打ち切らない。**最初の版は中心の火を「空に届いた」と読んだ
  let start = -1
  for (let i = 1; i < profile.length; i++) {
    if (profile[i] <= sky * 1.05) {
      start = i
      break
    }
  }
  if (start < 0) return { found: false, min: Infinity, depth: 0, reachedSky: false }
  let min = Infinity
  let reachedSky = false
  for (let i = start; i < profile.length; i++) {
    const v = profile[i]
    if (v < min) min = v
    // 谷の底を過ぎて空の明るさへ戻ったら終わり
    if (v >= sky * 0.95 && i > start) {
      reachedSky = true
      break
    }
    // 落ちた所がそのまま空だった（谷が無い）
    if (i === start && v >= sky * 0.95) {
      reachedSky = true
      break
    }
  }
  const depth = (sky - min) / sky
  return { found: reachedSky && depth >= darker, min, depth, reachedSky }
}

/** 芯が白く飛んでいるとみなす、空に対する明るさの倍率 */
export const HOT_CORE = 1.3

/**
 * 爆発の形の判定。**芯が白く飛び、その外に黒い縁がある**ことの組。
 *
 * **谷だけでは判定しない。**赤い火球は線形輝度で空より暗いので、火球そのものが
 * 「空より暗い谷」に見える（段 29 で最初に測ったとき、0.06 秒の赤い火球を
 * 「空より 43〜52% 暗い縁」と読んだ）。芯が空の `HOT_CORE` 倍より明るいときだけ
 * 縁を探す
 */
export function judgeExplosion(profile, sky) {
  const hotCore = profile[0] >= sky * HOT_CORE
  const rim = rimDip(profile, sky)
  const ok = hotCore && rim.found
  const why = !hotCore ? '芯が立っていない' : !rim.found ? '縁が無い' : '両立'
  return { hotCore, rim, ok, why }
}

/** 塊の画素の平均の位置。空なら null */
export function centroid(mask, width) {
  let sx = 0
  let sy = 0
  let n = 0
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 0) continue
    const x = p % width
    sx += x
    sy += (p - x) / width
    n++
  }
  if (n === 0) return null
  return { x: Math.round(sx / n), y: Math.round(sy / n), pixels: n }
}

// ---- 以下は撮影。関数だけを読み込むときは走らせない ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = fileURLToPath(new URL('..', import.meta.url))
  const argv = process.argv.slice(2)
  const arg = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
  }
  const PORT = Number(arg('--port', 4178))
  const BASE = `http://127.0.0.1:${PORT}/dogfight/`
  const FRAMES = arg('--frames', '120,150,200,260').split(',').map(Number)
  const QUERY = arg('--query', null)
  const OUT = arg('--out', null)

  if (!argv.includes('--nobuild')) {
    const build = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
    const code = await new Promise((r) => build.on('exit', r))
    if (code !== 0) process.exit(code)
  }
  const server = spawn(
    'npm',
    ['run', 'preview', '--', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore', detached: true },
  )
  const browser = await chromium.launch({ args: launchArgsFor('chromium-webgpu') })
  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(BASE)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })
    if (OUT !== null) mkdirSync(OUT, { recursive: true })
    const extra = QUERY === null ? {} : Object.fromEntries(new URLSearchParams(QUERY))

    const shoot = async (frame, query) => {
      const params = captureParams({ script: 'gun-pass', frame, hour: 16, coverage: 0 })
      for (const [k, v] of Object.entries({ aircraft: 0, ...extra, ...query })) params.set(k, String(v))
      await page.goto(`${BASE}?${params.toString()}`, { timeout: 300000 })
      await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300000 })
      return PNG.sync.read(await page.locator('#viewport').screenshot())
    }

    console.log(`台本 gun-pass（撃墜はフレーム 108）${QUERY === null ? '' : `  ${QUERY}`}`)
    for (const frame of FRAMES) {
      const withBoom = await shoot(frame, {})
      const without = await shoot(frame, { explosions: 0 })
      const { width, height } = withBoom
      const blob = largestComponent(diffMask(withBoom.data, without.data, width, height), width, height)
      const c = centroid(blob, width)
      const age = ((frame - 108) / 120).toFixed(2)
      if (c === null) {
        console.log(`  フレーム ${frame}（${age} 秒）: 爆発が写っていない`)
        continue
      }
      // 横に塊の幅の 1.5 倍まで外へ。空の明るさは爆発を消した絵の同じ線から取る
      let x0 = width
      let x1 = -1
      for (let x = 0; x < width; x++) {
        if (blob[c.y * width + x]) {
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
        }
      }
      const half = Math.max(c.x - x0, x1 - c.x)
      const reach = Math.round(half * 1.5) + 4
      const lum = luminancePlane(withBoom.data, width, height)
      const skyLum = luminancePlane(without.data, width, height)
      const side = (dir) => {
        const profile = []
        const skyRow = []
        for (let k = 0; k <= reach; k++) {
          const x = Math.min(width - 1, Math.max(0, c.x + dir * k))
          profile.push(lum[c.y * width + x])
          skyRow.push(skyLum[c.y * width + x])
        }
        const sky = skyRow.slice(-4).reduce((a, b) => a + b, 0) / 4
        return { ...judgeExplosion(profile, sky), sky }
      }
      const left = side(-1)
      const right = side(1)
      const fmt = (j) =>
        `${j.why}（谷 ${j.rim.min === Infinity ? '-' : `空より ${(j.rim.depth * 100).toFixed(0)}%`}）`
      console.log(
        `  フレーム ${frame}（${age} 秒）: 塊 ${c.pixels} 画素、幅 ${x1 - x0 + 1} 画素、中心 (${c.x}, ${c.y})、` +
          `芯 ${lum[c.y * width + c.x].toFixed(3)}（空の ${(lum[c.y * width + c.x] / left.sky).toFixed(2)} 倍）  左 ${fmt(left)}  右 ${fmt(right)}`,
      )
      if (OUT !== null) {
        const pad = reach + 10
        const crop = new PNG({ width: pad * 2, height: pad * 2 })
        for (let y = 0; y < pad * 2; y++) {
          for (let x = 0; x < pad * 2; x++) {
            const sx = Math.min(width - 1, Math.max(0, c.x - pad + x))
            const sy = Math.min(height - 1, Math.max(0, c.y - pad + y))
            for (let ch = 0; ch < 4; ch++) crop.data[(y * pad * 2 + x) * 4 + ch] = withBoom.data[(sy * width + sx) * 4 + ch]
          }
        }
        writeFileSync(join(OUT, `explosion-${frame}.png`), PNG.sync.write(crop))
      }
    }
  } finally {
    await browser.close()
    try {
      process.kill(-server.pid)
    } catch {}
  }
  process.exit(0)
}
