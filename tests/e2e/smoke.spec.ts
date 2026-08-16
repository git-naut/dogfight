import { test, expect, type Page } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** src/render/capture.ts が window に置くテストフック。 */
interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
  atmosphereReady: boolean
  sunElevation: number
  preset: string
  hour: number
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

interface CaptureQuery {
  script?: string
  frame?: number
  hour?: number
  preset?: string
}

async function capture(page: Page, query: CaptureQuery = {}): Promise<TestHook> {
  const params = new URLSearchParams({ capture: '1' })
  params.set('script', query.script ?? 'level')
  params.set('frame', String(query.frame ?? 240))
  if (query.hour !== undefined) params.set('hour', String(query.hour))
  if (query.preset !== undefined) params.set('preset', query.preset)

  await page.goto(`/dogfight/?${params.toString()}`)
  await page.waitForSelector('body[data-capture-ready="1"]')
  const hook = await readHook(page)
  expect(hook, 'テストフックが見つからない').toBeDefined()
  return hook as TestHook
}

test.describe('起動', () => {
  test('WebGL2 が取れて大気を読み終え、コンソールエラーが出ない', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      // SwiftShader は ReadPixels の性能警告を出すが実害はない
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    const hook = await capture(page)

    expect(hook.captureReady).toBe(true)
    expect(hook.atmosphereReady).toBe(true)
    // SwiftShader でも WebGL2 は取れる。1 に落ちていたら描画品質の前提が崩れる
    expect(hook.webglVersion).toBe(2)
    expect(errors).toEqual([])
  })

  test('初期化に失敗していない', async ({ page }) => {
    await capture(page)
    const failed = await page.evaluate(() => document.body.dataset['initError'] === '1')
    expect(failed).toBe(false)
  })

  test('未知のスクリプト名とプリセット名は既定へ倒れる', async ({ page }) => {
    const hook = await capture(page, { script: 'nonexistent', preset: 'extreme', frame: 60 })
    expect(hook.script).toBe('level')
    expect(hook.preset).toBe('high')
  })

  test('プリセットを指定できる', async ({ page }) => {
    const hook = await capture(page, { preset: 'low', frame: 60 })
    expect(hook.preset).toBe('low')
  })
})

test.describe('決定論キャプチャ', () => {
  test('指定フレームで厳密に止まる', async ({ page }) => {
    const hook = await capture(page, { frame: 240 })
    expect(hook.frame).toBe(240)
    expect(hook.droppedSteps).toBe(0)
  })

  test('2 回読み込んでも飛行状態と太陽高度が一致する', async ({ page }) => {
    const first = await capture(page, { script: 'bank-left', frame: 300, hour: 16 })
    const second = await capture(page, { script: 'bank-left', frame: 300, hour: 16 })

    expect(second.frame).toBe(first.frame)
    expect(second.speed).toBe(first.speed)
    expect(second.bank).toBe(first.bank)
    expect(second.sunElevation).toBe(first.sunElevation)
  })

  test('frame を変えると描画が変わる', async ({ page }) => {
    await capture(page, { script: 'bank-left', frame: 0 })
    const atZero = await page.locator('#viewport').screenshot()

    await capture(page, { script: 'bank-left', frame: 300 })
    const at300 = await page.locator('#viewport').screenshot()

    expect(Buffer.compare(atZero, at300)).not.toBe(0)
  })
})

test.describe('大気散乱', () => {
  test('時刻を変えると太陽高度が変わる', async ({ page }) => {
    const noon = await capture(page, { frame: 60, hour: 12 })
    const afternoon = await capture(page, { frame: 60, hour: 16 })
    const dusk = await capture(page, { frame: 60, hour: 18.3 })

    // 南中が最も高く、夕方へ向かって下がる
    expect(noon.sunElevation).toBeGreaterThan(afternoon.sunElevation)
    expect(afternoon.sunElevation).toBeGreaterThan(dusk.sunElevation)

    // 既定の午後は斜光。30 度前後を狙っている
    expect(afternoon.sunElevation / DEG).toBeGreaterThan(25)
    expect(afternoon.sunElevation / DEG).toBeLessThan(40)
    // 夕景は地平線近く
    expect(dusk.sunElevation / DEG).toBeLessThan(10)
    expect(dusk.sunElevation / DEG).toBeGreaterThan(0)
  })

  test('時刻を変えると絵が変わる', async ({ page }) => {
    await capture(page, { frame: 60, hour: 12 })
    const noon = await page.locator('#viewport').screenshot()

    await capture(page, { frame: 60, hour: 18.3 })
    const dusk = await page.locator('#viewport').screenshot()

    expect(Buffer.compare(noon, dusk)).not.toBe(0)
  })

  test('LUT が 404 にならない', async ({ page }) => {
    const failed: string[] = []
    page.on('response', (res) => {
      if (res.url().includes('/atmosphere/') && !res.ok()) {
        failed.push(`${res.status()} ${res.url()}`)
      }
    })
    await capture(page, { frame: 60 })
    expect(failed).toEqual([])
  })
})

