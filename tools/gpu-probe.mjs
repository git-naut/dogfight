// WSL2 から実 GPU の WebGPU を掴めるかを測る。
//
// **実機でしか出ない欠陥を手元で再現するための下調べ。**SwiftShader では
// 雲の追従が出ない（2026-09-13 の報告は実機の `node-webgpu`）。WSL2 は
// `/dev/dxg` と `libd3d12.so` を持つので、D3D12 経由で実 GPU に乗る見込みが
// ある。乗れば、あなたに確認を頼む往復が要らなくなる。
//
// 使い方: node tools/gpu-probe.mjs
import { chromium } from '@playwright/test'

/** 試す起動引数の組。上から順に、実 GPU に近いものから */
const CANDIDATES = [
  {
    name: 'D3D12（実 GPU を狙う）',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
  },
  {
    name: 'Vulkan（実 GPU を狙う）',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan'],
  },
  {
    name: 'ANGLE 既定',
    args: ['--enable-unsafe-webgpu', '--use-angle=default'],
  },
  {
    name: 'SwiftShader（いまの E2E と同じ）',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-vulkan-surface',
    ],
  },
]

for (const c of CANDIDATES) {
  let browser
  try {
    browser = await chromium.launch({ args: c.args })
    const page = await browser.newPage()
    // **`about:blank` では `navigator.gpu` が undefined になる。**保安
    // コンテキストでないため（`docs/lessons.md` に記録がある）
    await page.goto('https://example.com', { timeout: 30_000 })
    const info = await page.evaluate(async () => {
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
    if (info.ok) {
      console.log(
        `${c.name.padEnd(28)} vendor=${info.vendor} arch=${info.architecture} ` +
          `device=${info.device} desc=${info.description}`,
      )
    } else {
      console.log(`${c.name.padEnd(28)} 使えない（${info.why}）`)
    }
  } catch (error) {
    console.log(`${c.name.padEnd(28)} 起動できない（${String(error).slice(0, 80)}）`)
  } finally {
    await browser?.close()
  }
}

console.log(
  '\n**vendor が google なら SwiftShader（ソフトウェア）。**' +
    'nvidia / amd / intel / microsoft なら実 GPU に乗っている。',
)
