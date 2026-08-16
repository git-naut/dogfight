import { test, expect, type Page } from '@playwright/test'

/** src/render/capture.ts が window に置くテストフック。 */
interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
  speed: number
  altitude: number
  angleOfAttack: number
  bank: number
  crashed: boolean
  script: string
}

const DEG = Math.PI / 180

function readHook(page: Page): Promise<TestHook | undefined> {
  return page.evaluate(() => (window as unknown as { __dogfight?: TestHook }).__dogfight)
}

async function capture(page: Page, script: string, frame: number): Promise<TestHook> {
  await page.goto(`/dogfight/?capture=1&script=${script}&frame=${frame}`)
  await page.waitForSelector('body[data-capture-ready="1"]')
  const hook = await readHook(page)
  expect(hook, 'テストフックが見つからない').toBeDefined()
  return hook as TestHook
}

test.describe('起動', () => {
  test('WebGL2 が取れてコンソールエラーが出ない', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    const hook = await capture(page, 'level', 240)

    expect(hook.captureReady).toBe(true)
    // SwiftShader でも WebGL2 は取れる。1 に落ちていたら描画品質の前提が崩れる
    expect(hook.webglVersion).toBe(2)
    expect(errors).toEqual([])
  })

  test('未知のスクリプト名は level に倒れる', async ({ page }) => {
    const hook = await capture(page, 'nonexistent', 60)
    expect(hook.script).toBe('level')
  })
})

test.describe('決定論キャプチャ', () => {
  test('指定フレームで厳密に止まる', async ({ page }) => {
    const hook = await capture(page, 'level', 240)
    expect(hook.frame).toBe(240)
    expect(hook.droppedSteps).toBe(0)
  })

  test('2 回読み込んでも飛行状態が一致する', async ({ page }) => {
    const first = await capture(page, 'bank-left', 300)
    const second = await capture(page, 'bank-left', 300)

    expect(second.frame).toBe(first.frame)
    expect(second.speed).toBe(first.speed)
    expect(second.altitude).toBe(first.altitude)
    expect(second.bank).toBe(first.bank)
  })

  test('frame を変えると描画が変わる', async ({ page }) => {
    await capture(page, 'bank-left', 0)
    const atZero = await page.locator('#viewport').screenshot()

    await capture(page, 'bank-left', 300)
    const at300 = await page.locator('#viewport').screenshot()

    expect(Buffer.compare(atZero, at300)).not.toBe(0)
  })
})

test.describe('飛行モデルがブラウザでも成立する', () => {
  test('level は 5 秒間 高度と速度を保つ', async ({ page }) => {
    const hook = await capture(page, 'level', 600)

    expect(hook.crashed).toBe(false)
    expect(Math.abs(hook.altitude - 2000)).toBeLessThan(50)
    expect(Math.abs(hook.speed - 250)).toBeLessThan(10)
    expect(Math.abs(hook.bank)).toBeLessThan(1 * DEG)
  })

  test('bank-left は左へバンクする', async ({ page }) => {
    const hook = await capture(page, 'bank-left', 480)
    expect(hook.bank).toBeLessThan(-30 * DEG)
    expect(hook.crashed).toBe(false)
  })

  test('pull-up は上昇する', async ({ page }) => {
    const hook = await capture(page, 'pull-up', 480)
    expect(hook.altitude).toBeGreaterThan(1200)
    expect(hook.crashed).toBe(false)
  })

  test('low-pass は低空を保つ', async ({ page }) => {
    const hook = await capture(page, 'low-pass', 360)
    expect(hook.altitude).toBeLessThan(400)
    expect(hook.crashed).toBe(false)
  })
})

test.describe('デバッグ表示', () => {
  test('?debug=1 で計器が出て数値が更新される', async ({ page }) => {
    await page.goto('/dogfight/?debug=1')
    const panel = page.locator('.debug-panel')
    await expect(panel).toBeVisible()

    // 速度の行が「-」から実測値へ変わる
    const speedValue = panel.locator('.debug-row').first().locator('.debug-value')
    await expect(speedValue).not.toHaveText('-')
    await expect(speedValue).toContainText('m/s')
  })

  test('既定では計器を出さない', async ({ page }) => {
    await page.goto('/dogfight/')
    await expect(page.locator('.debug-panel')).toHaveCount(0)
  })
})

test.describe('スクリーンショット回帰', () => {
  const scenes = [
    { script: 'level', frame: 240 },
    { script: 'bank-left', frame: 420 },
    { script: 'pull-up', frame: 300 },
    { script: 'low-pass', frame: 240 },
  ] as const

  for (const scene of scenes) {
    test(`${scene.script} の絵が基準と一致する`, async ({ page }) => {
      await capture(page, scene.script, scene.frame)
      await expect(page.locator('#viewport')).toHaveScreenshot(
        `${scene.script}-f${scene.frame}.png`,
      )
    })
  }
})
