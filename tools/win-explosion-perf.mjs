// **実 GPU で爆発の費用を測る**（段 29 の締め）。Windows 側の node から Chrome を操作する。
//
// `tools/win-perf.mjs` は 5 秒ごとにしか値を出さないので、3.5 秒しか続かない爆発の
// 増分が読めない。こちらは撃墜の前後を 0.1 秒ごとに追う。
//
// **ライブでは台本の入力が再生されない。**初期条件（位置と標的）だけが使われる
// （`main.ts` の `spawnWorld`）。`gun-pass` の標的は正面 300 m を同じ向きに飛ぶので、
// 機銃（Space）を押し続けて撃墜を起こす。
//
// 比べる相手は `?explosions=0`。撃墜は同じように起き、爆発だけが描かれない。
// **交互に流す**（同じ走行の中で、条件を 1 つずつ）。別々の走行から拾うと、機械の
// 状態の振れが差に混ざる（`docs/lessons.md` の「同じ機械を 2 つのセッションが…」）。
//
//   cp tools/win-explosion-perf.mjs /mnt/c/Windows/Temp/dg-pw/explosion-perf.mjs
//   printf '%s\n' "URL_A" "URL_B" > /mnt/c/Windows/Temp/dg-pw/cases.txt
//   cmd.exe /c "cd C:\Windows\Temp\dg-pw && node explosion-perf.mjs"
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const urls = readFileSync('cases.txt', 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s !== '')

/** 何回ずつ流すか。A, B, A, B の順 */
const ROUNDS = Number(process.env['ROUNDS'] ?? 2)
/** 撃ち始める前に待つ秒数。起動直後の立ち上がりを外す */
const WARMUP = Number(process.env['WARMUP'] ?? 3)
/** 撃ち始めてから追う秒数。撃墜（0.5 秒前後）＋爆発の寿命 3.5 秒を跨ぐ */
const TRACK = Number(process.env['TRACK'] ?? 8)
const VIEW_W = Number(process.env['VIEW_W'] ?? 1600)
const VIEW_H = Number(process.env['VIEW_H'] ?? 789)
const DPR = Number(process.env['DPR'] ?? 1.5)

/** 計器の値の先頭の数。「6.5 / 最大 9.8 ms (16.7)」なら 6.5 */
const lead = (text) => {
  const m = /-?[0-9]+(\.[0-9]+)?/.exec(text ?? '')
  return m === null ? null : Number(m[0])
}
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)
const fmt = (v) => (v === null ? '-' : v.toFixed(2))

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--disable-gpu-sandbox',
    ...(urls[0].startsWith('http://')
      ? [`--unsafely-treat-insecure-origin-as-secure=${new URL(urls[0]).origin}`]
      : []),
  ],
})

