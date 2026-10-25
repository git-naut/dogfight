// **実 GPU でパスごとの所要を測る**（段 S0a）。Windows 側の node から Chrome を操作する。
//
// `tools/win-perf.mjs` の形を踏む。違いは、計器の 1 行ではなくフックの
// `gpuPassHistory`（フレームごとの内訳）を 0.5 秒おきに読み、フレーム番号で
// 重なりを除いて全フレームを集めること。**解決は数フレームまとめて届く**ので、
// 1 点を読むだけでは約 1 秒おきの環境反射のような間欠の重さを取りこぼす。
//
// 使い方（`docs/measuring.md` の「実 GPU で測る」と同じ）:
//
//   cp tools/win-pass-perf.mjs tools/pass-stats.mjs /mnt/c/Windows/Temp/dg-pw/
//   printf '%s\n' "URL1" "URL2" > /mnt/c/Windows/Temp/dg-pw/cases.txt
//   cmd.exe /c "cd C:\Windows\Temp\dg-pw && node win-pass-perf.mjs"
//
// 環境変数: SECONDS（既定 20）、VIEW_W・VIEW_H・DPR（既定 1600x789・1.5）、
// WARMUP（統計に入れない始めの秒、既定 3）、OUT（JSON を 1 行ずつ足すファイル、
// 既定 pass-perf.jsonl）、LABEL（記録に付ける名前）。
import { chromium } from 'playwright-core'
import { appendFileSync, readFileSync } from 'node:fs'
import { collectFrames, passStats } from './pass-stats.mjs'

const urls = readFileSync('cases.txt', 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s !== '')

const SECONDS = Number(process.env['SECONDS'] ?? 20)
/** 統計に入れない始めの秒。シェーダの組み立てと最初の解決の遅れを外す */
const WARMUP = Number(process.env['WARMUP'] ?? 3)
/** 窓の大きさと画素比。既定は Phase 10 までの合否の条件（実描画 2400x1183） */
const VIEW_W = Number(process.env['VIEW_W'] ?? 1600)
const VIEW_H = Number(process.env['VIEW_H'] ?? 789)
const DPR = Number(process.env['DPR'] ?? 1.5)
const OUT = process.env['OUT'] ?? 'pass-perf.jsonl'
const LABEL = process.env['LABEL'] ?? ''

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--disable-gpu-sandbox',
    // **`http://` の出どころを全部渡す。**理由は `win-perf.mjs` の同じ箇所
    ...(urls.some((u) => u.startsWith('http://'))
      ? [
          `--unsafely-treat-insecure-origin-as-secure=${[
            ...new Set(urls.filter((u) => u.startsWith('http://')).map((u) => new URL(u).origin)),
          ].join(',')}`,
        ]
      : []),
  ],
})

const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(2))

try {
  for (const url of urls) {
    const page = await browser.newPage({
      viewport: { width: VIEW_W, height: VIEW_H },
      deviceScaleFactor: DPR,
    })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message.split('\n')[0] ?? e.message))
    await page.goto(url, { timeout: 180_000 })

    const gpu = await page.evaluate(async () => {
      if (!navigator.gpu) return 'なし'
      const a = await navigator.gpu.requestAdapter()
      if (!a) return 'adapter なし'
      const i = a.info ?? {}
      return `${i.vendor ?? '?'} / ${i.architecture ?? '?'}`
    })

    // タイトルを閉じて飛ばす。`#title` が出ている間はループが回らない
    await page.waitForFunction(() => document.querySelector('.title-start') !== null, undefined, {
      timeout: 180_000,
    })
    await page.locator('.title-start').click()
    await page.waitForFunction(() => (window.__dogfight?.frame ?? 0) > 0, undefined, {
      timeout: 180_000,
    })

    // **前回より新しいフレームだけを持ち出す。**輪は最大 240 フレーム × 数十本で、
    // 毎回まるごと渡すと 0.5 秒おきに 1 万個ほどの直列化がページの主スレッドに乗り、
    // 測っているものを乱す
    let newest = -1
    const read = () =>
      page.evaluate((since) => {
        const h = window.__dogfight
        return {
          backend: h.backend,
          preset: h.preset,
          frame: h.frame,
          supported: h.gpuTimerSupported === true,
          mismatches: h.gpuPassMismatches,
          history: h.gpuPassHistory.filter((f) => f.frame > since),
          fps: document.querySelector('.debug-panel')
            ? ([...document.querySelectorAll('.debug-panel .debug-row')]
                .find((r) => r.querySelector('.debug-label')?.textContent?.trim() === 'FPS')
                ?.querySelector('.debug-value')?.textContent?.trim() ?? '?')
            : '?',
        }
      }, newest)

    const first = await read()
    console.log(`\n=== ${LABEL ? `[${LABEL}] ` : ''}${url}`)
    console.log(`GPU: ${gpu}  経路: ${first.backend}  計測: ${first.supported}`)
    console.log(`  窓 ${VIEW_W}x${VIEW_H} DPR ${DPR}  ${SECONDS} 秒（始めの ${WARMUP} 秒は捨てる）`)

    const seen = new Map()
    const presets = [first.preset]
    let last = first
    const end = Date.now() + SECONDS * 1000
    const warmEnd = Date.now() + WARMUP * 1000
    while (Date.now() < end) {
      await page.waitForTimeout(500)
      last = await read()
      for (const f of last.history) newest = Math.max(newest, f.frame)
      if (last.preset !== presets[presets.length - 1]) presets.push(last.preset)
      if (Date.now() < warmEnd) {
        // 捨てる区間のフレームも番号だけ控え、あとで重ねて数えないようにする
        for (const f of last.history) seen.set(f.frame, null)
        continue
      }
      collectFrames(seen, last.history)
    }
    const frames = [...seen.values()].filter((f) => f !== null)
    const stats = passStats(frames)

    console.log(
      `  フレーム ${stats.frames}  控えなし ${stats.unlabeled}  食い違い ${last.mismatches}` +
        `  品質 ${presets.join(' → ')}（降格 ${presets.length === 1 ? '**なし**' : 'あり'}）  FPS ${last.fps}`,
    )
    console.log(
      `  合計 ms  最小 ${fmt(stats.total.min)}  中央 ${fmt(stats.total.median)}` +
        `  95% ${fmt(stats.total.p95)}  最大 ${fmt(stats.total.max)}`,
    )
    console.log('  群            出た割合  中央     95%      最大     平均の寄与')
    for (const g of stats.groups) {
      console.log(
        `  ${g.group.padEnd(10)}  ${(g.share * 100).toFixed(0).padStart(5)}%` +
          `  ${fmt(g.median).padStart(7)}  ${fmt(g.p95).padStart(7)}  ${fmt(g.max).padStart(7)}` +
          `  ${fmt(g.meanPerFrame).padStart(7)}`,
      )
    }
    if (errors.length > 0) console.log(`  例外 ${errors.length} 件: ${errors[0]}`)

    appendFileSync(
      OUT,
      JSON.stringify({
        label: LABEL,
        url,
        at: new Date().toISOString(),
        gpu,
        backend: first.backend,
        view: { width: VIEW_W, height: VIEW_H, dpr: DPR },
        seconds: SECONDS,
        warmup: WARMUP,
        presets,
        fps: last.fps,
        mismatches: last.mismatches,
        errors,
        stats,
      }) + '\n',
    )
    await page.close()
  }
} finally {
  await browser.close()
}
process.exit(0)
