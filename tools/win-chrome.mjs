// Windows 側の Chrome を実 GPU で起動し、WSL から CDP で掴む。
//
// **WSL2 から WebGPU は SwiftShader にしか乗らない**（`tools/gpu-probe.mjs`
// で実測。`/dev/dxg` と `libd3d12.so` はあるが vendor=google arch=swiftshader）。
// 実機でだけ出る欠陥（雲の追従、2026-09-13）を手元で追えないと、確認のたびに
// 人へ頼むことになる。
//
// WSL2 の localhost は Windows と共有されるので、Windows の Chrome を
// `--remote-debugging-port` で立てれば `connectOverCDP` で繋がる。
//
// 使い方:
//   node tools/win-chrome.mjs --check          GPU の素性だけ見る
//   node tools/win-chrome.mjs --url <URL>      開いて hook を読む
import { spawn } from 'node:child_process'
import { chromium } from '@playwright/test'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', 9222))
const CHROME = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
const URL_ARG = arg('--url', null)

/** Windows 側の Chrome を CDP つきで立てる。**実 GPU を使わせる** */
function launchWindowsChrome() {
  const args = [
    `--remote-debugging-port=${PORT}`,
    // **0.0.0.0 で待つ。**WSL から見える口にする
    '--remote-debugging-address=0.0.0.0',
    '--enable-unsafe-webgpu',
    '--no-first-run',
    '--no-default-browser-check',
    // 既定のプロファイルを掴むと既存の窓に吸われて CDP が立たない
    '--user-data-dir=C:\\Windows\\Temp\\dogfight-cdp',
    'about:blank',
  ]
  return spawn(CHROME, args, { detached: true, stdio: 'ignore' })
}

const child = launchWindowsChrome()

/**
 * Windows 側のホスト。
 *
 * **WSL2 は NAT なので `localhost` では届かない。**既定ゲートウェイが
 * Windows 側になる（`ip route` の default）
 */
import { execSync } from 'node:child_process'
function windowsHost() {
  try {
    return execSync("ip route | awk '/default/ {print $3; exit}'").toString().trim()
  } catch {
    return '127.0.0.1'
  }
}
const HOST = arg('--host', windowsHost())

/** CDP が立つまで待つ。**ホストは Windows 側** */
async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    for (const h of [HOST, '127.0.0.1']) {
      try {
        const r = await fetch(`http://${h}:${PORT}/json/version`)
        if (r.ok) return { ...(await r.json()), host: h }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

const version = await waitForCdp()
if (version === null) {
  console.log('CDP に繋がらない。Windows の Chrome が立っていないか、口が塞がれている')
  process.exit(1)
}
console.log(`CDP: ${version.Browser}（${version.host}:${PORT}）`)

const browser = await chromium.connectOverCDP(`http://${version.host}:${PORT}`)
try {
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())

  // **まず GPU の素性を見る。**SwiftShader なら手元と同じで意味がない
  await page.goto('https://example.com', { timeout: 60_000 })
  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return { ok: false, why: 'navigator.gpu が無い' }
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return { ok: false, why: 'requestAdapter が null' }
    const i = adapter.info ?? {}
    return {
      ok: true,
      vendor: i.vendor ?? '?',
      architecture: i.architecture ?? '?',
      device: i.device ?? '?',
      description: i.description ?? '?',
    }
  })
  console.log(
    gpu.ok
      ? `GPU: vendor=${gpu.vendor} arch=${gpu.architecture} device=${gpu.device} ${gpu.description}`
      : `GPU: 使えない（${gpu.why}）`,
  )
  if (gpu.ok && gpu.vendor === 'google') {
    console.log('**SwiftShader に乗っている。**実機の再現には使えない')
  }

  if (URL_ARG !== null) {
    await page.goto(URL_ARG, { timeout: 120_000 })
    await page.waitForFunction(() => (window.__dogfight?.frame ?? 0) > 0, undefined, {
      timeout: 120_000,
    })
    const hook = await page.evaluate(() => ({
      backend: window.__dogfight?.backend ?? '',
      frame: window.__dogfight?.frame ?? 0,
      cloudRenderCount: window.__dogfight?.cloudRenderCount ?? 0,
    }))
    console.log(
      `開いた: backend=${hook.backend} frame=${hook.frame} ` +
        `雲の焼き回数=${hook.cloudRenderCount}`,
    )
  }
} finally {
  await browser.close()
  try {
    process.kill(-child.pid)
  } catch {}
}
