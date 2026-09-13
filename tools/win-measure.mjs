// **実 GPU で測る。**Windows 側の node から Windows の Chrome を操作する。
//
// ## なぜこの形か
//
// WSL2 の WebGPU は SwiftShader にしか乗らない（`tools/gpu-probe.mjs` で
// 4 通り測った）。実機でだけ出る欠陥を手元で追えないと、確認のたびに人へ
// 頼むことになり、開発サイクルが往復に縛られる。
//
// 試して駄目だった道を記録しておく。
//
// | 手 | 結果 |
// |---|---|
// | WSL の Chromium に GPU を掴ませる | 4 通りとも vendor=google arch=swiftshader |
// | Windows の Chrome へ WSL から CDP | **Chrome が 9222 を 127.0.0.1 に固定する。**`--remote-debugging-address=0.0.0.0` は無視される |
// | Windows の Chrome のヘッドレス `--screenshot` | 撮れるが**待てない。**`--virtual-time-budget` は仮想時間だけ速回しするので、LUT の実時間の読み込みを待たずに撮る（4.6 秒で 600 秒ぶんを消費した） |
//
// 残ったのがこれ。**Windows 側の node で playwright-core を動かす。**
// CDP は同じマシンの中で閉じるので NAT を越えない。
//
// このファイルは WSL 側に置くが、実行は Windows 側の node で行う。
// `tools/win-run.sh` が橋渡しする。
import { chromium } from 'playwright-core'

const url = process.argv[2]
const outPath = process.argv[3] ?? 'C:\\Windows\\Temp\\dg-measure.png'
const origin = new URL(url).origin

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--disable-gpu-sandbox',
    // **`http://` は保安コンテキストではない。**WebGPU が生えない
    // （`docs/lessons.md` の「about:blank では navigator.gpu が undefined」と同じ形）
    `--unsafely-treat-insecure-origin-as-secure=${origin}`,
  ],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0] ?? e.message))

  await page.goto(url, { timeout: 180_000 })

  // GPU の素性を先に出す。**SwiftShader なら手元と同じで意味がない**
  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return 'なし'
    const a = await navigator.gpu.requestAdapter()
    if (!a) return 'adapter なし'
    const i = a.info ?? {}
    return `${i.vendor ?? '?'} / ${i.architecture ?? '?'}`
  })
  console.log(`GPU: ${gpu}`)

  // 診断が終わるまで待つ。`#clouddiag` が出たら完了
  await page.waitForSelector('#clouddiag', { timeout: 600_000 })
  const text = await page.locator('#clouddiag').textContent()
  console.log(text)
  await page.screenshot({ path: outPath })
  console.log(`絵: ${outPath}`)
  if (errors.length > 0) console.log(`例外 ${errors.length} 件: ${errors[0]}`)
} finally {
  await browser.close()
}
