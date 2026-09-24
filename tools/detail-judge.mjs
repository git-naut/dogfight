// 機体の表面ディテールが効いたかを、機体マスクの中の統計で判定する。
//
// **判定は 3 条件の組で行う（計画書の表面ディテールの段）。**
//
//   マスク内の線形輝度の中央値が +10% 以内   … 鏡になっていない
//   マスク内の 99 パーセンタイルが +30% 以上 … ハイライトが立った
//   局所ディテール画素数が増える              … 模様が乗った
//
// 片方だけでは鏡（中央値も p99 も上がる）とただの減光（両方下がる）を
// 区別できない。統計の形は `tools/bloom-sweep.mjs` と同じ。
//
// **機体マスクは撮って作る。**矩形を置く `bloom-sweep` と違い、機体の輪郭は
// 構図ごとに形が違う。`?aircraft=0` で機体を消した絵との差をマスクにする。
// 両方 `shadow=0&bloom=0` で撮る。機体を消すと地面の影も消え、ブルームの
// にじみも消えるので、そのままでは輪郭の外側までマスクに入る（「遮蔽物を
// 切ると裏のものが代わりに描かれる」）。
//
// **差は `NOISE_FLOOR` を越えたものだけ数える。**SwiftShader は同じ状態を
// 撮り直すだけで約 1,800 バイトが 1 動く（`docs/lessons.md`）。
//
// **マスクは 2 画素縮める。**局所ディテールは 5x5 の箱平均との差で数える
// ので、輪郭の 2 画素内側までは窓が背景を拾い、境目そのものを模様と読む。
// 縮めたあとは最大の塊だけを残す（機体を消すと雲も少し動く）。
//
//   node tools/detail-judge.mjs [--nobuild] [--port N] [--scenes a,b]
//     [--query k=v&k=v] [--repeat] [--out 保存先]
//
// `--query` を渡すと既定の絵と比べて判定する。渡さなければ基準だけを測る。
// `--repeat` は基準を 2 回撮り、統計が一致するかを見る（効果を入れる前に
// 測り方が揺れないことを確かめる）。
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const PORT = Number(arg('--port', 4177))
const BASE = `http://127.0.0.1:${PORT}/dogfight/`
const NOBUILD = argv.includes('--nobuild')
const REPEAT = argv.includes('--repeat')
const OUT = arg('--out', null)
const QUERY = arg('--query', null)
/** 機体が大きく写る正午と、普段の 16 時 */
const SCENE_NAMES = arg('--scenes', 'aircraft-close,level-afternoon').split(',')

/** `src/render/clouds/marchProbe.ts` の `NOISE_FLOOR` と同じ値 */
export const NOISE_FLOOR = 1
/** マスクを縮める画素数。5x5 の窓の半径 */
export const ERODE = 2
/**
 * 局所ディテールとみなす、箱平均との差（線形輝度）。
 *
 * 0.01 は線形で 1%。暗い外板（線形 0.05 前後）では sRGB でおよそ 3 階調に
 * あたり、雑音の 1 階調より十分大きい
 */
export const DETAIL_THRESHOLD = Number(arg('--detail-threshold', 0.01))

/** 線形輝度。sRGB の逆ガンマを掛けてから Rec.709 の重みで混ぜる */
export function luminance(r, g, b) {
  const lin = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 2 枚の差が雑音を越えた画素を 1 にする */
export function diffMask(a, b, width, height, floor = NOISE_FLOOR) {
  const mask = new Uint8Array(width * height)
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(a[p * 4 + c] - b[p * 4 + c]) > floor) {
        mask[p] = 1
        break
      }
    }
  }
  return mask
}

/**
 * マスクを縮める。周り (2r+1)^2 がすべて 1 の画素だけを残す。
 *
 * **画面の端は 0 にする。**窓がはみ出す画素は箱平均を取れない
 */
export function erode(mask, width, height, r = ERODE) {
  const out = new Uint8Array(width * height)
  for (let y = r; y < height - r; y++) {
    for (let x = r; x < width - r; x++) {
      let all = 1
      for (let dy = -r; dy <= r && all; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (mask[(y + dy) * width + x + dx] === 0) {
            all = 0
            break
          }
        }
      }
      out[y * width + x] = all
    }
  }
  return out
}

/**
 * 最大の塊（4 近傍で繋がった 1 の集まり）だけを残す。
 *
 * **機体を消すと雲の描かれ方も少し変わる。**`aircraft-close` では機体の上の
 * 空に小さな塊が出た。縮めたあとに残った機体と関係のない画素を落とす
 */
export function largestComponent(mask, width, height) {
  const label = new Int32Array(width * height)
  const stack = []
  let best = 0
  let bestSize = 0
  let next = 0
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || label[start] !== 0) continue
    next++
    let size = 0
    label[start] = next
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()
      size++
      const x = p % width
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p < width * (height - 1) ? p + width : -1,
      ]
      for (const q of neighbours) {
        if (q >= 0 && mask[q] !== 0 && label[q] === 0) {
          label[q] = next
          stack.push(q)
        }
      }
    }
    if (size > bestSize) {
      bestSize = size
      best = next
    }
  }
  const out = new Uint8Array(width * height)
  for (let p = 0; p < out.length; p++) if (label[p] === best && best !== 0) out[p] = 1
  return out
}

