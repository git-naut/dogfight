import { test, expect, type Page } from '@playwright/test'

/** src/render/capture.ts が window に置くテストフック。 */
interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
}

function readHook(page: Page): Promise<TestHook | undefined> {
  return page.evaluate(() => (window as unknown as { __dogfight?: TestHook }).__dogfight)
}

const CAPTURE_URL = '/dogfight/?capture=1&frame=240&seed=42'

test.describe('起動と決定論キャプチャ', () => {
  test('WebGL2 が取れて指定フレームまで進み、コンソールエラーが出ない', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(CAPTURE_URL)
    await page.waitForSelector('body[data-capture-ready="1"]')

    const hook = await readHook(page)
    expect(hook).toBeDefined()
    // capture=1 のときは実時間を一切使わないので、frame は指定値と厳密に一致する
    expect(hook?.frame).toBe(240)
    expect(hook?.seed).toBe(42)
    expect(hook?.captureReady).toBe(true)
    // SwiftShader でも WebGL2 は取れる。1 に落ちていたら描画品質の前提が崩れる
    expect(hook?.webglVersion).toBe(2)

    expect(errors).toEqual([])
  })

  test('同じクエリを 2 回読み込んでも同じフレームで止まる', async ({ page }) => {
    await page.goto(CAPTURE_URL)
    await page.waitForSelector('body[data-capture-ready="1"]')
    const first = await readHook(page)

    await page.reload()
    await page.waitForSelector('body[data-capture-ready="1"]')
    const second = await readHook(page)

    expect(second?.frame).toBe(first?.frame)
    expect(second?.seed).toBe(first?.seed)
  })

  test('frame を変えると描画が変わる', async ({ page }) => {
    await page.goto('/dogfight/?capture=1&frame=0&seed=42')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const atZero = await page.locator('#viewport').screenshot()

    await page.goto('/dogfight/?capture=1&frame=240&seed=42')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const at240 = await page.locator('#viewport').screenshot()

    // 同じ絵なら sync() がフレームを見ていないことになる
    expect(Buffer.compare(atZero, at240)).not.toBe(0)
  })

  test('キャプチャ画像が基準と一致する', async ({ page }) => {
    await page.goto(CAPTURE_URL)
    await page.waitForSelector('body[data-capture-ready="1"]')
    await expect(page.locator('#viewport')).toHaveScreenshot('capture-f240-s42.png')
  })
})
