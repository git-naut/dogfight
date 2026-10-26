import { test, expect } from '@playwright/test'

/**
 * WebGPU が無いブラウザでは、場面を立てずに理由を出して止まること。
 *
 * **段 S1 で GLSL 退避路を捨て、WebGPU を必須にした。**以前の検査は「GLSL
 * 経路へ落ちて絵が出る」を見ていた。いまは `createScene` がキャンバスを掴む
 * 前にアダプタを訊き、取れなければ `WebGPUUnavailable` を投げる。`main.ts` が
 * 受けて `#boot` を赤字にし、`body[data-init-error="1"]` を立てる。
 *
 * **WebGPU の起動引数を渡さない project で回す**（`chromium-no-webgpu`）。
 * 渡すと「WebGPU が無い」状況を作れず、検査が空振りする。
 */
test.describe('WebGPU が無いとき', () => {
  test('場面を立てずに、WebGPU が要ることを利用者に出して止まる', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0] ?? e.message))

    await page.goto('/dogfight/?capture=1&frame=60&script=level')
    await page.waitForSelector('body[data-init-error="1"]', { timeout: 120_000 })

    // **文言は利用者向け。**開発者向けの言葉（ADR の番号や経路の名前）を出さない
    const boot = page.locator('#boot')
    await expect(boot).toHaveClass(/is-error/)
    await expect(boot).toContainText('初期化に失敗しました')
    await expect(boot).toContainText('WebGPU に対応したブラウザ')
    await expect(boot).not.toContainText('ADR')

    // **止まっていること。**キャプチャの合図が立つなら、どこかで描けてしまっている
    const ready = await page.evaluate(() => document.body.dataset['captureReady'] ?? '')
    expect(ready, 'WebGPU が無いのに描き終えた').toBe('')

    // 例外は `main().catch` が受けるので、捕まらない例外は出ない
    expect(pageErrors, `捕まらない例外が出た（${pageErrors[0] ?? ''}）`).toEqual([])
  })
})
