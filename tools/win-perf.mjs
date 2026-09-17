// **実 GPU で性能と降格を測る。**Windows 側の node から Chrome を操作する。
//
// `tools/win-measure.mjs` は `#clouddiag` を待つ雲の診断専用。こちらは
// ライブの計器（`hook`）を時間方向に追う。**降格は時間が経たないと起きない**
// ので、1 点の値では分からない（`PerformanceGovernor` は 55 fps を 3 秒
// 連続で下回ったら 1 段落とし、そのあと 5 秒待つ）。
//
// 使い方は `docs/measuring.md` の「実 GPU で測る」と同じ。`cases.txt` に
// 1 行 1 URL を書いて渡す（`cmd.exe` 越しに引数の引用符が混ざるため）。
//
//   cp tools/win-perf.mjs /mnt/c/Windows/Temp/dg-pw/perf.mjs
//   printf '%s\n' "URL1" "URL2" > /mnt/c/Windows/Temp/dg-pw/cases.txt
//   cmd.exe /c "cd C:\Windows\Temp\dg-pw && node perf.mjs"
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const urls = readFileSync('cases.txt', 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s !== '')

/** 何秒ぶん追うか。降格（3 秒）とその後の冷却（5 秒）を跨ぐ長さが要る */
const SECONDS = Number(process.env['SECONDS'] ?? 20)
/** 窓の大きさと画素比。既定は人が見ている 2400x1183 / DPR 1.5 に合わせる */
const VIEW_W = Number(process.env['VIEW_W'] ?? 1600)
const VIEW_H = Number(process.env['VIEW_H'] ?? 789)
const DPR = Number(process.env['DPR'] ?? 1.5)

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--disable-gpu-sandbox',
    // **`http://` は保安コンテキストではない。**WebGPU が生えない
    ...(urls[0].startsWith('http://')
      ? [`--unsafely-treat-insecure-origin-as-secure=${new URL(urls[0]).origin}`]
      : []),
  ],
})

try {
  for (const url of urls) {
    // **人が見ている条件に揃える。**既定の 1280x720 / DPR 1 は、実機の
    // 2400x1183（DPR 1.5）に対して画素数が 3.1 分の 1。軽すぎて降格が
    // 起きず、「降格しない」という誤った結論になる（2026-09-17 に踏んだ）
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

    // **タイトルを閉じて飛ばす。**`#title` が出ている間はループが回らない
    await page.waitForFunction(() => document.querySelector('.title-start') !== null, undefined, {
      timeout: 180_000,
    })
    await page.locator('.title-start').click()
    await page.waitForFunction(() => (window.__dogfight?.frame ?? 0) > 0, undefined, {
      timeout: 180_000,
    })

    // **項目名を推測しない。**`hook` に `fps` と `gpuFrameMaxMs` は無く、
    // 計器（`?debug=1` のパネル）が別経路で持っていた。読める名前だけ読む
    const read = () =>
      page.evaluate(() => {
        const h = window.__dogfight
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        return {
          backend: h.backend,
          preset: h.preset,
          frame: h.frame,
          gpuFrameMs: num(h.gpuFrameMs),
          gpuTimerSupported: h.gpuTimerSupported === true,
          drawCalls: num(h.drawCalls),
          drawnTriangles: num(h.drawnTriangles),
          // **GPU 時間と fps は `hook` に無い。**`hook.gpuFrameMs` は初期値
          // 0 のままで、`main.ts` は計器（`debug.update`）にしか渡さない。
          // 計器の行をそのまま読む（名前を当てるより確実）
          panel: Object.fromEntries(
            [...document.querySelectorAll('.debug-panel .debug-row')].map((r) => [
              r.querySelector('.debug-label')?.textContent?.trim() ?? '?',
              r.querySelector('.debug-value')?.textContent?.trim() ?? '',
            ]),
          ),
        }
      })

    const first = await read()
    console.log(`\n=== ${url}`)
    console.log(`GPU: ${gpu}  経路: ${first.backend}  計測: ${first.gpuTimerSupported}`)
    console.log(`  窓 ${VIEW_W}x${VIEW_H} DPR ${DPR}  解像度 ${first.panel['解像度'] ?? '?'}`)
    console.log('  秒  品質      FPS          GPU 時間')

    const samples = []
    for (let t = 1; t <= SECONDS; t++) {
      await page.waitForTimeout(1000)
      const s = await read()
      samples.push(s)
      // 毎秒は多いので 5 秒ごとと、品質が動いた瞬間を出す
      const changed = samples.length > 1 && s.preset !== samples[samples.length - 2].preset
      if (t % 5 === 0 || changed || t === 1) {
        console.log(
          `  ${String(t).padStart(2)}  ${s.preset.padEnd(8)}  ${(s.panel['FPS'] ?? '?').padEnd(11)}` +
            `  ${s.panel['GPU 時間'] ?? '?'}` +
            (changed ? '  ← 品質が動いた' : ''),
        )
      }
    }

    const last = samples[samples.length - 1]
    console.log(
      `  結果: ${first.preset} → ${last.preset}` +
        `（降格 ${first.preset === last.preset ? '**なし**' : 'あり'}）` +
        ` FPS ${last.panel['FPS'] ?? '?'}  GPU ${last.panel['GPU 時間'] ?? '?'}` +
        `  シムのフレーム ${first.frame} → ${last.frame}`,
    )
    console.log(`  投入 ${last.panel['投入'] ?? '?'}  CPU ${last.panel['CPU 時間'] ?? '?'}`)
    if (errors.length > 0) console.log(`  例外 ${errors.length} 件: ${errors[0]}`)
    await page.close()
  }
} finally {
  await browser.close()
}
process.exit(0)
