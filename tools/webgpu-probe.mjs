// この環境で WebGPU が使えるかを yes / no で答える。
//
// Phase 8 は基準画像を WebGPU で撮り直す。**CI で WebGPU が動かなければ
// E2E が丸ごと止まる**ので、着手の前提条件としてここで潰す。
//
// 出す値は 5 つ。
//
// - `navigator.gpu` があるか（保安コンテキストの判定込み）
// - `requestAdapter()` が null を返さないか
// - `requestDevice()` が通るか
// - `timestamp-query` が使えるか
// - 実際に 1 枚描いて、画素がシェーダの式と一致するか
//
// **`timestamp-query` を必ず見る。**無いと `trackTimestamp` が静かに false に
// なり、`resolveTimestampsAsync` が undefined を返す。これを知らずに
// 「CI では GPU 時間が 0」を不具合として追うと時間を溶かす。
//
// **adapter が取れることと描けることは別。**だから読み戻しまでやる。
//
// 使い方:
//   node tools/webgpu-probe.mjs [--json]
import { chromium } from '@playwright/test'
import { WEBGPU_ARGS } from '../tests/e2e/launch.mjs'

const WIDTH = 320
const HEIGHT = 200

const browser = await chromium.launch({ args: [...WEBGPU_ARGS] })
let result
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
  // **localhost 由来のページで測る。**`about:blank` は保安コンテキストでは
  // ないので `navigator.gpu` そのものが undefined になる
  await page.route('http://localhost/webgpu-probe', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }),
  )
  await page.goto('http://localhost/webgpu-probe')

  result = await page.evaluate(
    async ({ width, height }) => {
      const out = {
        secureContext: window.isSecureContext,
        hasGpu: typeof navigator.gpu !== 'undefined',
        adapter: null,
        device: false,
        timestampQuery: false,
        rendered: false,
        pixels: null,
        adapterMs: null,
        frameMs: null,
        error: null,
      }
      if (!out.hasGpu) return out
      try {
        const t0 = performance.now()
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) {
          out.error = 'requestAdapter() が null'
          return out
        }
        out.adapterMs = +(performance.now() - t0).toFixed(1)
        const info = adapter.info ?? {}
        out.adapter = {
          vendor: info.vendor ?? '',
          architecture: info.architecture ?? '',
          device: info.device ?? '',
          description: info.description ?? '',
        }
        out.timestampQuery = adapter.features.has('timestamp-query')

        const device = await adapter.requestDevice()
        out.device = true

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        document.body.appendChild(canvas)
        const ctx = canvas.getContext('webgpu')
        if (ctx === null) {
          out.error = "getContext('webgpu') が null"
          return out
        }
        const format = navigator.gpu.getPreferredCanvasFormat()
        ctx.configure({ device, format, alphaMode: 'opaque' })

        // 画面いっぱいの三角形を描き、画素が式どおりになるかを見る。
        // r = x/width、g = y/height、b = 0.75
        const code = [
          '@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{',
          '  var p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));',
          '  return vec4f(p[i],0.,1.); }',
          '@fragment fn fs(@builtin(position) c:vec4f)->@location(0) vec4f{',
          `  return vec4f(c.x/${width}., c.y/${height}., 0.75, 1.); }`,
        ].join('\n')
        const module = device.createShaderModule({ code })
        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        })
        const draw = async () => {
          const encoder = device.createCommandEncoder()
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: ctx.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          })
          pass.setPipeline(pipeline)
          pass.draw(3)
          pass.end()
          device.queue.submit([encoder.finish()])
          await device.queue.onSubmittedWorkDone()
        }
        await draw()
        const t1 = performance.now()
        const frames = 5
        for (let i = 0; i < frames; i++) await draw()
        out.frameMs = +((performance.now() - t1) / frames).toFixed(2)

        const readback = document.createElement('canvas')
        readback.width = width
        readback.height = height
        const g = readback.getContext('2d')
        g.drawImage(canvas, 0, 0)
        const data = g.getImageData(0, 0, width, height).data
        const at = (x, y) => {
          const i = (y * width + x) * 4
          return [data[i], data[i + 1], data[i + 2]]
        }
        out.pixels = { p10: at(10, 10), pMid: at(width >> 1, height >> 1) }
        // 期待値は式から出す。丸めで ±2 は許す
        const want = (x, y) => [
          Math.round((x / width) * 255),
          Math.round((y / height) * 255),
          Math.round(0.75 * 255),
        ]
        const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2)
        out.rendered = near(out.pixels.p10, want(10, 10)) && near(out.pixels.pMid, want(width >> 1, height >> 1))
      } catch (e) {
        out.error = String(e).slice(0, 300)
      }
      return out
    },
    { width: WIDTH, height: HEIGHT },
  )
} finally {
  await browser.close()
}

const ok = result.rendered === true
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result))
} else {
  const a = result.adapter
  console.log(`保安コンテキスト   ${result.secureContext ? 'yes' : 'no'}`)
  console.log(`navigator.gpu      ${result.hasGpu ? 'あり' : 'なし'}`)
  console.log(`adapter            ${a === null ? '取れない' : `${a.vendor} ${a.architecture} ${a.device} ${a.description}`.trim()}`)
  console.log(`device             ${result.device ? '取れる' : '取れない'}`)
  console.log(`timestamp-query    ${result.timestampQuery ? '使える' : '使えない'}`)
  console.log(`adapter の取得     ${result.adapterMs === null ? '—' : `${result.adapterMs} ms`}`)
  console.log(`1 フレーム         ${result.frameMs === null ? '—' : `${result.frameMs} ms`}`)
  console.log(`画素の一致         ${ok ? 'する' : 'しない'}`)
  if (result.pixels !== null) {
    console.log(`  (10,10)          ${result.pixels.p10.join(', ')}`)
    console.log(`  中央             ${result.pixels.pMid.join(', ')}`)
  }
  if (result.error !== null) console.log(`error              ${result.error}`)
  console.log('')
  console.log(ok ? 'WebGPU で描ける。' : '**WebGPU で描けない。**基準画像の撮り方を組み直す。')
}

// GitHub Actions の出力へ流す。後続のジョブが条件に使える
if (process.env.GITHUB_OUTPUT !== undefined) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_OUTPUT, `available=${ok}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `timestamp_query=${result.timestampQuery === true}\n`)
}

process.exit(ok ? 0 : 1)
