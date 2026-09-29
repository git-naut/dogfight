// 爆発の形を、中心を通る線の明るさの分布で判定する（段 29）。
//
// **計画書の判定。**「中心を通る線の線形輝度の分布に、火と空のあいだの局所
// 極小（黒煙の縁）が出ること」。参考画像の特徴は 5 つ（複数の球の連なり、
// 白く飛んだ芯、黒い煙の縁、白い煙の長い尾、破片が見えない）で、そのうち
// 数で見られるのが黒煙の縁。
//
// **自機を消して撮る。**差分の塊に自機の影や反射を混ぜないため。段 29 の着手時は
// 「爆発が自機のすぐ上に重なって大半が隠れる」と書いていたが、段 29c で測ると
// `gun-pass` 0.27 秒の爆発（y 279〜373）と自機（y 413〜545）は重なっていなかった。
//
// **爆発の領域は撮って作る。**`?aircraft=0` の絵と `?aircraft=0&explosions=0`
// の絵の差を `NOISE_FLOOR` で切り、最大の塊を取る（`tools/detail-judge.mjs`
// の関数を使う）。
//
//   node tools/explosion-judge.mjs [--nobuild] [--port N] [--frames 120,150,200]
//     [--query k=v&k=v] [--out 保存先]
//
// 台本は `gun-pass`（フレーム 108 に 296 m 先で撃墜、強さ 1.0）。
//
// **ブルームを切って撮る（`bloom=0`）。**ブルームは火の橙を周りの画素へにじませる
// ので、黒い煤の縁が茶色に染まり、色味の検査（`RIM_MAX_CHROMA`）で「火」と読まれる。
// 段 29b の 0.03 秒で、ブルームありの縁は (156, 127, 108)・色味 0.31、なしは
// (88, 84, 81)・色味 0.08 だった。判定は形を見るもので、にじみはレンズの効果。
// ブルームありで見たいときは `--query bloom=1`。
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
  if (start < 0) return { found: false, min: Infinity, minIndex: -1, depth: 0, reachedSky: false }
  let min = Infinity
  let minIndex = -1
  let reachedSky = false
  for (let i = start; i < profile.length; i++) {
    const v = profile[i]
    if (v < min) {
      min = v
      minIndex = i
    }
    // 空の 95% を割ったあと、また空の明るさへ戻ったら終わり。
    // **割る前の画素で打ち切らない。**火が空の明るさを横切る途中の 1 画素を
    // 「空に着いた」と読み、その先の煤を見なかった（段 29b の 0.14 秒）
    if (min < sky * 0.95 && v >= sky * 0.95) {
      reachedSky = true
      break
    }
  }
  // 一度も空を割らずに線が終わった。空の明るさのまま続いた（谷が無い）
  if (!reachedSky && min >= sky * 0.95) reachedSky = true
  const depth = (sky - min) / sky
  return { found: reachedSky && depth >= darker, min, minIndex, depth, reachedSky }
}

/** 芯が白く飛んでいるとみなす、空に対する明るさの倍率 */
export const HOT_CORE = 1.3

/**
 * 黒煙の縁とみなす、空より暗い割合。
 *
 * **白い芯を入れた最初の版で、桃色がかったにじみ（空より 13% 暗い）を縁と読んだ。**
 * 目で見て縁と分かるのはもっと暗いもの
 */
export const RIM_BLACK_DARKER = 0.25

/**
 * 黒煙とみなす色味の上限。谷の底の画素で（最大 − 最小）÷ 最大。
 *
 * 暗くても色味が強ければ火（赤い輪）であって煙ではない
 */
export const RIM_MAX_CHROMA = 0.15

/**
 * 爆発の形の判定。**芯が白く飛び、その外に黒い縁がある**ことの組。
 *
 * **谷だけでは判定しない。**赤い火球は線形輝度で空より暗いので、火球そのものが
 * 「空より暗い谷」に見える（段 29 で最初に測ったとき、0.06 秒の赤い火球を
 * 「空より 43〜52% 暗い縁」と読んだ）。芯が空の `HOT_CORE` 倍より明るいときだけ
 * 縁を探す
 */
export function judgeExplosion(profile, colors, sky) {
  const hotCore = profile[0] >= sky * HOT_CORE
  const rim = rimDip(profile, sky, RIM_BLACK_DARKER)
  let chroma = 0
  if (rim.minIndex >= 0) {
    const [r, g, b] = colors[rim.minIndex]
    const hi = Math.max(r, g, b)
    chroma = hi > 0 ? (hi - Math.min(r, g, b)) / hi : 0
  }
  const colored = rim.found && chroma > RIM_MAX_CHROMA
  const ok = hotCore && rim.found && !colored
  const why = !hotCore
    ? '芯が立っていない'
    : !rim.found
      ? '縁が無い'
      : colored
        ? '縁が赤い（火であって煙ではない）'
        : '両立'
  return { hotCore, rim, chroma, ok, why }
}

/**
 * 芯の明るさ。中心 `(cx, cy)` から半径 `radius` 画素の円の平均。
 *
 * **中心の 1 画素で読まない。**段 29b の最初の測りで、黒い煙の中心を通る曳光弾の
 * 線を「芯が空の 1.48 倍」と読んだ。画面の外の画素は数えない
 */
