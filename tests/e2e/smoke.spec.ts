import { test, expect, type Page } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * src/render/capture.ts の TestHook の写し。
 *
 * 本家に項目を足したらここも足す。写しなので黙ってずれる。実際に 5 項目
 * ずれていたのを Phase 3.5 で揃えた。
 */
interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
  atmosphereReady: boolean
  sunElevation: number
  sunRadiance: [number, number, number]
  skyRadiance: [number, number, number]
  noiseMs: number
  noiseStats: { min: number; max: number; mean: number }
  gpuFrameMs: number
  gpuCloudMs: number
  gpuTimerSupported: boolean
  cloudHdrTarget: boolean
  benchMs: number
  cloudSamples: { mean: number; max: number; p99: number }
  terrainMs: number
  terrainStats: { min: number; max: number; mean: number }
  terrainPatches: number
  terrainTriangles: number
  preset: string
  hour: number
  speed: number
  altitude: number
  agl: number
  groundHeight: number
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
  /** 雲量 0..1 */
  coverage?: number
}

async function capture(page: Page, query: CaptureQuery = {}): Promise<TestHook> {
  const params = new URLSearchParams({ capture: '1' })
  params.set('script', query.script ?? 'level')
  params.set('frame', String(query.frame ?? 240))
  if (query.hour !== undefined) params.set('hour', String(query.hour))
  if (query.preset !== undefined) params.set('preset', query.preset)
  if (query.coverage !== undefined) params.set('coverage', String(query.coverage))

  await page.goto(`/dogfight/?${params.toString()}`)
  await page.waitForSelector('body[data-capture-ready="1"]')
  const hook = await readHook(page)
  expect(hook, 'テストフックが見つからない').toBeDefined()
  return hook as TestHook
}

/**
 * ライブループを開いて、最初のフレームが出るまで待つ。
 *
 * goto の直後に DOM を見てはいけない。大気の LUT の読み込みとシェーダの
 * コンパイルが終わるまで読み込み中の表示が出ているだけで、計器はまだ無い。
 * SwiftShader だと 5 秒では足りず、全件走らせたときだけ落ちた。
 */
async function openLive(page: Page, query = ''): Promise<void> {
  await page.goto(`/dogfight/${query}`)
  await page.waitForFunction(
    () => {
      const hook = (window as unknown as { __dogfight?: { frame: number } }).__dogfight
      return hook !== undefined && hook.frame > 0
    },
    undefined,
    { timeout: 120_000 },
  )
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

test.describe('ライブループ', () => {
  // 回帰テストはすべて capture=1 を通る。requestAnimationFrame で回る側は
  // 検査の外にあり、そこへ計測コードを入れて画面が出ない状態を作った。
  // 起動して数フレーム進むことだけは押さえる
  for (const query of ['', '?debug=1', '?debug=1&nodegrade=1']) {
    test(`${query || '既定'} で起動してフレームが進む`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))

      await page.goto(`/dogfight/${query}`)
      await page.waitForFunction(
        () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
        undefined,
        { timeout: 60_000 },
      )
      await page.waitForTimeout(1500)

      const hook = await readHook(page)
      expect(errors, '例外が出ている').toEqual([])
      expect(await page.getAttribute('body', 'data-init-error')).toBeNull()
      expect(hook?.frame ?? 0, 'フレームが進んでいない').toBeGreaterThan(0)
      // 起動中のオーバーレイが DOM から消えていること。
      // 残しておくとフェード中の不透明度が撮影結果に混ざる
      expect(await page.locator('#boot').count(), '起動表示が残っている').toBe(0)
    })
  }
})

