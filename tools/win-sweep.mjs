// **実 GPU で予算の配分を測る。**Windows 側の node から Chrome を操作する。
//
// `?sweep=1` は描画の要素を 1 つずつ切って差を測る（`src/render/bench.ts`）。
// 仕掛けはあったが**実機で回す道具が無かった**ので、絵作りを積む前に
// どこに何 ms あるかを知る手段が無かった。
//
// `tools/win-perf.mjs` はライブの計器を時間方向に追う道具。こちらは
// キャプチャモードで 21 条件を総当たりする。**用途が違うので分ける。**
//
// ## 読み方（`docs/measuring.md:24-35` の作法）
//
// **確定できるのは配分で、絶対値はライブループで読む。**1 枚を何度も描くので
// GPU のクロックが上がりきり、ライブより速い値が出る。絶対値は
// `tools/win-perf.mjs` の「最大」を使う。
//
// `?nodegrade=1` を忘れない。プリセットをまたぐと `maxPixelRatio` も変わる
// （high 2 / medium 1.5）ので、固定しないと比較にならない。
//
// ## `only=` で絞る
//
// **21 条件を全部回すと終わらない。**実機で `bench=60` を試して 30 分の
// 上限に当たった（`captureReady` が立たない）。`src/render/bench.ts` の
// 注記にもある「全部回すと機械が熱で遅くなる。基準そのものが 6.14 →
// 16.22 ms へ動いた」と同じ理由で、**知りたい条件だけを回す。**
//
// 配分を取るだけなら `only=base,clouds,terrain,water,aircraft` で足りる。
//
// ## 使い方
//
//   cp tools/win-sweep.mjs /mnt/c/Windows/Temp/dg-pw/sweep.mjs
//   printf '%s\n' "<URL>" > /mnt/c/Windows/Temp/dg-pw/cases.txt
//   cmd.exe /c "cd C:\Windows\Temp\dg-pw && node sweep.mjs"
//
// URL は `cases.txt` で渡す（`cmd.exe` 越しに引数の引用符が混ざる）。
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const urls = readFileSync('cases.txt', 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s !== '')

/** 窓と画素比。**人が見ている条件に揃える**（`win-perf.mjs` と同じ理由） */
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
    const page = await browser.newPage({
      viewport: { width: VIEW_W, height: VIEW_H },
      deviceScaleFactor: DPR,
    })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message.split('\n')[0] ?? e.message))

    console.log(`\n=== ${url}`)
    await page.goto(url, { timeout: 600_000 })

    const gpu = await page.evaluate(async () => {
      if (!navigator.gpu) return 'なし'
      const a = await navigator.gpu.requestAdapter()
      if (!a) return 'adapter なし'
      const i = a.info ?? {}
      return `${i.vendor ?? '?'} / ${i.architecture ?? '?'}`
    })

    // 掃引は 21 条件 × 試料数ぶん描くので長い。既定の待ちでは切れる
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 1_800_000 })

    const out = await page.evaluate(() => {
      const h = window.__dogfight
      return {
        backend: h.backend,
        preset: h.preset,
        rows: h.benchSweep ?? [],
        size: document.querySelector('canvas')
          ? `${document.querySelector('canvas').width}x${document.querySelector('canvas').height}`
          : '?',
      }
    })

    console.log(`GPU: ${gpu}  経路: ${out.backend}  品質: ${out.preset}  描画バッファ: ${out.size}`)

    if (out.rows.length === 0) {
      console.log('  **掃引の結果が空。**`?sweep=1` と `?capture=1` が両方いる')
      if (errors.length > 0) console.log(`  例外 ${errors.length} 件: ${errors[0]}`)
      await page.close()
      continue
    }

    // **代表値は最小値。**割り込みは時間を増やす方向にしか効かない
    // （`src/render/bench.ts` の作法）。ばらつきの床は最小と中央の差の中央値
    const spreads = out.rows
      .filter((r) => r.gpuMinMs !== null && r.gpuMedianMs !== null)
      .map((r) => r.gpuMedianMs - r.gpuMinMs)
      .sort((a, b) => a - b)
    const noise = spreads.length > 0 ? spreads[spreads.length >> 1] : 0

    const base = out.rows[0]
    const key = (r) => (r.gpuMinMs ?? r.cpuMinMs)

    console.log(`  ばらつきの床 ${noise.toFixed(2)} ms（これより小さい差は読まない）`)
    console.log('  条件              GPU 最小  基準との差   三角形')
    for (const r of out.rows) {
      const d = key(base) - key(r)
      // **有意でない差は印を付けない。**表に並ぶと読み手が意味を見てしまう
      const mark = Math.abs(d) > noise ? (d > 0 ? ' ←' : '') : '  （床の内）'
      console.log(
        `  ${r.label.padEnd(16)} ${key(r).toFixed(2).padStart(7)}  ` +
          `${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(6)}  ` +
          `${(r.triangles / 1000).toFixed(0).padStart(5)}k${mark}`,
      )
    }

    // **`cpuSynchronous === false` で GPU が全部 null なら表は読めない。**
    // WebGPU では `gl.finish()` + `readPixels` の排出ができない
    const unreadable = out.rows.every((r) => r.gpuMinMs === null)
    if (unreadable) console.log('  **GPU の値が全部 null。この表は読めない**')

    if (errors.length > 0) console.log(`  例外 ${errors.length} 件: ${errors[0]}`)
    await page.close()
  }
} finally {
  await browser.close()
}
process.exit(0)