export function coreLuminance(lum, width, height, cx, cy, radius) {
  let sum = 0
  let n = 0
  const r2 = radius * radius
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue
      sum += lum[y * width + x]
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

/**
 * 芯の位置。塊（`mask`）の中で、半径 `radius` の円の平均がいちばん明るい所。
 *
 * **重心を芯にしない。**差分の塊はブルームのにじみや曳光弾の線を含むので、重心が
 * 火球の中心から外れる（段 29b の 0.03 秒で 10 画素上の空との境目に落ちた）
 */
export function brightestDisk(lum, mask, width, height, radius) {
  let best = { x: -1, y: -1, value: -Infinity }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue
      const value = coreLuminance(lum, width, height, x, y, radius)
      if (value > best.value) best = { x, y, value }
    }
  }
  return best
}

/** 2 つの山を別の火の玉とみなす、あいだの谷の深さ（低い方の山に対する割合） */
export const HOT_SPOT_DIP = 0.05

/**
 * 熱い中心の位置の列（段 29d、複数の球の連なり）。
 *
 * 塊（`mask`）の中で、半径 `radius` の円の平均の明るさが `minLum` 以上の山を探す。
 * 2 つの山は `minSeparation` 画素以上離れ、結ぶ線の上に `HOT_SPOT_DIP` 以上の谷が
 * あるときだけ別に数える。
 *
 * **明るい塊の数では数えない。**火の玉が重なると明るい所がつながって 1 つになる。
 * 谷を条件にするので、平らに明るい所は 1 つに数える
 */
export function hotSpots(lum, mask, width, height, radius, minLum, minSeparation) {
  const avg = new Float64Array(width * height).fill(-Infinity)
  const candidates = []
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 0) continue
    const x = p % width
    const v = coreLuminance(lum, width, height, x, (p - x) / width, radius)
    avg[p] = v
    if (v >= minLum) candidates.push(p)
  }
  candidates.sort((a, b) => avg[b] - avg[a])
  const peaks = []
  for (const c of candidates) {
    const cx = c % width
    const cy = (c - cx) / width
    let separate = true
    for (const q of peaks) {
      const dx = q.x - cx
      const dy = q.y - cy
      const dist = Math.hypot(dx, dy)
      if (dist < minSeparation) {
        separate = false
        break
      }
      // 結ぶ線の上の最小。谷が浅ければ同じ山の裾
      let low = Infinity
      const steps = Math.ceil(dist)
      for (let k = 1; k < steps; k++) {
        const x = Math.round(cx + (dx * k) / steps)
        const y = Math.round(cy + (dy * k) / steps)
        const v = avg[y * width + x] === -Infinity ? 0 : avg[y * width + x]
        low = Math.min(low, v)
      }
      if (low >= avg[c] * (1 - HOT_SPOT_DIP)) {
        separate = false
        break
      }
    }
    if (separate) peaks.push({ x: cx, y: cy, value: avg[c] })
  }
  return peaks
}

/** 芯を読む円の半径。塊の幅に対する割合（最低 2 画素） */
export const CORE_RADIUS = 0.08

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
      for (const [k, v] of Object.entries({ aircraft: 0, bloom: 0, ...extra, ...query })) params.set(k, String(v))
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
      // 芯の円の半径は、重心を通る線での塊の幅から決める
      const rowSpan = (y) => {
        let lo = width
        let hi = -1
        for (let x = 0; x < width; x++) {
          if (blob[y * width + x]) {
            lo = Math.min(lo, x)
            hi = Math.max(hi, x)
          }
        }
        return [lo, hi]
      }
      const lum = luminancePlane(withBoom.data, width, height)
      const skyLum = luminancePlane(without.data, width, height)
      const [w0, w1] = rowSpan(c.y)
      const disk = brightestDisk(lum, blob, width, height, Math.max(2, Math.round((w1 - w0 + 1) * CORE_RADIUS)))
      const core = disk.value
      // ここから先は芯を中心にたどる
      c.x = disk.x
      c.y = disk.y
      // 横に塊の幅の 1.5 倍まで外へ。空の明るさは爆発を消した絵の同じ線から取る
      const [x0, x1] = rowSpan(c.y)
      const half = Math.max(c.x - x0, x1 - c.x)
      const reach = Math.round(half * 1.5) + 4
      const side = (dir) => {
        const profile = []
        const colors = []
        const skyRow = []
        for (let k = 0; k <= reach; k++) {
          const x = Math.min(width - 1, Math.max(0, c.x + dir * k))
          const i = (c.y * width + x) * 4
          profile.push(lum[c.y * width + x])
          colors.push([withBoom.data[i], withBoom.data[i + 1], withBoom.data[i + 2]])
          skyRow.push(skyLum[c.y * width + x])
        }
        const sky = skyRow.slice(-4).reduce((a, b) => a + b, 0) / 4
        profile[0] = core
        return { ...judgeExplosion(profile, colors, sky), sky }
      }
      const left = side(-1)
      const right = side(1)
      // 熱い中心の数（段 29d）。芯と同じ半径の円で読み、互いに 6 画素以上離れた山
      const spots = hotSpots(lum, blob, width, height, Math.max(2, Math.round((w1 - w0 + 1) * CORE_RADIUS)), left.sky * HOT_CORE, 6)
      const fmt = (j) =>
        `${j.why}（谷 ${j.rim.min === Infinity ? '-' : `空より ${(j.rim.depth * 100).toFixed(0)}%`}）`
      console.log(
        `  フレーム ${frame}（${age} 秒）: 塊 ${c.pixels} 画素、幅 ${x1 - x0 + 1} 画素、中心 (${c.x}, ${c.y})、` +
          `芯 ${core.toFixed(3)}（空の ${(core / left.sky).toFixed(2)} 倍）、熱い中心 ${spots.length} 個  左 ${fmt(left)}  右 ${fmt(right)}`,
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
