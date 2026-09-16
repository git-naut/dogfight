import { test, expect } from '@playwright/test'
import type { TestHook } from './harness'

/**
 * WebGPU が無い機械で GLSL 経路へ落ちること。
 *
 * **既定が node 経路になった（2026-09-14）。**`createNodePipeline` は
 * WebGPU バックエンドでなければ `WebGPUUnavailable` を投げ、`createScene`
 * が受けて `createWebGLPipeline` へ落とす。**この退避路が死ぬと、WebGPU の
 * 無いブラウザで真っ黒の画面になる。**
 *
 * **WebGPU の起動引数を渡さない project で回す**（`chromium-node-gl`）。
 * 渡すと「WebGPU が無い」状況を作れず、検査が空振りする。段 20b で置いた
 * 分け方をそのまま使う。
 *
 * 判定はキャンバスを掴む前に置く必要がある。掴んでから落ちると戻れない
 * （1 つのキャンバスは 1 つのコンテキストしか持てず、同じキャンバスへ
 * `WebGLRenderer` を作り直すと `Cannot read properties of null
 * (reading 'precision')` で落ちる）。
 */
test.describe('WebGPU が無いときの退避路', () => {
  test('GLSL 経路へ落ちて絵が出る', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message.split('\n')[0] ?? e.message))

    await page.goto('/dogfight/?capture=1&frame=60&script=level')
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })

    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    expect(hook, 'テストフックが無い').toBeDefined()

    // **落ちた先が GLSL 経路であること。**`node-webgpu` なら退避していない
    // ので、この project の起動引数が効いていない（検査が空振り）
    expect(hook!.backend, 'WebGPU が無いのに node 経路が立っている').toBe('webgl')
    expect(hook!.webglVersion, 'WebGL2 が取れていない').toBe(2)

    // **絵が出ていること。**退避しても真っ黒では意味がない
    expect(hook!.drawnTriangles, '三角形が 1 つも投入されていない').toBeGreaterThan(1000)
    expect(hook!.atmosphereReady, '大気の LUT を読み終えていない').toBe(true)

    expect(errors, `例外が出た（${errors[0] ?? ''}）`).toEqual([])
  })
})
