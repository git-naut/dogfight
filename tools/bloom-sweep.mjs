// ブルームの閾値と強さを掃引して、空が光らず輝点だけが立つ値を探す。
//
// **判定は 2 条件の組で行う。**片側だけでは「全体が明るくなった」と
// 「ハイライトが立った」を区別できない。
//
//   空だけの領域の中央値が +2% 以内     … 空をブルームさせていない
//   輝点のある領域の 99 パーセンタイルが +25% 以上 … ハイライトが立った
//
// この形は計画書が段 20（表面ディテール）で書いた判定をそのまま流用した
// もので、段 24 でも同じ統計を使う。
//
// 閾値は**露出後の値**で振る。ページへは `?bloomthreshold=` で渡し、
// `nodeScene.ts` の `bloomThresholdFor` が露出で割る。
//
//   node tools/bloom-sweep.mjs [--nobuild] [--port N] [--scene 名]
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { PNG } from 'pngjs'
import { fileURLToPath } from 'node:url'
import { launchArgsFor, VIEWPORT } from '../tests/e2e/launch.mjs'
import { captureParams, SCENES } from '../tests/e2e/scenes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', 4176))
const BASE = `http://127.0.0.1:${PORT}/dogfight/`
const NOBUILD = argv.includes('--nobuild')

/**
 * 振る値。**閾値と強さは独立に効く。**
 *
 * 閾値は「どの明るさから拾うか」（露出後の値。空の最大は 1.11）。
 * 強さは「拾ったものをどれだけ足すか」。片方を固定してもう片方を振る。
 *
 *   --thresholds 0.6,0.9,1.2,1.8   --strength 0.55
 *   --threshold 1.2                --strengths 0.55,1.0,1.6,2.4
 */
const THRESHOLDS = (arg('--thresholds', null) ?? arg('--threshold', '1.2'))
  .split(',')
  .map(Number)
const STRENGTHS = (arg('--strengths', null) ?? arg('--strength', ''))
  .split(',')
  .filter((v) => v !== '')
  .map(Number)

/**
 * 測る場所。**領域は決め打ちにする。**
 *
 * 雲の診断（`src/render/cloudDiag.ts`）は「領域は実測で決める」と書いているが、
 * あれは雲が動くから。空と機体の位置は台本とフレームで固定なので、構図ごとに
 * 矩形を置ける。**ただし絵を見て置く。**この矩形は `clouds-clear` の
 * 実物を見て選んだ（空は上から 25%、機体は中央下）。
 */
const SCENE_NAME = arg('--scene', 'low-pass-afternoon')
const REGIONS = {
  // 空だけ。島も海も機体も入らない帯
  sky: { x: 0, y: 40, w: 1280, h: 140 },
  /**
   * 雲。**ここを見ていなかった。**
   *
   * 最初は `clouds-clear`（雲量 0）で掃引したので、**ブルームさせたくない
   * 最大のものが構図に入っていなかった。**決めた値（閾値 1.2・強さ 1.0）を
   * 実機の雲のある絵に当てると、積雲が白飛びして輪郭が消えた。
   *
   * 雲は空より明るい（白）ので閾値 1.2 を軽く超える。空が +0.3% でも
   * 雲は大きく動く。**空と雲は別に測る。**
   */
  cloud: { x: 0, y: 150, w: 1280, h: 190 },
  /**
   * 排気口の**外周**。
   *
   * **輝点そのものを測ってはいけない。**排気口は既に白飛びしていて線形輝度
   * 0.92。ブルームを足しても 1.0 で頭打ちになり、閾値を 1.2 から 4.0 まで
   * 振っても p99 が +2.0% で並んだ（実測）。
   *
   * ブルームが光らせるのは輝点の**外側**。差分の絵を見て、排気口
   * （610-670, 525-555）の下の帯が最も動いていたのでここを採った。
   */
  glow: { x: 560, y: 560, w: 170, h: 70 },
}

/** 線形輝度。sRGB の逆ガンマを掛けてから Rec.709 の重みで混ぜる */
function luminance(r, g, b) {
  const lin = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 矩形の中の線形輝度を集めて、中央値と 99 パーセンタイルを返す */
function stats(png, box) {
  const values = []
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * png.width + x) * 4
      values.push(luminance(png.data[i], png.data[i + 1], png.data[i + 2]))
    }
  }
  values.sort((a, b) => a - b)
  return {
    median: values[values.length >> 1],
    p99: values[Math.floor(values.length * 0.99)],
    max: values[values.length - 1],
  }
}

if (!NOBUILD) {
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

  const scene = SCENES.find((s) => s.name === SCENE_NAME)
  if (scene === undefined) throw new Error(`知らない構図: ${SCENE_NAME}`)

  const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })

  async function shoot(query) {
    const params = captureParams(scene)
    for (const [k, v] of Object.entries(query)) params.set(k, String(v))
    await page.goto(`${BASE}?${params.toString()}`, { timeout: 300000 })
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300000 })
    return PNG.sync.read(await page.locator('#viewport').screenshot())
  }

  // 基準はブルームを切った絵。**同じビルドで撮る。**旧基準画像と比べると
  // 他の変更も混ざる
  const off = await shoot({ bloom: 0 })
  const base = {
    sky: stats(off, REGIONS.sky),
    cloud: stats(off, REGIONS.cloud),
    glow: stats(off, REGIONS.glow),
  }

  console.log(`構図 ${SCENE_NAME}`)
  console.log(
    `  ブルームなし: 空 ${base.sky.median.toFixed(4)}  ` +
      `雲 ${base.cloud.median.toFixed(4)}  外周 ${base.glow.median.toFixed(4)}`,
  )
  console.log('')
  console.log(
    STRENGTHS.length > 0
      ? `  強さ（閾値 ${THRESHOLDS[0]}）   空        雲        外周      判定`
      : '  閾値    空        雲        外周      判定',
  )

  // 片方だけを振る。両方振ると組み合わせの数だけ撮ることになる
  const cases =
    STRENGTHS.length > 0
      ? STRENGTHS.map((strength) => ({ threshold: THRESHOLDS[0], strength }))
      : THRESHOLDS.map((threshold) => ({ threshold, strength: null }))

  for (const { threshold, strength } of cases) {
    const png = await shoot({
      bloomthreshold: threshold,
      ...(strength !== null ? { bloomstrength: strength } : {}),
    })
    const sky = stats(png, REGIONS.sky)
    const cloud = stats(png, REGIONS.cloud)
    const hi = stats(png, REGIONS.glow)
    const rise = (now, was) => (now / was - 1) * 100
    const skyRise = rise(sky.median, base.sky.median)
    const cloudRise = rise(cloud.median, base.cloud.median)
    const hiRise = rise(hi.median, base.glow.median)
    // **3 条件の組。**空も雲も上がらず、輝点だけが上がる。
    // 雲を見ていなかったせいで、実機の絵で積雲が白飛びした（2026-09-17）
    const ok = skyRise <= 2 && cloudRise <= 3 && hiRise >= 25
    const why = skyRise > 2 ? '空が光る' : cloudRise > 3 ? '**雲が飛ぶ**' : '輝点が立たない'
    const pct = (v) => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(7)
    console.log(
      `  ${(strength ?? threshold).toFixed(2).padStart(5)}  ` +
        `${pct(skyRise)}  ${pct(cloudRise)}  ${pct(hiRise)}  ${ok ? '**両立**' : why}`,
    )
  }
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {}
}
process.exit(0)