test.describe('飛行モデルがブラウザでも成立する', () => {
  test('level は 5 秒間 高度と速度を保つ', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 600 })

    expect(hook.crashed).toBe(false)
    expect(Math.abs(hook.altitude - 2000)).toBeLessThan(50)
    expect(Math.abs(hook.speed - 250)).toBeLessThan(10)
    expect(Math.abs(hook.bank)).toBeLessThan(1 * DEG)
  })

  test('bank-left は左へバンクする', async ({ page }) => {
    const hook = await capture(page, { script: 'bank-left', frame: 480 })
    expect(hook.bank).toBeLessThan(-30 * DEG)
    expect(hook.crashed).toBe(false)
  })

  test('pull-up は上昇する', async ({ page }) => {
    const hook = await capture(page, { script: 'pull-up', frame: 480 })
    expect(hook.altitude).toBeGreaterThan(1200)
    expect(hook.crashed).toBe(false)
  })

  test('low-pass は低空を保つ', async ({ page }) => {
    const hook = await capture(page, { script: 'low-pass', frame: 360 })
    expect(hook.altitude).toBeLessThan(400)
    expect(hook.crashed).toBe(false)
  })
})

test.describe('デバッグ表示', () => {
  test('?debug=1 で計器が出て数値が更新される', async ({ page }) => {
    await page.goto('/dogfight/?debug=1')
    const panel = page.locator('.debug-panel')
    await expect(panel).toBeVisible()

    const speedValue = panel.locator('.debug-row').first().locator('.debug-value')
    await expect(speedValue).not.toHaveText('-')
    await expect(speedValue).toContainText('m/s')
  })

  test('太陽高度と品質プリセットも出る', async ({ page }) => {
    await page.goto('/dogfight/?debug=1')
    const panel = page.locator('.debug-panel')
    await expect(panel).toContainText('太陽高度')
    await expect(panel).toContainText('品質')
    await expect(panel).toContainText('high')
  })

  test('既定では計器を出さない', async ({ page }) => {
    await page.goto('/dogfight/')
    await expect(page.locator('.debug-panel')).toHaveCount(0)
  })
})

test.describe('バンドルの中身', () => {
  test('React と R3F が成果物に混ざっていない', () => {
    // @takram/three-atmosphere は peer に React 一式を並べているが、
    // vanilla のエクスポートだけを使っているので成果物には入らないはず。
    // import 経路が変わって混入したらここで落ちる。
    const assets = join(process.cwd(), 'dist/assets')
    const bundles = readdirSync(assets).filter((f) => f.endsWith('.js'))
    expect(bundles.length).toBeGreaterThan(0)

    for (const file of bundles) {
      const source = readFileSync(join(assets, file), 'utf8')
      expect(source, `${file} に react が混入`).not.toMatch(/\breact\b/i)
      expect(source, `${file} に @react-three が混入`).not.toContain('@react-three')
    }
  })
})

test.describe('スクリーンショット回帰', () => {
  const scenes = [
    { name: 'level-afternoon', script: 'level', frame: 240, hour: 16 },
    { name: 'level-backlit', script: 'level', frame: 240, hour: 8 },
    { name: 'bank-left-dusk', script: 'bank-left', frame: 420, hour: 18.3 },
    { name: 'low-pass-afternoon', script: 'low-pass', frame: 240, hour: 16 },
  ] as const

  for (const scene of scenes) {
    test(`${scene.name} の絵が基準と一致する`, async ({ page }) => {
      await capture(page, scene)
      await expect(page.locator('#viewport')).toHaveScreenshot(`${scene.name}.png`)
    })
  }
})