const results = urls.map(() => [])
try {
  for (let round = 0; round < ROUNDS; round++) {
    for (let u = 0; u < urls.length; u++) {
      const url = urls[u]
      const page = await browser.newPage({
        viewport: { width: VIEW_W, height: VIEW_H },
        deviceScaleFactor: DPR,
      })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message.split('\n')[0] ?? e.message))
      await page.goto(url, { timeout: 180_000 })
      await page.waitForFunction(() => (window.__dogfight?.frame ?? 0) > 0, undefined, {
        timeout: 180_000,
      })
      const read = () =>
        page.evaluate(() => {
          const h = window.__dogfight
          const panel = Object.fromEntries(
            [...document.querySelectorAll('.debug-panel .debug-row')].map((r) => [
              r.querySelector('.debug-label')?.textContent?.trim() ?? '?',
              r.querySelector('.debug-value')?.textContent?.trim() ?? '',
            ]),
          )
          return {
            frame: h.frame,
            preset: h.preset,
            explosionsDrawn: h.explosionsDrawn,
            explosionCount: h.explosionCount,
            drawCalls: h.drawCalls,
            panel,
          }
        })
      await page.waitForTimeout(WARMUP * 1000)
      const gpu = await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter()
        const i = a?.info ?? {}
        return `${i.vendor ?? '?'} / ${i.architecture ?? '?'}`
      })
      // **フレームの間隔を記録する。**計器の FPS は 0.08 の指数平滑なので、1 回の
      // 長い引っかかり（最初の爆発で材質を組む待ち）は薄まって見える
      await page.evaluate(() => {
        const w = window
        w.__gaps = []
        let last = performance.now()
        const tick = (now) => {
          w.__gaps.push([now, now - last])
          last = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const fireAt = await page.evaluate(() => performance.now())
      await page.keyboard.down('Space')
      const samples = []
      let released = false
      for (let k = 0; k < TRACK * 10; k++) {
        await page.waitForTimeout(100)
        const s = await read()
        samples.push({ t: (k + 1) / 10, ...s })
        // 撃墜したら撃つのをやめる。曳光弾の費用を爆発の窓へ混ぜない
        if (!released && s.explosionCount > 0) {
          await page.keyboard.up('Space')
          released = true
        }
      }
      if (!released) await page.keyboard.up('Space')
      const killAt = samples.find((s) => s.explosionCount > 0)?.t ?? null
      const gaps = await page.evaluate(() => window.__gaps)
      // 撃ち始めてからの最長のフレームと、その時刻（撃ち始めからの秒）
      let worst = [0, 0]
      for (const [at, gap] of gaps) if (gap > worst[1]) worst = [(at - fireAt) / 1000, gap]
      const long = gaps.filter(([, gap]) => gap > 50).length
      // 爆発の窓は撃墜から 3.5 秒。前の窓は撃ち始める前の値（最初の 1 点）と比べず、
      // 撃墜の後 4.0〜TRACK 秒（爆発が消えたあと）を床にする
      const inWindow = samples.filter((s) => killAt !== null && s.t >= killAt + 0.3 && s.t < killAt + 3.3)
      const after = samples.filter((s) => killAt !== null && s.t >= killAt + 4.0)
      const row = {
        killAt,
        drawnMax: Math.max(...samples.map((s) => s.explosionsDrawn ?? 0)),
        gpuIn: mean(inWindow.map((s) => lead(s.panel['GPU 時間'])).filter((v) => v !== null)),
        gpuAfter: mean(after.map((s) => lead(s.panel['GPU 時間'])).filter((v) => v !== null)),
        cpuIn: mean(inWindow.map((s) => lead(s.panel['CPU 時間'])).filter((v) => v !== null)),
        cpuAfter: mean(after.map((s) => lead(s.panel['CPU 時間'])).filter((v) => v !== null)),
        drawsIn: mean(inWindow.map((s) => lead(s.panel['投入'])).filter((v) => v !== null)),
        drawsAfter: mean(after.map((s) => lead(s.panel['投入'])).filter((v) => v !== null)),
        fpsMin: Math.min(...inWindow.map((s) => lead(s.panel['FPS']) ?? Infinity)),
        preset: samples[samples.length - 1]?.preset,
        worstGap: worst[1],
        worstAt: worst[0],
        longFrames: long,
      }
      results[u].push(row)
      console.log(
        `[${round + 1}] ${url.split('?')[1]}\n` +
          `  GPU ${gpu}  品質 ${row.preset}  撃墜 ${row.killAt ?? '起きず'} 秒  描いた爆発 最大 ${row.drawnMax}\n` +
          `  爆発の窓: GPU ${fmt(row.gpuIn)} ms  CPU ${fmt(row.cpuIn)} ms  投入 ${fmt(row.drawsIn)}  最低 FPS ${row.fpsMin}\n` +
          `  消えた後: GPU ${fmt(row.gpuAfter)} ms  CPU ${fmt(row.cpuAfter)} ms  投入 ${fmt(row.drawsAfter)}\n` +
          `  最長のフレーム ${row.worstGap.toFixed(0)} ms（撃ち始めから ${row.worstAt.toFixed(2)} 秒）  50 ms を越えたフレーム ${row.longFrames}` +
          (errors.length > 0 ? `\n  例外 ${errors.length} 件: ${errors[0]}` : ''),
      )
      await page.close()
    }
  }
  console.log('\n=== 平均')
  for (let u = 0; u < urls.length; u++) {
    const rs = results[u]
    const avg = (key) => fmt(mean(rs.map((r) => r[key]).filter((v) => v !== null)))
    console.log(
      `  ${urls[u].split('?')[1]}\n` +
        `    爆発の窓 GPU ${avg('gpuIn')} ms  CPU ${avg('cpuIn')} ms  投入 ${avg('drawsIn')}` +
        `  / 消えた後 GPU ${avg('gpuAfter')} ms  CPU ${avg('cpuAfter')} ms  投入 ${avg('drawsAfter')}`,
    )
  }
} finally {
  await browser.close()
}
process.exit(0)