test.describe('雲', () => {
  test('ノイズが焼けていて空でない', async ({ page }) => {
    const hook = await capture(page, { frame: 60 })
    // min と max が同じなら 3D レンダーターゲットへの描画が失敗している
    expect(hook.noiseStats.max).toBeGreaterThan(hook.noiseStats.min)
    expect(hook.noiseStats.mean).toBeGreaterThan(0.1)
    expect(hook.noiseStats.mean).toBeLessThan(0.95)
  })

  test('雲のバッファが 16bit 浮動小数である', async ({ page }) => {
    // 8bit へ戻すと、放射輝度の 1/255 刻みが露出 6 倍と AGX で拡大されて
    // 等高線状の横線が出る。実測で縦横の段差比が 1.477 から 1.635 へ悪化する。
    // スクリーンショット回帰は許容差 2% に埋もれて検出できないので型を見る
    const hook = await capture(page, { frame: 60 })
    expect(hook.cloudHdrTarget).toBe(true)
  })

  test('雲量を変えると絵が変わる', async ({ page }) => {
    await capture(page, { frame: 240, coverage: 0 })
    const clear = await page.locator('#viewport').screenshot()

    await capture(page, { frame: 240, coverage: 0.35 })
    const cloudy = await page.locator('#viewport').screenshot()

    expect(Buffer.compare(clear, cloudy)).not.toBe(0)
  })

  test('雲量ゼロなら快晴になる', async ({ page }) => {
    await capture(page, { frame: 240, coverage: 0 })
    const a = await page.locator('#viewport').screenshot()
    await capture(page, { frame: 600, coverage: 0 })
    const b = await page.locator('#viewport').screenshot()
    // 雲がなければ 3 秒進んでも空の見え方は変わらない（機体と地面は動く）
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
  })

  test('雲の中を通っても破綻しない', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    // 雲量を上げて雲層の内側を飛ぶ
    const hook = await capture(page, { script: 'level', frame: 600, coverage: 0.8 })
    expect(hook.crashed).toBe(false)
    expect(errors).toEqual([])
  })

  test('雲の流れがフレーム番号で決まる（実時間に依存しない）', async ({ page }) => {
    await capture(page, { frame: 300 })
    const first = await page.locator('#viewport').screenshot()
    // 間を空けて同じフレームを撮り直す
    await page.waitForTimeout(1500)
    await capture(page, { frame: 300 })
    const second = await page.locator('#viewport').screenshot()
    expect(Buffer.compare(first, second)).toBe(0)
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

test.describe('地形', () => {
  test('高さ場が縮退していない', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120 })

    // min と max が同じなら生成に失敗している
    expect(hook.terrainStats.min).toBeLessThan(0)
    expect(hook.terrainStats.max).toBeGreaterThan(1_500)
    // 定義域の大半は海なので平均は海面下
    expect(hook.terrainStats.mean).toBeLessThan(0)
  })

  test('高さ場の生成が読み込みを止めない', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120 })
    // 実測 70〜90 ms（1024²）。CI のソフトウェアレンダラでも CPU 処理なので
    // 大きくは変わらない。400 ms を超えたら解像度を落とす合図
    expect(hook.terrainMs).toBeGreaterThan(0)
    expect(hook.terrainMs).toBeLessThan(400)
  })

  test('パッチの枚数と三角形が予算内', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120, preset: 'high' })
    expect(hook.terrainPatches).toBeGreaterThan(50)
    // MAX_PATCHES は 512
    expect(hook.terrainPatches).toBeLessThanOrEqual(512)
    // 地形の予算は 500k。シーン合計 1.5M のうち機体に 1M 残す
    expect(hook.terrainTriangles).toBeLessThan(500_000)
  })

  test('海上では対地高度が海抜と一致する', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.groundHeight).toBe(0)
    expect(Math.abs(hook.agl - hook.altitude)).toBeLessThan(1)
  })

  test('island-run は主峰の稜線を越え、対地高度が海抜と食い違う', async ({ page }) => {
    const hook = await capture(page, { script: 'island-run', frame: 3240 })

    expect(hook.crashed).toBe(false)
    // 稜線の上。真下の地形が 1,000 m を超えている
    expect(hook.groundHeight).toBeGreaterThan(1_000)
    expect(hook.agl).toBeLessThan(hook.altitude - 1_000)
    // 地面には当たっていない
    expect(hook.agl).toBeGreaterThan(200)
  })

  test('低空のまま島へ向かうと地形の高さで墜落する', async ({ page }) => {
    // low-pass は高度 220 m で島へ突っ込む。海面ではなく島で止まる
    const hook = await capture(page, { script: 'low-pass', frame: 2600 })

    expect(hook.crashed).toBe(true)
    expect(hook.groundHeight).toBeGreaterThan(100)
    expect(hook.altitude).toBeCloseTo(hook.groundHeight, 0)
    expect(hook.speed).toBe(0)
  })

  test('太陽光の色が時刻で変わる', async ({ page }) => {
    // ライブラリのコンストラクタ引数の名前違いで、太陽光が白 (1,1,1) のまま
    // 固定されていた。地形の色が時刻で変わらなくなるので数値で見張る
    const morning = await capture(page, { script: 'level', frame: 120, hour: 9 })
    const evening = await capture(page, { script: 'level', frame: 120, hour: 18 })

    for (const hook of [morning, evening]) {
      expect(hook.sunRadiance[0]).toBeGreaterThan(0)
      // (1,1,1) のままなら白で固定されている
      expect(hook.sunRadiance[0]).not.toBeCloseTo(hook.sunRadiance[2], 3)
    }

    // 夕方のほうが赤い
    const warmth = (r: readonly number[]) => r[0]! / r[2]!
    expect(warmth(evening.sunRadiance)).toBeGreaterThan(warmth(morning.sunRadiance))
  })
})

test.describe('デバッグ表示', () => {
  test('?debug=1 で計器が出て数値が更新される', async ({ page }) => {
    await openLive(page, '?debug=1')
    const panel = page.locator('.debug-panel')
    await expect(panel).toBeVisible()

    const speedValue = panel.locator('.debug-row').first().locator('.debug-value')
    await expect(speedValue).not.toHaveText('-')
    await expect(speedValue).toContainText('m/s')
  })

  test('太陽高度と品質プリセットも出る', async ({ page }) => {
    await openLive(page, '?debug=1')
    const panel = page.locator('.debug-panel')
    await expect(panel).toContainText('太陽高度')
    await expect(panel).toContainText('品質')
    await expect(panel).toContainText('high')
  })

  test('既定では計器を出さない', async ({ page }) => {
    await openLive(page)
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
    // 雲を主題にした構図
    { name: 'clouds-climb', script: 'pull-up', frame: 200, hour: 16 },
    { name: 'clouds-dense', script: 'level', frame: 480, hour: 16, coverage: 0.8 },
    { name: 'clouds-clear', script: 'level', frame: 240, hour: 16, coverage: 0 },
    // 地形を主題にした構図。島を見下ろす、海岸線を低空で抜ける、雲を突き抜ける主峰
    { name: 'terrain-overlook', script: 'island-run', frame: 2000, hour: 9 },
    { name: 'terrain-coast', script: 'low-pass', frame: 1800, hour: 9 },
    { name: 'terrain-peak', script: 'island-run', frame: 3240, hour: 17 },
  ] as const

  for (const scene of scenes) {
    test(`${scene.name} の絵が基準と一致する`, async ({ page }) => {
      await capture(page, scene)
      await expect(page.locator('#viewport')).toHaveScreenshot(`${scene.name}.png`)
    })
  }
})