/** 絵全体の線形輝度 */
export function luminancePlane(data, width, height) {
  const lum = new Float64Array(width * height)
  for (let p = 0; p < width * height; p++) {
    lum[p] = luminance(data[p * 4], data[p * 4 + 1], data[p * 4 + 2])
  }
  return lum
}

/**
 * マスクの中の中央値・99 パーセンタイル・局所ディテール画素数。
 *
 * 局所ディテールは 5x5 の箱平均との差が閾値を越える画素の数。マスクは
 * 縮めてあるので、窓は機体の内側に収まる
 */
export function maskStats(lum, mask, width, threshold = DETAIL_THRESHOLD, r = ERODE) {
  const values = []
  let detail = 0
  const n = (2 * r + 1) ** 2
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 0) continue
    values.push(lum[p])
    const x = p % width
    const y = (p - x) / width
    let sum = 0
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) sum += lum[(y + dy) * width + x + dx]
    }
    if (Math.abs(lum[p] - sum / n) > threshold) detail++
  }
  if (values.length === 0) return { pixels: 0, median: NaN, p99: NaN, detail: 0 }
  values.sort((a, b) => a - b)
  return {
    pixels: values.length,
    median: values[values.length >> 1],
    p99: values[Math.floor(values.length * 0.99)],
    detail,
  }
}

/** 3 条件の組。基準と比べた上がり幅（%）と判定を返す */
export function judge(base, now) {
  const rise = (a, b) => (a / b - 1) * 100
  const medianRise = rise(now.median, base.median)
  const p99Rise = rise(now.p99, base.p99)
  const detailGain = now.detail - base.detail
  const mirror = medianRise > 10
  const flat = p99Rise < 30
  const plain = detailGain <= 0
  const ok = !mirror && !flat && !plain
  const why = mirror ? '**鏡になった**' : flat ? 'ハイライトが立たない' : plain ? '模様が乗らない' : '**両立**'
  return { medianRise, p99Rise, detailGain, ok, why }
}

// ---- 以下は撮影。関数だけを読み込むときは走らせない ----
if (import.meta.url === `file://${process.argv[1]}`) {
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
    const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })
    if (OUT !== null) mkdirSync(OUT, { recursive: true })

    const extra = QUERY === null ? {} : Object.fromEntries(new URLSearchParams(QUERY))
    const pct = (v) => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(7)
    const f = (v) => v.toFixed(4)

    for (const name of SCENE_NAMES) {
      const scene = SCENES.find((s) => s.name === name)
      if (scene === undefined) throw new Error(`知らない構図: ${name}`)

      const shoot = async (query) => {
        const params = captureParams(scene)
        for (const [k, v] of Object.entries(query)) params.set(k, String(v))
        await page.goto(`${BASE}?${params.toString()}`, { timeout: 300000 })
        await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300000 })
        return PNG.sync.read(await page.locator('#viewport').screenshot())
      }

      const withCraft = await shoot({ shadow: 0, bloom: 0 })
      const without = await shoot({ aircraft: 0, shadow: 0, bloom: 0 })
      const { width, height } = withCraft
      const outline = diffMask(withCraft.data, without.data, width, height)
      const mask = largestComponent(erode(outline, width, height), width, height)

      const base = await shoot({})
      const baseStats = maskStats(luminancePlane(base.data, width, height), mask, width)
      const outlinePixels = outline.reduce((s, v) => s + v, 0)

      console.log(`構図 ${name}`)
      console.log(`  マスク ${outlinePixels} 画素（縮めて ${baseStats.pixels}）`)
      console.log(
        `  基準: 中央値 ${f(baseStats.median)}  p99 ${f(baseStats.p99)}  ディテール ${baseStats.detail}`,
      )

      if (REPEAT) {
        const again = await shoot({})
        const s = maskStats(luminancePlane(again.data, width, height), mask, width)
        const same = s.median === baseStats.median && s.p99 === baseStats.p99 && s.detail === baseStats.detail
        console.log(
          `  2 回目: 中央値 ${f(s.median)}  p99 ${f(s.p99)}  ディテール ${s.detail}  ${same ? '一致' : '**揺れた**'}`,
        )
      }

      if (QUERY !== null) {
        const now = await shoot(extra)
        const s = maskStats(luminancePlane(now.data, width, height), mask, width)
        const j = judge(baseStats, s)
        console.log(
          `  ${QUERY}: 中央値 ${pct(j.medianRise)}  p99 ${pct(j.p99Rise)}  ディテール ${j.detailGain >= 0 ? '+' : ''}${j.detailGain}  ${j.why}`,
        )
        if (OUT !== null) writeFileSync(join(OUT, `${name}-query.png`), PNG.sync.write(now))
      }

      if (OUT !== null) {
        writeFileSync(join(OUT, `${name}-base.png`), PNG.sync.write(base))
        // マスクは白、縮めて落ちた輪郭は灰
        const m = new PNG({ width, height })
        for (let p = 0; p < width * height; p++) {
          const v = mask[p] ? 255 : outline[p] ? 96 : 0
          m.data[p * 4] = m.data[p * 4 + 1] = m.data[p * 4 + 2] = v
          m.data[p * 4 + 3] = 255
        }
        writeFileSync(join(OUT, `${name}-mask.png`), PNG.sync.write(m))
      }
      console.log('')
    }
  } finally {
    await browser.close()
    try {
      process.kill(-server.pid)
    } catch {}
  }
  process.exit(0)
}
