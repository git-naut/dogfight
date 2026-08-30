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
  benchSweep: {
    label: string
    gpuMinMs: number | null
    gpuMedianMs: number | null
    cpuMinMs: number
    cpuMedianMs: number
    cpuMaxMs: number
    triangles: number
  }[]
  cloudSamples: { mean: number; max: number; p99: number }
  terrainMs: number
  terrainStats: { min: number; max: number; mean: number }
  terrainPatches: number
  terrainTriangles: number
  aircraftTriangles: number
  hudReady: boolean
  hudSpeedKt: number
  hudAltitudeFt: number
  hudHeadingDeg: number
  hudFlightPathOnScreen: boolean
  hudGunReticleOnScreen: boolean
  targetCount: number
  targetInstances: number
  targetsAlive: number
  enemyCount: number
  enemyInstances: number
  enemiesAlive: number
  enemyTriangles: number
  enemySurfaces: number
  enemyAiStates: string
  enemyClearance: number
  enemyIntegrityRatio: number
  enemySmoke: number
  enemyDamaged: number
  enemyRoundsFired: number
  enemyMissilesFired: number
  incomingMissiles: number
  missileWarning: boolean
  missileBearing: number
  missileTimeToImpact: number
  flaresLeft: number
  controlMode: string
  volume: number
  audioReady: boolean
  programs: number
  compileMs: number
  gearDown: boolean
  audioProbe: Record<string, { rms: number; peak: number }> | null
  missionOutcome: string
  missionRemaining: number
  flaresBurning: number
  playerTaken: number
  playerIntegrity: number
  playerLosses: number
  bulletsInFlight: number
  tracersDrawn: number
  roundsFired: number
  hits: number
  kills: number
  rounds: number
  lockState: string
  lockRange: number
  closingSpeed: number
  lockAngleDeg: number
  lockProgress: number
  hudLockBoxOnScreen: boolean
  missilesInFlight: number
  missilesDrawn: number
  missilesFired: number
  missilesLeft: number
  explosionsAlive: number
  explosionsDrawn: number
  explosionCount: number
  dlzMax: number
  dlzNe: number
  dlzMin: number
  hudDlzBarShown: boolean
  preset: string
  hour: number
  speed: number
  altitude: number
  agl: number
  groundHeight: number
  elevator: number
  aileron: number
  rudder: number
  aircraftSurfaces: number
  environmentReady: boolean
  aircraftShadowReady: boolean
  drawCalls: number
  drawnTriangles: number
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
  /**
   * 雲量 0..1。
   *
   * **省略すると 0（快晴）になる。**本番の既定は 0.3 だが、E2E では雲を
   * 主題にするテストだけが払えばよい費用。雲のマーチは 1 枚あたり実測
   * 3.9 秒（雲なし 4.5 秒に対して雲あり 8.4 秒）で、160 回のキャプチャに
   * 掛かると待ち時間を倍にする。
   *
   * 雲そのものを見張るのは `雲` の describe と基準画像 36 枚のうち
   * `coverage: 0.3` を明示した 15 枚。
   */
  coverage?: number
  /** 標的機を描くか。切ると差分で標的の寄与を測れる */
  targets?: boolean
  /** 敵機を描くか。切ると差分で敵の寄与を測れる */
  enemies?: boolean
  /**
   * 自機を出すか。既定は出す。
   *
   * 追従カメラは自機の後方にあるので、被写体が自機より前にあると隠れる。
   * 空母の甲板がそうだった
   */
  aircraft?: boolean
  /** ダメージの煙を描くか。切ると差分で寄与を測れる */
  damageSmoke?: boolean
  /** フレアを描くか。切ると差分で寄与を測れる */
  flares?: boolean
  /** HUD を出すか。キャプチャの既定はオフ */
  hud?: boolean
  /** 曳光弾を描くか。切ると差分で寄与を測れる */
  tracers?: boolean
  /** ミサイルの煙を描くか。切ると差分で寄与を測れる */
  smoke?: boolean
  /** 爆発を描くか。切ると差分で寄与を測れる */
  explosions?: boolean
}

async function capture(page: Page, query: CaptureQuery = {}): Promise<TestHook> {
  const params = new URLSearchParams({ capture: '1' })
  params.set('script', query.script ?? 'level')
  params.set('frame', String(query.frame ?? 240))
  if (query.hour !== undefined) params.set('hour', String(query.hour))
  if (query.preset !== undefined) params.set('preset', query.preset)
  // **既定は快晴。**理由は `CaptureQuery.coverage` の注記
  params.set('coverage', String(query.coverage ?? 0))
  if (query.targets === false) params.set('targets', '0')
  if (query.enemies === false) params.set('enemies', '0')
  if (query.aircraft === false) params.set('aircraft', '0')
  if (query.damageSmoke === false) params.set('dmgsmoke', '0')
  if (query.flares === false) params.set('flares', '0')
  if (query.hud !== undefined) params.set('hud', query.hud ? '1' : '0')
  if (query.tracers === false) params.set('tracers', '0')
  if (query.smoke === false) params.set('smoke', '0')
  if (query.explosions === false) params.set('explosions', '0')

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
  // **タイトルは出さない。**`#title` は `inset: 0` で全面を覆うので、ライブの
  // 検査対象（HUD、リザルト、デバッグ計器）がその下に隠れる。`toBeVisible()`
  // は被覆を見ないので通ってしまい、検査が意味を失う。
  // タイトル自体は「タイトル画面」の describe で検査する
  // **シェーダの事前コンパイルも省く。**4 段ぶんは SwiftShader で 6.6 秒
  // かかり、並列に走らせると起動待ちが 120 秒を超えて落ちた（実測。E2E
  // 全体も 11.8 分から 17.2 分へ延びた）。事前コンパイル自体は専用の
  // describe が見ている
  const sep = query === '' ? '?' : '&'
  await page.goto(`/dogfight/${query}${sep}title=0&precompile=0`)
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

      await page.goto(`/dogfight/${query}${query === '' ? '?' : '&'}precompile=0`)
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
    // **雲量を明示する。**既定は快晴なので、省くと雲のない絵を 2 枚
    // 比べることになり、何も見張らないまま通る
    await capture(page, { frame: 300, coverage: 0.3 })
    const first = await page.locator('#viewport').screenshot()
    // 間を空けて同じフレームを撮り直す
    await page.waitForTimeout(1500)
    await capture(page, { frame: 300, coverage: 0.3 })
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
    // 大きくは変わらない。
    //
    // **これは実時間の検査なので並列実行の取り合いを拾う。**E2E を並列化した
    // あと、4 ワーカーで 575.7 ms が出て 400 ms の上限に当たった。生成そのものは
    // 速くなっても遅くなってもいない。上限を 1500 ms へ広げる。
    //
    // ここで見たいのは「読み込みを塞ぐほど遅くないこと」だけで、予算の
    // 締め上げではない。解像度を上げる判断をするときは、並列を切って
    // （`--workers=1`）測り直すこと。
    expect(hook.terrainMs).toBeGreaterThan(0)
    expect(hook.terrainMs).toBeLessThan(1500)
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

test.describe('機体', () => {
  test('モデルが読み込めて三角形数が予算内', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120 })

    // 原本は 18,634 三角形。変換で増減していないこと
    expect(hook.aircraftTriangles).toBe(18_634)
    // 自機の予算。手続き生成をやめて実モデルにしたので実測値で固定する
    expect(hook.aircraftTriangles).toBeLessThan(25_000)
  })

  test('影マップと環境反射が焼けている', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120, preset: 'high' })
    expect(hook.aircraftShadowReady).toBe(true)
    expect(hook.environmentReady).toBe(true)
  })

  test('low では影も環境反射も切れている', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120, preset: 'low' })
    expect(hook.aircraftShadowReady).toBe(false)
    expect(hook.environmentReady).toBe(false)
  })

  test('舵面が 6 枚とも動かせる', async ({ page }) => {
    const hook = await capture(page, { script: 'bank-left', frame: 30 })
    expect(hook.aircraftSurfaces).toBe(6)
    // 左ロールの指令が入っている
    expect(hook.aileron).toBeLessThan(-0.5)
  })

  test('高 G で翼端渦が出る条件になる', async ({ page }) => {
    // 翼端渦は荷重倍数 3.5 から出る。pull-up は 6.7 G まで行く
    const hook = await capture(page, { script: 'pull-up', frame: 430 })
    expect(hook.crashed).toBe(false)
    // 軌跡の履歴は sim が持つ。描画側に置くとキャプチャモードで出ない
    expect(hook.aircraftTriangles).toBe(18_634)
  })

  test('描いた三角形が予算の内側', async ({ page }) => {
    // 影のパスで機体をもう一度描くので、機体は 2 回ぶん乗る
    const hook = await capture(page, { script: 'level', frame: 120, preset: 'high' })
    expect(hook.drawnTriangles).toBeGreaterThan(hook.terrainTriangles)
    expect(hook.drawnTriangles).toBeLessThan(1_500_000)
    expect(hook.drawCalls).toBeGreaterThan(0)
  })

  test('地形と機体の合計がシーン予算 1.5M の内側', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 120, preset: 'ultra' })
    expect(hook.terrainTriangles + hook.aircraftTriangles).toBeLessThan(1_500_000)
  })
})

test.describe('HUD', () => {
  test('キャプチャの既定では出さない', async ({ page }) => {
    // HUD は画面の広い範囲に線を引く。全カットに入れると、ピッチラダーの
    // 刻みを 1 度動かすだけで基準画像が全部差分を出す
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.hudReady).toBe(false)
    expect(await page.locator('canvas.hud-canvas').count()).toBe(0)
  })

  test('?hud=1 で出る', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240, hud: true })
    expect(hook.hudReady).toBe(true)
    expect(await page.locator('canvas.hud-canvas').count()).toBe(1)
  })

  test('ライブループでは既定で出る', async ({ page }) => {
    await openLive(page)
    expect(await page.locator('canvas.hud-canvas').count()).toBe(1)
    const hook = await readHook(page)
    expect(hook?.hudReady).toBe(true)
  })

  test('?hud=0 でライブループからも消せる', async ({ page }) => {
    await openLive(page, '?hud=0')
    expect(await page.locator('canvas.hud-canvas').count()).toBe(0)
  })

  test('単位の変換が表示層だけで起きている', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240, hud: true })
    // sim は m/s と m のまま。HUD だけが kt と ft へ写す
    expect(hook.hudSpeedKt).toBeCloseTo(hook.speed * (3600 / 1852), 6)
    expect(hook.hudAltitudeFt).toBeCloseTo(hook.altitude / 0.3048, 6)
  })

  test('方位が 0..360 に収まる', async ({ page }) => {
    for (const script of ['level', 'bank-left', 'turn-in']) {
      const hook = await capture(page, { script, frame: 600, hud: true })
      expect(hook.hudHeadingDeg, script).toBeGreaterThanOrEqual(0)
      expect(hook.hudHeadingDeg, script).toBeLessThan(360)
    }
  })

  test('水平飛行ではフライトパスマーカーが画面に入る', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240, hud: true })
    expect(hook.hudFlightPathOnScreen).toBe(true)
  })

  test('HUD の canvas が実解像度でできている。キャプチャは DPR 1', async ({ page }) => {
    await capture(page, { script: 'level', frame: 240, hud: true })
    const size = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.hud-canvas')
      return c === null ? null : { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }
    })
    expect(size).not.toBeNull()
    // 基準画像を機械に依らせないため、キャプチャでは DPR を 1 に固定する
    expect(size!.w).toBe(size!.cw)
    expect(size!.h).toBe(size!.ch)
  })

  test('同じフレームを 2 回撮ると HUD の値も一致する', async ({ page }) => {
    const a = await capture(page, { script: 'bank-left', frame: 420, hud: true })
    const b = await capture(page, { script: 'bank-left', frame: 420, hud: true })
    expect(a.hudSpeedKt).toBe(b.hudSpeedKt)
    expect(a.hudAltitudeFt).toBe(b.hudAltitudeFt)
    expect(a.hudHeadingDeg).toBe(b.hudHeadingDeg)
  })
})

test.describe('標的機', () => {
  /**
   * **標的を見張っているのはここの数値で、基準画像ではない。**
   *
   * 追従カメラの垂直画角は速度 250 m/s で 66.4 度あり、190 m の機体は実測で
   * 28 x 10 画素（差分 124 画素）にしかならない。`maxDiffPixelRatio` は 0.005、
   * 1280 x 720 なら 4,608 画素なので、**標的が丸ごと消えてもスクリーンショット
   * 回帰は落ちない。**基準画像は人が見るためのもので、退行の検出は
   * ドローコールと三角形数で行う。
   */
  test('標的つきの台本で sim と描画の数が一致する', async ({ page }) => {
    const hook = await capture(page, { script: 'target-ahead', frame: 240 })
    expect(hook.targetCount, 'sim に標的がいない').toBe(1)
    // 描画は必要になった時点で複製を作る。sim の数と食い違えば出ていない
    expect(hook.targetInstances, '複製が作られていない').toBe(1)
  })

  test('標的のない台本では 0 のまま', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.targetCount).toBe(0)
    expect(hook.targetInstances).toBe(0)
  })

  test('標的を切るとドローコールと三角形が減る', async ({ page }) => {
    const on = await capture(page, { script: 'target-ahead', frame: 240 })
    const off = await capture(page, { script: 'target-ahead', frame: 240, targets: false })

    expect(off.drawCalls, 'ドローコールが減っていない').toBeLessThan(on.drawCalls)
    expect(
      on.drawnTriangles - off.drawnTriangles,
      '標的 1 機ぶんの三角形が乗っていない',
    ).toBeGreaterThan(15_000)
  })

  test('標的は glb を読み直さず複製で増える', async ({ page }) => {
    // 読み直していれば三角形の総数が 2 機ぶんになる一方、機体 1 機ぶんの
    // 三角形数は変わらない。ここは「1 機ぶんの数」が増えていないことを見る
    const withTarget = await capture(page, { script: 'target-ahead', frame: 240 })
    const alone = await capture(page, { script: 'level', frame: 240 })
    expect(withTarget.aircraftTriangles).toBe(alone.aircraftTriangles)
  })

  test('標的を足しても三角形がシーン予算 1.5M の内側', async ({ page }) => {
    const hook = await capture(page, { script: 'target-ahead', frame: 240 })
    expect(hook.drawnTriangles).toBeLessThan(1_500_000)
  })

  test('target-turn の標的は右へバンクして回る', async ({ page }) => {
    // 絵ではなく数値で。標的の姿勢は TestHook に出していないので、
    // 標的が画面から抜けていく（＝視線が速く回る）ことを画素で見る
    const early = await capture(page, { script: 'target-turn', frame: 120 })
    expect(early.targetCount).toBe(1)
  })
})

test.describe('敵機', () => {
  test('台本に書いた数だけ出て、複製が作られる', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-ahead', frame: 240 })
    expect(hook.enemyCount).toBe(1)
    expect(hook.enemyInstances).toBe(1)
    expect(hook.enemiesAlive).toBe(1)
  })

  test('台本に敵がなければ 1 機も出ない', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.enemyCount).toBe(0)
    expect(hook.enemyInstances).toBe(0)
  })

  test('F-16 の舵面 5 枚を拾える', async ({ page }) => {
    // ラダーが 1 枚しかない機体なので 6 ではなく 5。**枚数が変わったら、
    // 舵面のノードを 1 つ取りこぼしている**
    const hook = await capture(page, { script: 'enemy-ahead', frame: 240 })
    expect(hook.enemySurfaces).toBe(5)
  })

  test('原本の三角形数がそのまま乗っている', async ({ page }) => {
    // 18,042。降着装置と stowed を隠しても、モデルが持つ総数は変わらない
    const hook = await capture(page, { script: 'enemy-ahead', frame: 240 })
    expect(hook.enemyTriangles).toBe(18_042)
  })

  test('敵を切ると三角形が減る', async ({ page }) => {
    const on = await capture(page, { script: 'enemy-formation', frame: 240 })
    const off = await capture(page, {
      script: 'enemy-formation',
      frame: 240,
      enemies: false,
    })

    expect(off.drawCalls, 'ドローコールが減っていない').toBeLessThan(on.drawCalls)
    // 空中で描くのは 15,554（総数 18,042 から降着 2,093 と stowed 395 を引く）
    expect(
      on.drawnTriangles - off.drawnTriangles,
      '敵 1 機ぶんの三角形が乗っていない',
    ).toBeGreaterThan(15_000)
  })

  test('敵は自機の glb を読み直さない', async ({ page }) => {
    // 自機のモデルと敵のモデルは別ファイル。混ざっていれば
    // aircraftTriangles が敵の数に引きずられる
    const withEnemy = await capture(page, { script: 'enemy-ahead', frame: 240 })
    const alone = await capture(page, { script: 'level', frame: 240 })
    expect(withEnemy.aircraftTriangles).toBe(alone.aircraftTriangles)
    expect(withEnemy.enemyTriangles).not.toBe(withEnemy.aircraftTriangles)
  })

  test('敵を足しても三角形がシーン予算 1.5M の内側', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-formation', frame: 240 })
    expect(hook.drawnTriangles).toBeLessThan(1_500_000)
  })

  test('敵はシーカーに捉えられる', async ({ page }) => {
    // Combatant を切った甲斐がここに出る。Target ではないものを
    // ロックの列に並べられている
    const hook = await capture(page, { script: 'enemy-ahead', frame: 240 })
    expect(hook.lockState).toBe('locked')
    expect(hook.lockRange).toBeGreaterThan(100)
    expect(hook.lockRange).toBeLessThan(250)
  })

  test('30 秒回しても落ちない', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-ahead', frame: 3600 })
    expect(hook.enemiesAlive).toBe(1)
  })
})

test.describe('敵 AI', () => {
  test('相手が見えているあいだは追尾の状態', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-pursue', frame: 2400 })
    expect(hook.enemyAiStates).toBe('pursue')
    expect(hook.enemiesAlive).toBe(1)
  })

  test('追尾していると距離が詰まる', async ({ page }) => {
    // 自機のロックで距離を測る。敵が後方なのでシーカーには入らないので、
    // 前方の地形との余裕ではなく生存と状態で見る。距離は sim の単体テストで
    // 測ってある（3,000 m から 42.1 秒で 0 m）
    const early = await capture(page, { script: 'enemy-pursue', frame: 600 })
    const late = await capture(page, { script: 'enemy-pursue', frame: 4200 })
    expect(early.enemyAiStates).toBe('pursue')
    expect(late.enemiesAlive).toBe(1)
  })

  test('低空・低速の敵は立て直しへ入る', async ({ page }) => {
    // 対地 300 m を 140 m/s。下限（水平飛行で 400 m）と速度の下限（150 m/s）
    // の両方を割っている
    const hook = await capture(page, { script: 'enemy-recover', frame: 60 })
    expect(hook.enemyAiStates).toBe('recover')
    expect(hook.enemyClearance).toBeLessThan(400)
  })

  test('立て直しで高度と速度を戻し、追尾へ復帰する', async ({ page }) => {
    // 20 秒
    const hook = await capture(page, { script: 'enemy-recover', frame: 2400 })
    expect(hook.enemiesAlive).toBe(1)
    expect(hook.enemyAiStates).toBe('pursue')
    // 前方の余裕が立て直しから抜ける閾値（1,200 m）を超えている
    expect(hook.enemyClearance).toBeGreaterThan(1200)
  })

  test('機銃の射程まで詰めたら撃ってくる', async ({ page }) => {
    // 20 秒。実測で 12 秒あたりから撃ち始める
    const hook = await capture(page, { script: 'enemy-attack', frame: 2400 })
    expect(hook.enemyAiStates).toBe('attack')
    expect(hook.enemyRoundsFired).toBeGreaterThan(0)
    expect(hook.tracersDrawn).toBeGreaterThan(0)
  })

  test('撃たれると耐久が減る', async ({ page }) => {
    const early = await capture(page, { script: 'enemy-attack', frame: 1200 })
    const late = await capture(page, { script: 'enemy-attack', frame: 2700 })
    expect(early.playerTaken).toBe(0)
    expect(late.playerTaken).toBeGreaterThan(0)
    expect(late.playerIntegrity).toBeLessThan(early.playerIntegrity)
  })

  test('直進していると撃墜される', async ({ page }) => {
    // 40 秒。実測で 33.9 秒に耐久 60 を削り切られる
    const hook = await capture(page, { script: 'enemy-attack', frame: 4800 })
    expect(hook.playerLosses).toBe(1)
    expect(hook.playerIntegrity).toBeLessThanOrEqual(0)
    // 撃墜の火球が出る
    expect(hook.explosionCount).toBeGreaterThan(0)
  })

  test('射程の外では撃ってこない', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-pursue', frame: 600 })
    expect(hook.enemyRoundsFired).toBe(0)
    expect(hook.playerTaken).toBe(0)
  })

  test('後ろを取ると回避に入る', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-evade', frame: 60 })
    expect(hook.enemyAiStates).toBe('evade')
  })

  /**
   * 回避でロックが外れる。
   *
   * シーカーの追従限界は機軸から 40 度（`lock.ts`）。ブレイクターンで
   * 視野の外へ出れば掴めなくなる。**振り切れたことがこの数字で分かる。**
   * 距離では見ない。回避のあいだ距離はいったん詰まる（相手が横へ抜ける）
   */
  test('回避でロックが外れる', async ({ page }) => {
    const early = await capture(page, { script: 'enemy-evade', frame: 60 })
    const late = await capture(page, { script: 'enemy-evade', frame: 1200 })
    expect(early.lockState).not.toBe('none')
    expect(early.lockRange).toBeGreaterThan(0)
    expect(late.lockState).toBe('none')
    expect(late.lockRange).toBe(0)
  })

  test('1 対 1 を 60 秒回しても敵が自滅しない', async ({ page }) => {
    const hook = await capture(page, { script: 'dogfight-1v1', frame: 7200 })
    // 敵が墜落していない（撃墜されていれば kills が立つ）
    expect(hook.enemiesAlive + hook.kills).toBe(1)
  })

  test('傷つくと煙を引く', async ({ page }) => {
    const hook = await capture(page, { script: 'damage-smoke', frame: 240 })
    // 耐久 12 / 60 = 2 割。煙の濃さは (0.6 − 0.2) / 0.6 = 0.667
    expect(hook.enemyIntegrityRatio).toBeCloseTo(0.2, 6)
    expect(hook.enemySmoke).toBeCloseTo(0.667, 2)
  })

  test('無傷なら煙が出ない', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-ahead', frame: 240 })
    expect(hook.enemyIntegrityRatio).toBe(1)
    expect(hook.enemySmoke).toBe(0)
  })

  test('煙を切るとドローコールが減る', async ({ page }) => {
    const on = await capture(page, { script: 'damage-smoke', frame: 240 })
    const off = await capture(page, { script: 'damage-smoke', frame: 240, damageSmoke: false })
    expect(off.drawCalls).toBeLessThan(on.drawCalls)
  })

  test('傷ついている敵の数を数える', async ({ page }) => {
    const damaged = await capture(page, { script: 'damage-smoke', frame: 240 })
    expect(damaged.enemyDamaged).toBe(1)
    const healthy = await capture(page, { script: 'enemy-eight', frame: 240 })
    expect(healthy.enemyCount).toBe(8)
    expect(healthy.enemyDamaged).toBe(0)
  })

  test('1 対 1 を 90 秒回しても敵が地面に落ちない', async ({ page }) => {
    // 撃墜は起きうる。墜落していないことを見る
    const hook = await capture(page, { script: 'dogfight-1v1', frame: 10800 })
    expect(hook.enemiesAlive + hook.kills).toBe(1)
  })

  /**
   * すれ違ったあとの煙が描かれる。
   *
   * **リボンは新しい端がカメラの後ろにあると全部消えていた。**翼端渦と
   * ミサイルの煙は自機から出るので、この経路を踏まない。敵が置いていった煙は
   * すれ違ったあとカメラの後ろから前へ伸びるので踏む。
   *
   * 絵の見張りは基準画像 `damage-smoke-near`。ここではドローコールで見る。
   * 実測で煙のリボンが 16 本増える（129 → 145）
   */
  test('すれ違ったあとも煙のリボンが投入される', async ({ page }) => {
    const on = await capture(page, {
      script: 'damage-smoke-near',
      frame: 720,
      coverage: 0,
    })
    expect(on.enemyIntegrityRatio).toBeCloseTo(0.2, 6)
    expect(on.enemySmoke).toBeGreaterThan(0)
    const off = await capture(page, {
      script: 'damage-smoke-near',
      frame: 720,
      coverage: 0,
      damageSmoke: false,
    })
    expect(on.drawCalls - off.drawCalls).toBe(16)
  })

  test('敵 8 機でも 30 秒落ちない', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-eight', frame: 3600 })
    expect(hook.enemyCount).toBe(8)
    expect(hook.enemiesAlive).toBe(8)
    // 8 機ぶんの状態が並ぶ
    expect(hook.enemyAiStates.split(',')).toHaveLength(8)
  })
})

test.describe('機銃', () => {
  test('gun-pass で撃って当てて落とす', async ({ page }) => {
    const hook = await capture(page, { script: 'gun-pass', frame: 120 })
    // 1 秒で 100 発。発射速度 6,000 発/分 が 120Hz で 120 発に化けていないこと
    expect(hook.roundsFired).toBe(100)
    // 耐久 60 なので、落とすまでに 60 発当てる
    expect(hook.hits).toBe(60)
    expect(hook.kills).toBe(1)
    expect(hook.targetsAlive).toBe(0)
  })

  test('撃たなければ 1 発も出ない', async ({ page }) => {
    const hook = await capture(page, { script: 'target-ahead', frame: 240 })
    expect(hook.roundsFired).toBe(0)
    expect(hook.bulletsInFlight).toBe(0)
    expect(hook.tracersDrawn).toBe(0)
    expect(hook.targetsAlive).toBe(1)
  })

  test('残弾が減る', async ({ page }) => {
    // 1 秒（120 フレーム）撃って 100 発減る。**携行弾は 1,800 発**
    // （`MAGAZINE`。公表値 578 発から Phase 7 で増やした）。この写しは
    // sim を import しないので、値を変えたらここも直す
    const hook = await capture(page, { script: 'gun-pass', frame: 120 })
    expect(hook.rounds).toBe(1800 - 100)
  })

  test('曳光弾は 5 発に 1 発', async ({ page }) => {
    // f120 では撃墜して撃ち止むので、まだ撃っている f90 で見る。
    // **飛行中の弾は 34 発しかない。**300 m の的に当て続けているので、
    // 撃った 90 発のうち 42 発が命中して消えている（当たった弾は貫通しない）
    const hook = await capture(page, { script: 'gun-pass', frame: 90 })
    expect(hook.bulletsInFlight).toBeGreaterThan(25)
    expect(hook.hits).toBeGreaterThan(30)
    // 5 発に 1 発。画面外へ出たぶんは描かないので上限側だけ厳しく見る
    expect(hook.tracersDrawn).toBeLessThanOrEqual(Math.ceil(hook.bulletsInFlight / 5))
    expect(hook.tracersDrawn).toBeGreaterThan(3)
  })

  test('曳光弾を切ると描画が減る', async ({ page }) => {
    const on = await capture(page, { script: 'gun-pass', frame: 60 })
    const off = await capture(page, { script: 'gun-pass', frame: 60, tracers: false })
    expect(on.drawCalls).toBeGreaterThan(off.drawCalls)
    expect(on.drawnTriangles).toBeGreaterThan(off.drawnTriangles)
  })

  test('落ちた標的は描かない', async ({ page }) => {
    const before = await capture(page, { script: 'gun-pass', frame: 60 })
    const after = await capture(page, { script: 'gun-pass', frame: 120 })
    expect(before.targetsAlive).toBe(1)
    expect(before.targetInstances).toBe(1)
    expect(after.targetsAlive).toBe(0)
    // sim 側は止まったまま残るので、描画で隠していることを見る
    expect(after.targetCount).toBe(1)
    expect(after.targetInstances).toBe(0)
  })

  test('ガンレティクルが画面に入る', async ({ page }) => {
    const hook = await capture(page, { script: 'gun-pass', frame: 60, hud: true })
    expect(hook.hudGunReticleOnScreen).toBe(true)
  })

  test('弾は寿命で消える。上限で止まる', async ({ page }) => {
    const hook = await capture(page, { script: 'gun-pass', frame: 600 })
    // 寿命 2.5 秒 × 100 発/秒 = 250 発が定常
    expect(hook.bulletsInFlight).toBeLessThanOrEqual(253)
  })

  test('同じフレームを 2 回撮ると戦績が一致する', async ({ page }) => {
    const a = await capture(page, { script: 'gun-pass', frame: 90 })
    const b = await capture(page, { script: 'gun-pass', frame: 90 })
    expect(a.hits).toBe(b.hits)
    expect(a.kills).toBe(b.kills)
    expect(a.bulletsInFlight).toBe(b.bulletsInFlight)
    expect(a.tracersDrawn).toBe(b.tracersDrawn)
  })
})

test.describe('ロックオン', () => {
  test('前方の標的を 0.7 秒で捉える', async ({ page }) => {
    // 実測。捕捉にかかるのは 0.7 秒 = 84 フレーム
    const acquiring = await capture(page, { script: 'target-ahead', frame: 40 })
    expect(acquiring.lockState).toBe('acquiring')
    expect(acquiring.lockProgress).toBeGreaterThan(0.4)
    expect(acquiring.lockProgress).toBeLessThan(0.6)

    const locked = await capture(page, { script: 'target-ahead', frame: 240 })
    expect(locked.lockState).toBe('locked')
    expect(locked.lockProgress).toBe(1)
  })

  test('距離と接近速度と角度を出す', async ({ page }) => {
    const hook = await capture(page, { script: 'target-ahead', frame: 240 })
    // 自機 250 m/s・標的 245 m/s なので 5 m/s で詰まる
    expect(hook.closingSpeed).toBeCloseTo(5, 0)
    expect(hook.lockRange).toBeGreaterThan(150)
    expect(hook.lockRange).toBeLessThan(220)
    // 捕捉の視野は機軸から 20 度
    expect(hook.lockAngleDeg).toBeLessThan(20)
  })

  test('標的のいない台本ではロックが立たない', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.lockState).toBe('none')
    expect(hook.lockRange).toBe(0)
  })

  test('標的が視野を抜けるとロックが落ちる', async ({ page }) => {
    const held = await capture(page, { script: 'target-turn', frame: 240 })
    expect(held.lockState).toBe('locked')
    // 右へ抜けていくと追従の視野 40 度を超える
    const lost = await capture(page, { script: 'target-turn', frame: 1440 })
    expect(lost.lockState).toBe('none')
  })

  test('ロックが立ってから落ちる。耐久 60 で順序が入れ替わった', async ({ page }) => {
    // **耐久 20 のころは機銃のほうが速く、ロックが立つ前に落ちていた。**
    // 60 へ上げて撃墜が 0.50 → 0.95 秒になり、捕捉 0.70 秒を追い越した
    const acquiring = await capture(page, { script: 'gun-pass', frame: 60 })
    expect(acquiring.lockState).toBe('acquiring')
    expect(acquiring.kills).toBe(0)

    const locked = await capture(page, { script: 'gun-pass', frame: 90 })
    expect(locked.lockState).toBe('locked')
    expect(locked.kills).toBe(0)

    const killed = await capture(page, { script: 'gun-pass', frame: 120 })
    expect(killed.kills).toBe(1)
    expect(killed.lockState).toBe('none')
  })

  test('ロックボックスが画面に入る', async ({ page }) => {
    const hook = await capture(page, { script: 'target-ahead', frame: 240, hud: true })
    expect(hook.hudLockBoxOnScreen).toBe(true)
  })

  test('HUD を出さなければロックボックスも出ない', async ({ page }) => {
    const hook = await capture(page, { script: 'target-ahead', frame: 240 })
    expect(hook.hudReady).toBe(false)
    expect(hook.hudLockBoxOnScreen).toBe(false)
    // sim 側のロックは HUD の有無に関係なく立つ
    expect(hook.lockState).toBe('locked')
  })

  test('同じフレームを 2 回撮るとロックの値が一致する', async ({ page }) => {
    const a = await capture(page, { script: 'target-turn', frame: 600 })
    const b = await capture(page, { script: 'target-turn', frame: 600 })
    expect(a.lockState).toBe(b.lockState)
    expect(a.lockRange).toBe(b.lockRange)
    expect(a.closingSpeed).toBe(b.closingSpeed)
    expect(a.lockProgress).toBe(b.lockProgress)
  })
})

test.describe('ミサイル', () => {
  test('ロックしてから撃つと飛ぶ', async ({ page }) => {
    // 台本は 1 秒で撃つ。捕捉に 0.7 秒かかるのでロックが立っている
    const before = await capture(page, { script: 'missile-shot', frame: 110 })
    expect(before.lockState).toBe('locked')
    expect(before.missilesFired).toBe(0)

    const after = await capture(page, { script: 'missile-shot', frame: 150 })
    expect(after.missilesFired).toBe(1)
    expect(after.missilesInFlight).toBe(1)
    // **搭載は 8 発**（`MISSILE_COUNT`。Phase 7 で 6 発から増やした）
    expect(after.missilesLeft).toBe(7)
  })

  test('sim と描画のミサイルの数が一致する', async ({ page }) => {
    const hook = await capture(page, { script: 'missile-shot', frame: 300 })
    expect(hook.missilesInFlight).toBe(1)
    expect(hook.missilesDrawn).toBe(1)
  })

  test('比例航法で命中して標的が落ちる', async ({ page }) => {
    // 実測。3,000 m の的に 9 秒で当たる
    const hook = await capture(page, { script: 'missile-shot', frame: 1200 })
    expect(hook.hits).toBe(1)
    expect(hook.kills).toBe(1)
    expect(hook.targetsAlive).toBe(0)
    expect(hook.missilesInFlight).toBe(0)
  })

  test('届かない距離では外れる', async ({ page }) => {
    // 実測で有効射程は 12 km。15 km では寿命 60 秒を使い切って
    // 3,115 m 手前で落ちる
    const hook = await capture(page, { script: 'missile-miss', frame: 7440 })
    expect(hook.missilesFired).toBe(1)
    expect(hook.hits).toBe(0)
    expect(hook.kills).toBe(0)
    expect(hook.targetsAlive).toBe(1)
    expect(hook.missilesInFlight).toBe(0)
  })

  test('ロックしていなければ撃てない', async ({ page }) => {
    // 標的のいない台本。引き金を引いても出ない
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.lockState).toBe('none')
    expect(hook.missilesFired).toBe(0)
  })

  test('煙を切ると描画が減る', async ({ page }) => {
    const on = await capture(page, { script: 'missile-shot', frame: 300 })
    const off = await capture(page, { script: 'missile-shot', frame: 300, smoke: false })
    expect(on.drawnTriangles).toBeGreaterThan(off.drawnTriangles)
  })

  test('ミサイルを足しても三角形が予算の内側', async ({ page }) => {
    const hook = await capture(page, { script: 'missile-shot', frame: 300 })
    expect(hook.drawnTriangles).toBeLessThan(1_500_000)
  })

  test('同じフレームを 2 回撮ると戦績が一致する', async ({ page }) => {
    const a = await capture(page, { script: 'missile-shot', frame: 400 })
    const b = await capture(page, { script: 'missile-shot', frame: 400 })
    expect(a.missilesFired).toBe(b.missilesFired)
    expect(a.missilesInFlight).toBe(b.missilesInFlight)
    expect(a.hits).toBe(b.hits)
  })
})

test.describe('爆発', () => {
  test('機銃の撃墜で 1 個出る', async ({ page }) => {
    // 実測 0.95 秒 = f114。耐久を 20 から 60 へ上げたぶん遅くなった
    const before = await capture(page, { script: 'gun-pass', frame: 90 })
    expect(before.kills).toBe(0)
    expect(before.explosionCount).toBe(0)

    const after = await capture(page, { script: 'gun-pass', frame: 120 })
    expect(after.kills).toBe(1)
    expect(after.explosionCount).toBe(1)
    expect(after.explosionsAlive).toBe(1)
    expect(after.explosionsDrawn).toBe(1)
  })

  test('ミサイルの命中で 2 個出る。弾頭の炸裂と撃墜', async ({ page }) => {
    const hook = await capture(page, { script: 'missile-shot', frame: 1140 })
    expect(hook.kills).toBe(1)
    expect(hook.explosionCount).toBe(2)
  })

  test('外れたら 1 個も出ない', async ({ page }) => {
    const hook = await capture(page, { script: 'missile-miss', frame: 7440 })
    expect(hook.kills).toBe(0)
    expect(hook.explosionCount).toBe(0)
    expect(hook.explosionsDrawn).toBe(0)
  })

  test('寿命が過ぎると消える', async ({ page }) => {
    // 撃墜は 0.6 秒、寿命 3.5 秒。5 秒後には消えている
    const hook = await capture(page, { script: 'gun-pass', frame: 600 })
    expect(hook.explosionCount).toBe(1)
    expect(hook.explosionsAlive).toBe(0)
    expect(hook.explosionsDrawn).toBe(0)
  })

  test('sim と描画の数が一致する', async ({ page }) => {
    const hook = await capture(page, { script: 'gun-pass', frame: 130 })
    expect(hook.explosionsDrawn).toBe(hook.explosionsAlive)
  })

  test('爆発を切ると描画が減る', async ({ page }) => {
    const on = await capture(page, { script: 'gun-pass', frame: 120 })
    const off = await capture(page, { script: 'gun-pass', frame: 120, explosions: false })
    expect(on.drawCalls).toBeGreaterThan(off.drawCalls)
  })

  test('同じフレームを 2 回撮ると爆発の数が一致する', async ({ page }) => {
    const a = await capture(page, { script: 'gun-pass', frame: 130 })
    const b = await capture(page, { script: 'gun-pass', frame: 130 })
    expect(a.explosionCount).toBe(b.explosionCount)
    expect(a.explosionsAlive).toBe(b.explosionsAlive)
    expect(a.explosionsDrawn).toBe(b.explosionsDrawn)
  })
})

test.describe('DLZ', () => {
  test('ロックすると 3 つの半径が出る', async ({ page }) => {
    const hook = await capture(page, { script: 'missile-shot', frame: 110 })
    expect(hook.lockState).toBe('locked')
    // 実測。追う構図（接近 10 m/s）で 12,070 m
    expect(hook.dlzMax).toBeGreaterThan(11_000)
    expect(hook.dlzMax).toBeLessThan(13_000)
    expect(hook.dlzMin).toBeGreaterThan(0)
  })

  test('rMin < rNe <= rMax の順序が保たれる', async ({ page }) => {
    for (const [script, frame] of [
      ['missile-shot', 110],
      ['head-on', 600],
      ['head-on', 1080],
      ['target-turn', 300],
    ] as const) {
      const hook = await capture(page, { script, frame })
      const label = `${script} f${frame}`
      expect(hook.dlzMin, label).toBeLessThanOrEqual(hook.dlzNe)
      expect(hook.dlzNe, label).toBeLessThanOrEqual(hook.dlzMax)
    }
  })

  test('接近速度が上がると rMax が伸びる', async ({ page }) => {
    // head-on は標的が半周してこちらへ向く。9 秒で接近 481 m/s
    const early = await capture(page, { script: 'head-on', frame: 240 })
    const late = await capture(page, { script: 'head-on', frame: 1080 })
    expect(late.closingSpeed).toBeGreaterThan(early.closingSpeed)
    expect(late.dlzMax).toBeGreaterThan(early.dlzMax)
  })

  test('rNe は接近速度で変わらない。逃げる相手が基準だから', async ({ page }) => {
    const early = await capture(page, { script: 'head-on', frame: 240 })
    const late = await capture(page, { script: 'head-on', frame: 1080 })
    expect(Math.abs(late.dlzNe - early.dlzNe)).toBeLessThan(50)
  })

  test('ロックしていなければ 0', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.lockState).toBe('none')
    expect(hook.dlzMax).toBe(0)
    expect(hook.dlzNe).toBe(0)
    expect(hook.dlzMin).toBe(0)
  })

  test('HUD にバーが出る', async ({ page }) => {
    const on = await capture(page, { script: 'missile-shot', frame: 110, hud: true })
    expect(on.hudDlzBarShown).toBe(true)

    // ロックしていなければ出さない
    const off = await capture(page, { script: 'level', frame: 240, hud: true })
    expect(off.hudDlzBarShown).toBe(false)
  })

  test('同じフレームを 2 回撮ると DLZ が一致する', async ({ page }) => {
    const a = await capture(page, { script: 'head-on', frame: 900 })
    const b = await capture(page, { script: 'head-on', frame: 900 })
    expect(a.dlzMax).toBe(b.dlzMax)
    expect(a.dlzNe).toBe(b.dlzNe)
    expect(a.dlzMin).toBe(b.dlzMin)
  })
})

test.describe('操作の型', () => {
  test('既定はエキスパート', async ({ page }) => {
    const hook = await capture(page, { frame: 60 })
    expect(hook.controlMode).toBe('expert')
  })

  test('?control=standard で切り替わる', async ({ page }) => {
    await openLive(page, '?control=standard')
    const mode = await page.evaluate(
      () =>
        (window as unknown as { __dogfight?: { controlMode: string } }).__dogfight
          ?.controlMode,
    )
    expect(mode).toBe('standard')
  })

  /** **不正な値は既定へ倒す。**`resolvePreset` と同じ作法 */
  test('知らない値はエキスパートへ倒れる', async ({ page }) => {
    await openLive(page, '?control=arcade')
    const mode = await page.evaluate(
      () =>
        (window as unknown as { __dogfight?: { controlMode: string } }).__dogfight
          ?.controlMode,
    )
    expect(mode).toBe('expert')
  })
})

test.describe('リザルト', () => {
  /**
   * **ライブ専用。**キャプチャモードは早期 return するので、基準画像には
   * 写らない。DOM を直接見る。
   */
  test('決着すると出る', async ({ page }) => {
    await openLive(page, '?script=mission-01')
    const result = page.locator('#result')

    // 走っているあいだは畳まれている
    await expect(result).toBeHidden()

    // 入力なしで飛ぶので正面の敵に撃たれる。決着まで待つ
    await page.waitForFunction(
      () => {
        const hook = (window as unknown as { __dogfight?: { missionOutcome: string } })
          .__dogfight
        return hook !== undefined && hook.missionOutcome === 'shotDown'
      },
      undefined,
      { timeout: 120_000 },
    )

    await expect(result).toBeVisible()
    await expect(result).toHaveClass(/is-failed/)
    await expect(result.locator('.result-title')).toHaveText('MISSION FAILED')
    await expect(result.locator('.result-reason')).toHaveText('撃墜された')
  })

  test('ミッションのない台本では出ない', async ({ page }) => {
    await openLive(page, '?script=level')
    await expect(page.locator('#result')).toBeHidden()
  })

  /** **`#hud` の中に入れない。**あちらは pointer-events: none で操作できない */
  test('#hud の兄弟に置く', async ({ page }) => {
    await openLive(page, '?script=level')
    const inside = await page.evaluate(
      () => document.querySelector('#hud #result') !== null,
    )
    expect(inside).toBe(false)
    const exists = await page.evaluate(
      () => document.querySelector('body > #result') !== null,
    )
    expect(exists).toBe(true)
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

/**
 * ミサイル警告とフレア。
 *
 * **ミサイルは 1 発で自機を落とす**（ダメージ 100 に対し耐久 60）。避ける
 * 手段がないと「まっすぐ飛んでいて突然落ちる」になるので、警告とフレアは
 * 一組で意味を持つ。
 */
test.describe('ミッション', () => {
  test('始まった直後は進行中で、残り時間が満タン', async ({ page }) => {
    const hook = await capture(page, { script: 'mission-01', frame: 60 })
    expect(hook.missionOutcome).toBe('running')
    // 制限時間 300 秒 = 36,000 フレーム。1 秒ぶん進んでいる
    expect(hook.missionRemaining).toBe(36000 - 60)
  })

  test('ミッションのない台本では判定しない', async ({ page }) => {
    const hook = await capture(page, { script: 'level', frame: 240 })
    expect(hook.missionOutcome).toBe('none')
    expect(hook.missionRemaining).toBe(0)
  })

  /**
   * **300 秒ぶん回しても 6.1 秒で撮れる。**sim のステップは軽く、キャプチャの
   * 所要は描画の初期化が支配する（f600 が 5.9 秒、f36000 が 6.1 秒。実測）。
   * ミッション全体を E2E で回せる。
   */
  test('制限時間まで回すと決着している', async ({ page }) => {
    const hook = await capture(page, { script: 'mission-01', frame: 36000 })
    expect(hook.missionOutcome).not.toBe('running')
    expect(hook.missionOutcome).not.toBe('none')
    expect(hook.missionRemaining).toBeGreaterThanOrEqual(0)
  })
})

test.describe('ミサイル警告とフレア', () => {
  test('撃たれると警告が出る', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-missile', frame: 360 })
    expect(hook.enemyMissilesFired).toBeGreaterThan(0)
    expect(hook.incomingMissiles).toBeGreaterThan(0)
    expect(hook.missileWarning).toBe(true)
  })

  /** 真後ろから来るので方位は ±π に近い */
  test('警告の方位が真後ろを指す', async ({ page }) => {
    const hook = await capture(page, { script: 'enemy-missile', frame: 360 })
    expect(Math.abs(hook.missileBearing)).toBeGreaterThan((150 * Math.PI) / 180)
    expect(hook.missileTimeToImpact).toBeGreaterThan(0)
  })

  test('撃たれていなければ警告は出ない', async ({ page }) => {
    // enemy-attack は機銃だけの敵（missiles: 0）
    const hook = await capture(page, { script: 'enemy-attack', frame: 1200 })
    expect(hook.enemyMissilesFired).toBe(0)
    expect(hook.missileWarning).toBe(false)
  })

  /**
   * フレアで逸らすと自機が生き残る。
   *
   * 台本 `flare-break` は着弾の 1 秒前（f732）に撒く。実測で 1 発目の
   * 着弾は 7.1 秒（f852）。**2 発目が 6 秒に出る**ので、f900 の時点では
   * まだ飛んでいる。
   */
  test('フレアで 1 発目を逸らせる', async ({ page }) => {
    const flared = await capture(page, { script: 'flare-break', frame: 900 })
    expect(flared.flaresLeft).toBeLessThan(30)
    expect(flared.playerIntegrity).toBeGreaterThan(0)

    // 撒かなければ落ちている
    const naked = await capture(page, { script: 'enemy-missile', frame: 900 })
    expect(naked.playerIntegrity).toBeLessThanOrEqual(0)
  })

  /**
   * **横からは効かない。**フレアは機体の後方へ流れるので、横から来る
   * ミサイルの軸から大きく外れる。角度で割り引かれて強度差 4 倍を
   * 超えられない（`docs/weapons.md`）。
   *
   * 実測で f240 に撒いても f720 で落ちる。
   */
  test('横から撃たれたときは効かない', async ({ page }) => {
    const hook = await capture(page, { script: 'flare-head-on', frame: 780 })
    expect(hook.flaresLeft).toBeLessThan(30)
    expect(hook.playerIntegrity).toBeLessThanOrEqual(0)
  })

  /**
   * 敵も回避に入ると撒く。
   *
   * **自機のフレアは追従カメラに映らない**（後方 23 m から前を向くので、
   * 撒いた 0.7 秒後にはカメラの後ろ）。前方の敵が撒くぶんが絵になる。
   */
  test('敵が回避に入るとフレアを撒く', async ({ page }) => {
    const on = await capture(page, { script: 'enemy-flare', frame: 180, coverage: 0 })
    expect(on.flaresBurning).toBeGreaterThan(0)
    // 描画を切るとドローコールが減る
    const off = await capture(page, {
      script: 'enemy-flare',
      frame: 180,
      coverage: 0,
      flares: false,
    })
    expect(on.drawCalls).toBeGreaterThan(off.drawCalls)
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
    { name: 'level-afternoon', script: 'level', frame: 240, hour: 16, coverage: 0.3 },
    { name: 'level-backlit', script: 'level', frame: 240, hour: 8, coverage: 0.3 },
    // バンク 66 度・3.27 G・揚力係数 0.449 なので翼端渦が 0.30 の濃さで出る。
    // 荷重倍数で判定していたころは出なかった
    { name: 'bank-left-dusk', script: 'bank-left', frame: 420, hour: 18.3, coverage: 0.3 },
    { name: 'low-pass-afternoon', script: 'low-pass', frame: 240, hour: 16, coverage: 0.3 },
    // 雲を主題にした構図
    { name: 'clouds-climb', script: 'pull-up', frame: 200, hour: 16, coverage: 0.3 },
    { name: 'clouds-dense', script: 'level', frame: 480, hour: 16, coverage: 0.8 },
    { name: 'clouds-clear', script: 'level', frame: 240, hour: 16, coverage: 0 },
    // 地形を主題にした構図。島を見下ろす、海岸線を低空で抜ける、雲を突き抜ける主峰
    { name: 'terrain-overlook', script: 'island-run', frame: 2000, hour: 9, coverage: 0.3 },
    { name: 'terrain-coast', script: 'low-pass', frame: 1800, hour: 9, coverage: 0.3 },
    { name: 'terrain-peak', script: 'island-run', frame: 3240, hour: 17, coverage: 0.3 },
    // 機体を主題にした構図。斜め後方からの接写、自分の影が地面を走るカット、
    // 高 G で翼端渦が出るカット、その渦が画面の縁で切れているカット
    { name: 'aircraft-close', script: 'bank-left', frame: 30, hour: 12, coverage: 0.3 },
    { name: 'aircraft-shadow', script: 'low-pass', frame: 2500, hour: 16, coverage: 0.3 },
    { name: 'aircraft-vortex', script: 'pull-up', frame: 430, hour: 12, coverage: 0.3 },
    // 引き起こしを続けて 7.5 秒。左右の渦が画面の下隅を突き抜ける。
    // 軌跡が空中で尻すぼみに消えていないことを、この 1 枚で見張る
    { name: 'aircraft-vortex-long', script: 'pull-up', frame: 900, hour: 12, coverage: 0.3 },
    // 定常旋回。荷重倍数は 3.08 しかないが揚力係数 0.569 で渦が出る。
    // 荷重倍数で判定していたころは、この構図でまったく渦が出なかった
    { name: 'aircraft-vortex-turn', script: 'bank-left', frame: 1800, hour: 12, coverage: 0.3 },
    // 急上昇して舵を戻した 1.3 秒後。翼端の水蒸気に減衰の時定数がないと、
    // ここで渦が 1 階調しか残らず消える。**この 1 枚が遅れの見張り。**
    { name: 'aircraft-vortex-fade', script: 'zoom-climb', frame: 400, hour: 12, coverage: 0.3 },
    // 水平から 5.4 G の旋回へ入って 9 秒。引き始めた位置に水蒸気の段差が
    // あり、その先細りが視界に入る。**この 1 枚が末端の見張り。**
    // 先細りがないと、いちばん太いところで直角に切り落とされて見える
    { name: 'aircraft-vortex-end', script: 'turn-in', frame: 1100, hour: 12, coverage: 0.3 },
    // 標的機。**快晴で撮る。**雲を背に置くと、実測 28 x 10 画素の機体が
    // 明るい雲に埋もれて絵で判別できない。追従カメラの垂直画角は 66.4 度
    // （速度 250 m/s）あるので、190 m の機体でもこの大きさにしかならない
    { name: 'target-ahead', script: 'target-ahead', frame: 240, hour: 16, coverage: 0 },
    // 定常右旋回。バンク 55.8 度で右へ抜けていく
    { name: 'target-turn', script: 'target-turn', frame: 300, hour: 16, coverage: 0 },
    // HUD。**この 3 枚だけが HUD を含む。**ほかのカットに入れると、
    // ピッチラダーの刻みを 1 度動かすだけで全部が差分を出す
    { name: 'hud-level', script: 'target-ahead', frame: 240, hour: 16, coverage: 0, hud: true },
    // バンク 66 度。ピッチラダーが世界に重なって傾き、水平線が実際の
    // 水平線と一致することを、この 1 枚で見張る
    { name: 'hud-bank', script: 'bank-left', frame: 420, hour: 16, coverage: 0, hud: true },
    // 仰角 35 度。フライトパスマーカーと機首の十字が迎角ぶん離れる
    { name: 'hud-climb', script: 'pull-up', frame: 430, hour: 16, coverage: 0, hud: true },
    // 機銃。曳光弾の帯とガンレティクルと残弾。実測で 304 画素・最大 165 階調
    { name: 'gun-firing', script: 'gun-pass', frame: 60, hour: 16, coverage: 0, hud: true },
    // 捕捉中。破線の箱と進みの帯。ロック後は hud-level が見張る（同じ台本の
    // frame 240 で、そちらは角括弧になる）
    { name: 'hud-acquiring', script: 'target-ahead', frame: 40, hour: 16, coverage: 0, hud: true },
    // ミサイル。発射から 1.5 秒。煙が後方へ伸び、本体が前方にいる
    { name: 'missile-launch', script: 'missile-shot', frame: 300, hour: 16, coverage: 0, hud: true },
    // 自機が自分の煙の筋に沿って飛ぶ。**near 面の見張り。**実測で
    // このフレームの煙の中ほどがカメラの 0.1 m を通る（濃さ 1）
    { name: 'missile-smoke-near', script: 'missile-near', frame: 841, hour: 16, coverage: 0 },
    // 爆発。機銃で落とした 0.13 秒後。火球が膨らみ切る手前。
    // **耐久を 60 へ上げて撃墜が 0.95 秒になったので f90 から f130 へ移した**
    { name: 'explosion-gun', script: 'gun-pass', frame: 130, hour: 16, coverage: 0 },
    // ミサイルの命中。弾頭の炸裂と撃墜の 2 つが重なる。
    // **台本を 1,200 m へ寄せたので命中が 5.56 秒 = f667 になった**
    //
    // **芯が生きているフレームで撮る。**f700 は命中の 0.275 秒後で、芯は
    // `CORE_HOLD` 0.18 秒 + 0.12 秒の減衰で 0.30 秒に消える。実測でも
    // f700 の寄与は 118 画素・彩度 17 で、芯の色を変えても最大差が
    // 19 → 13 としか動かなかった。**芯を壊しても気づけない見張りだった。**
    // f679（0.10 秒後）なら 52 画素・彩度 27 で、色を変えると 45 へ動く
    { name: 'explosion-missile', script: 'missile-shot', frame: 679, hour: 16, coverage: 0 },
    // DLZ バー。正面から向かい合う構図で、rNe と rMax の帯が分かれる。
    // 実測で接近 481 m/s・rMax 40,304 m・rNe 12,070 m
    { name: 'hud-dlz', script: 'head-on', frame: 1080, hour: 16, coverage: 0, hud: true },
    // 敵機。**近くで形が読める大きさで撮る。**190 m だと実測 20 画素で、
    // 単垂直尾翼が 1 本あることくらいしか分からない。台本は右前方 45 m に
    // 置くが、自機が後方にいるので敵は回避（水平のブレイクターン）に入る。
    // 深くバンクした平面形が 2,600 画素で写るので、かえって形が読める。
    // **回避の機動の見張りもこの 1 枚が兼ねる。**220 m の `enemy-evade` は
    // 実測 97 画素しかなく、見張りにならなかった
    { name: 'enemy-formation', script: 'enemy-formation', frame: 240, hour: 16, coverage: 0 },
    // 交戦距離の敵機。ロックボックス込みで、実際に戦う大きさを見張る。
    // **敵は回避に入ってフレアを撒くので、その列もここに写る**
    // （実測 2,069 画素・外接 39x80）。フレアの絵を変えるとこの 1 枚も動く
    { name: 'enemy-ahead', script: 'enemy-ahead', frame: 240, hour: 16, coverage: 0, hud: true },
    // 傷ついた敵が煙を引く。**この 1 枚が煙の見張り。**耐久 2 割で濃さ 0.67。
    // 実測で 4,358 画素・12 階調以上 68 画素・最大 27 階調
    { name: 'enemy-smoking', script: 'damage-smoke', frame: 240, hour: 16, coverage: 0 },
    // 撃たれている。後方から曳光弾が来る。**この 1 枚が「撃たれる」の見張り。**
    // 実測で曳光弾は 1,001 画素・最大 60 階調、画面の下から中央へ 358 画素伸びる
    { name: 'enemy-firing', script: 'enemy-attack', frame: 2400, hour: 16, coverage: 0, hud: true },
    // 敵とすれ違ったあと、置いていかれた煙の中をカメラが通る。
    // **この 1 枚が near 面の見張り。**リボンは新しい端がカメラの後ろにあると
    // 全部消える欠陥があった（翼端渦とミサイルの煙では踏まれない経路）。
    // 実測で煙の寄与は 104,942 画素・12 階調以上 37,397 画素・最大 110 階調。
    // 欠陥があるとこれが 0 になる
    { name: 'damage-smoke-near', script: 'damage-smoke-near', frame: 720, hour: 16, coverage: 0 },
    // 敵が回避に入って撒いたフレア。**この 1 枚がフレアの見張り。**
    // **自機のフレアは追従カメラに映らない**（後方 23 m から前を向くので、
    // 撒いた 0.7 秒後にはカメラの後ろ。旋回しても視線角 155〜173 度のまま）。
    // 実測でフレアの寄与は 1,590 画素・最大 64 階調（`?flares=0` との引き算）。
    // **`FLARE_SALVO_COUNT` 段が縦に並ぶのをこの 1 枚で見張る。**外接 64x47。
    // 横並びだったころは 113x31 だった。
    // **色は付けない。**最も赤い画素で赤み 3・彩度 3。深度書きを落とすと
    // 大気の霞に潰れて寄与そのものが減る（`docs/decisions/0008` の表）
    { name: 'enemy-flare', script: 'enemy-flare', frame: 180, hour: 16, coverage: 0 },
    // 点火の閃光。**f180 には写らない**（撒いてから 1.49 秒後で、閃光は
    // `FLARE_FLASH_SECONDS` 0.25 秒で終わる）。この台本は f1 で撒くので、
    // f10 は経過 0.075 秒にあたる。**この 1 枚が閃光の見張り。**
    // 実測で寄与は 119 画素・最大 169 階調（定常の 64 より強い）。
    // **閃光を落とすとここが暗くなる。**色ではなく明るさで見張る
    { name: 'enemy-flare-flash', script: 'enemy-flare', frame: 10, hour: 16, coverage: 0 },
    // ミッションの時計と残敵。**走行中は HUD 緑。**左上に置く（中央上部は
    // 方位テープとその上の現在方位・三角、さらに上へピッチラダーの目盛が
    // 来て埋まっている）。f120 は開始 1 秒で、まだ 5 機とも生きている
    {
      name: 'hud-mission',
      script: 'mission-01',
      frame: 120,
      hour: 16,
      coverage: 0,
      hud: true,
    },
    // 決着したミッション。**失敗すると橙に変わる。**この 1 枚が色の
    // 切り替わりの見張り。f1200（10 秒）で自機は既に撃墜されている
    // （キャプチャは入力なしで飛ぶので正面の敵に撃たれる）
    {
      name: 'hud-mission-failed',
      script: 'mission-01',
      frame: 1200,
      hour: 16,
      coverage: 0,
      hud: true,
    },
    // ミサイル警告。方位の矢印と着弾までの秒。**この 1 枚が警告の見張り。**
    // 真後ろから来るので矢印は真下を指す
    {
      name: 'missile-warning',
      script: 'enemy-missile',
      frame: 600,
      hour: 16,
      coverage: 0,
      hud: true,
    },
    // 空母。**自機を消す。**追従カメラは自機の後方にあるので、出したまま
    // だと船体の前半が機体で隠れて甲板の標識が読めない。差分が読めない
    // 基準画像には意味がない
    // 降着装置。**対地 30 m なので出ている**（`GEAR_DOWN_AGL` は 80 m）。
    // 脚の有無が画素に出る。他の 40 枚はすべて高度 1,000 m 以上なので
    // 出ていない
    {
      name: 'gear-down',
      script: 'gear-down',
      frame: 30,
      hour: 16,
      coverage: 0,
      targets: false,
      enemies: false,
    },
    {
      name: 'carrier',
      script: 'carrier-deck',
      frame: 1,
      hour: 16,
      coverage: 0,
      targets: false,
      enemies: false,
      aircraft: false,
    },
  ] as const

  for (const scene of scenes) {
    test(`${scene.name} の絵が基準と一致する`, async ({ page }) => {
      await capture(page, scene)
      await expect(page.locator('#viewport')).toHaveScreenshot(`${scene.name}.png`)
    })
  }
})

/**
 * タイトル画面。
 *
 * **ライブ専用。**キャプチャモードは `main.ts` が早期 return するので作られ
 * ない。基準画像 39 枚は 1 画素も動かない（`exact.mjs` で確認済み）。
 */
test.describe('タイトル画面', () => {
  test('起動すると出て、START で消える', async ({ page }) => {
    // openLive は title=0 を混ぜるので、ここは直接開く
    await page.goto('/dogfight/?script=level&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )

    const title = page.locator('#title')
    await expect(title).toBeVisible()
    await expect(title.locator('.title-heading')).toHaveText('DOGFIGHT')

    await page.locator('.title-start').click()
    await expect(title).toBeHidden()
  })

  /**
   * 操作説明の抜けを押さえる。
   *
   * `debugPanel.ts` のハードコード文字列には**機銃・ミサイル・フレアが
   * 無かった**。撃つ手段が説明に出ていない状態だったので、キー割り当ての
   * 正本を `keyboard.ts` の `CONTROL_HELP` に一元化した
   */
  test('撃つ操作が説明に出ている', async ({ page }) => {
    await page.goto('/dogfight/?script=level&precompile=0')
    await page.waitForSelector('.title-controls')
    const text = await page.locator('.title-controls').innerText()
    for (const word of ['機銃', 'ミサイル', 'フレア', 'ピッチ', 'ロール', 'スロットル']) {
      expect(text, `操作説明に「${word}」が無い`).toContain(word)
    }
  })

  test('?title=0 では出ない', async ({ page }) => {
    await openLive(page, '?script=level')
    await expect(page.locator('#title')).toBeHidden()
    expect(await page.locator('.title-panel').count()).toBe(0)
  })

  /** **`#hud` の中に入れない。**あちらは pointer-events: none で押せない */
  test('#hud の兄弟に置く', async ({ page }) => {
    await page.goto('/dogfight/?script=level&precompile=0')
    await page.waitForSelector('.title-panel')
    expect(await page.locator('#hud #title').count()).toBe(0)
    expect(await page.locator('body > #title').count()).toBe(1)
  })

  /** キャプチャモードでは作らない。基準画像に写らせない */
  test('キャプチャモードでは作られない', async ({ page }) => {
    await capture(page, { frame: 60 })
    expect(await page.locator('.title-panel').count()).toBe(0)
    await expect(page.locator('#title')).toBeHidden()
  })
})

/**
 * 設定画面。
 *
 * **ライブ専用。**キャプチャモードは `localStorage` を読まない（開発者の
 * ブラウザに保存された画質や時刻で基準画像が変わってしまう）。
 */
test.describe('設定画面', () => {
  /** タイトルから開く。開いた状態を作る */
  async function openSettings(page: Page, query = '?script=level'): Promise<void> {
    await page.goto(`/dogfight/${query}&precompile=0`)
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    await page.locator('.title-settings').click()
    await expect(page.locator('#settings')).toBeVisible()
  }

  test('タイトルから開いて閉じるで畳む', async ({ page }) => {
    await openSettings(page)
    await page.locator('.settings-close').click()
    await expect(page.locator('#settings')).toBeHidden()
  })

  /**
   * **暗幕を 2 枚重ねない。**どちらも `rgba(5, 16, 26, 0.88)` を全面に
   * 敷くので、重なると実質 0.986 になって背景がほぼ黒くなる。実測で
   * タイトルの文字が設定の下に透けて見えた
   */
  test('設定を開くとタイトルは畳まれ、閉じると戻る', async ({ page }) => {
    await openSettings(page)
    await expect(page.locator('#title')).toBeHidden()

    await page.locator('.settings-close').click()
    await expect(page.locator('#title')).toBeVisible()
    await expect(page.locator('#settings')).toBeHidden()
  })

  test('Escape で閉じてもタイトルへ戻る', async ({ page }) => {
    await openSettings(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('#settings')).toBeHidden()
    await expect(page.locator('#title')).toBeVisible()
  })

  /**
   * **焦点をパネルに置く。**`select` に置くと `Space` がドロップダウンを
   * 開き、`Escape` がそれを閉じるほうに消費されて設定が閉じない。
   * 実測で Escape 2 回が要る状態だった
   */
  test('Space のあとでも Escape 1 回で閉じる', async ({ page }) => {
    await openSettings(page)
    await page.keyboard.press('Space')
    await page.keyboard.press('Escape')
    await expect(page.locator('#settings')).toBeHidden()
  })

  test('画質を選ぶと即座に効く', async ({ page }) => {
    await openSettings(page)
    await page.selectOption('#settings-preset', 'low')
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.preset,
        ),
      )
      .toBe('low')
  })

  test('操作の型を選ぶと即座に効く', async ({ page }) => {
    await openSettings(page)
    await page.selectOption('#settings-controlMode', 'standard')
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.controlMode,
        ),
      )
      .toBe('standard')
  })

  /**
   * **操縦を止める。**つまみに焦点があるとき矢印キーは値を動かすもので、
   * 同時に機体をロールさせては困る。`R` でやり直しが走るのも困る
   */
  test('開いている間は撃てない', async ({ page }) => {
    await openSettings(page)
    const before = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.roundsFired ?? -1,
    )
    await page.keyboard.down('Space')
    await page.waitForTimeout(600)
    await page.keyboard.up('Space')
    const during = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.roundsFired ?? -1,
    )
    expect(during, '設定を開いている間に撃っている').toBe(before)

    // 閉じたら戻る
    await page.locator('.settings-close').click()
    await page.keyboard.down('Space')
    await page.waitForTimeout(600)
    await page.keyboard.up('Space')
    const after = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.roundsFired ?? -1,
    )
    expect(after, '閉じても撃てないままになっている').toBeGreaterThan(during)
  })

  test('保存されて次に開いたとき効いている', async ({ page }) => {
    await openSettings(page)
    await page.selectOption('#settings-preset', 'medium')
    await page.selectOption('#settings-controlMode', 'standard')
    await page.locator('.settings-close').click()

    // 同じ context なので localStorage は共有される
    await page.goto('/dogfight/?script=level&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    const hook = await readHook(page)
    expect(hook?.preset).toBe('medium')
    expect(hook?.controlMode).toBe('standard')
  })

  /** **URL が保存値に勝つ。**条件を固定して比べられなくなる */
  test('URL の指定が保存値に勝つ', async ({ page }) => {
    await openSettings(page)
    await page.selectOption('#settings-preset', 'low')
    await page.locator('.settings-close').click()

    await page.goto('/dogfight/?script=level&preset=ultra&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    expect((await readHook(page))?.preset).toBe('ultra')
  })

  /**
   * **キャプチャモードは保存値を読まない。**読むと開発者のブラウザの
   * 設定で基準画像が変わる
   */
  test('キャプチャモードは保存値を無視する', async ({ page }) => {
    await openSettings(page)
    await page.selectOption('#settings-preset', 'low')
    await page.locator('.settings-close').click()

    const hook = await capture(page, { frame: 60 })
    expect(hook.preset, 'キャプチャが localStorage を読んでいる').toBe('high')
    expect(await page.locator('.settings-panel').count()).toBe(0)
  })

  /** **`#hud` の中に入れない。**あちらは pointer-events: none で押せない */
  test('#hud の兄弟に置く', async ({ page }) => {
    await openSettings(page)
    expect(await page.locator('#hud #settings').count()).toBe(0)
    expect(await page.locator('body > #settings').count()).toBe(1)
  })

  /** 壊れた保存値で起動しなくなってはいけない */
  test('保存値が壊れていても起動する', async ({ page }) => {
    await page.goto('/dogfight/?title=0&script=level&precompile=0')
    await page.evaluate(() => localStorage.setItem('dogfight.settings', '{壊れている'))
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/dogfight/?title=0&script=level&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    expect(errors, '例外が出ている').toEqual([])
    expect((await readHook(page))?.preset, '既定へ倒れていない').toBe('high')
  })
})

/**
 * 効果音。
 *
 * **音は目で見えない。**ノードが繋がっただけで振幅が 0 という状態は、
 * 画面にも基準画像にも出ない。`?audioprobe=1` で `OfflineAudioContext` に
 * 書き出し、実際の波形を測る（`src/audio/probe.ts`）。
 */
test.describe('効果音', () => {
  test('すべての音が実際に鳴っている', async ({ page }) => {
    await page.goto('/dogfight/?capture=1&frame=60&audioprobe=1')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const handle = await page.waitForFunction(
      () =>
        (window as unknown as { __dogfight?: TestHook }).__dogfight?.audioProbe ?? null,
      undefined,
      { timeout: 60_000 },
    )
    const probe = (await handle.jsonValue()) as Record<
      string,
      { rms: number; peak: number }
    >

    for (const name of ['explosion', 'launch', 'warning', 'gun', 'engine']) {
      const r = probe[name]
      expect(r, `${name} が測れていない`).toBeDefined()
      // 実測の最小は launch の rms 0.0196。無音との差は桁で開いている
      expect(r!.rms, `${name} が無音`).toBeGreaterThan(0.005)
      expect(r!.peak, `${name} の振幅が小さすぎる`).toBeGreaterThan(0.05)
    }
  })

  /**
   * **全部が同時に鳴ってもクリップしない。**
   *
   * `DynamicsCompressorNode` はルックアヘッドを持たないので瞬間的な
   * ピークを通す。実測で、ソフトクリップを入れる前は 8 回中 2 回が 1 を
   * 超えた（1.0166 と 1.0535）。
   */
  test('最悪の場合でもクリップしない', async ({ page }) => {
    await page.goto('/dogfight/?capture=1&frame=60&audioprobe=1')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const handle = await page.waitForFunction(
      () =>
        (window as unknown as { __dogfight?: TestHook }).__dogfight?.audioProbe ?? null,
      undefined,
      { timeout: 60_000 },
    )
    const probe = (await handle.jsonValue()) as Record<
      string,
      { rms: number; peak: number }
    >
    expect(probe['worstCase']!.peak, 'クリップしている').toBeLessThan(1)
    // 鳴ってはいる。0 なら経路が切れている
    expect(probe['worstCase']!.rms).toBeGreaterThan(0.05)
  })

  /**
   * **START を押すまで作らない。**ブラウザの autoplay 制限で、操作を
   * 経ずに作った `AudioContext` は `suspended` のまま音が出ない
   */
  test('START で音が使えるようになる', async ({ page }) => {
    await page.goto('/dogfight/?script=level&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    expect((await readHook(page))?.audioReady, 'START の前に作っている').toBe(false)

    await page.locator('.title-start').click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.audioReady,
        ),
      )
      .toBe(true)
  })

  test('?sound=0 では作らない', async ({ page }) => {
    await page.goto('/dogfight/?script=level&sound=0&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    await page.locator('.title-start').click()
    await page.waitForTimeout(500)
    expect((await readHook(page))?.audioReady).toBe(false)
  })

  /** キャプチャは 1 枚描いて止まるので鳴らす意味がない */
  test('キャプチャモードでは作らない', async ({ page }) => {
    const hook = await capture(page, { frame: 60 })
    expect(hook.audioReady).toBe(false)
  })

  /** 音を鳴らしても絵は変わらない。基準画像を汚さないことの確認 */
  test('音を出しても例外が出ない', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/dogfight/?script=mission-01&precompile=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    )
    await page.locator('.title-start').click()
    // 撃つ・被弾する・爆発する を一通り通す
    await page.keyboard.down('Space')
    await page.waitForTimeout(2000)
    await page.keyboard.up('Space')
    await page.waitForTimeout(1000)

    const hook = await readHook(page)
    expect(hook!.roundsFired, '撃てていない').toBeGreaterThan(0)
    expect(errors, '例外が出ている').toEqual([])
  })
})

/**
 * シェーダの事前コンパイル。
 *
 * **three はマテリアルを作ったときではなく、それを持つオブジェクトを最初に
 * 描くときにコンパイルする。**しかも品質プリセットを落とすと影のマップ
 * 解像度が変わり、全マテリアルのプログラムが作り直される。
 *
 * 実測（SwiftShader、`?script=mission-01`）。`PerformanceGovernor` が
 * high から medium へ落とした瞬間に 13 個がまとめて作られ、そのフレームが
 * 772.9 ms 止まった。**軽くするための降格が、その瞬間に最大のスパイクを
 * 作っていた。**起動時に 4 段ぶん作っておくと 344.9 ms まで下がる。
 */
test.describe('シェーダの事前コンパイル', () => {
  test('起動を終えた時点で 4 段ぶん作ってある', async ({ page }) => {
    await page.goto('/dogfight/?script=mission-01&title=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 300_000 },
    )
    const hook = await readHook(page)
    // 実測で 119 個。1 段ぶんだけなら 43 個だった
    expect(hook!.programs, '事前コンパイルが効いていない').toBeGreaterThan(90)
    expect(hook!.compileMs, 'コンパイルの時間が記録されていない').toBeGreaterThan(0)
  })

  /**
   * **降格してもほとんど増えない。**増えるならその場でコンパイルが
   * 走っている
   */
  test('品質が落ちても作り直しがほぼ起きない', async ({ page }) => {
    await page.goto('/dogfight/?script=mission-01&title=0')
    await page.waitForFunction(
      () => ((window as unknown as { __dogfight?: TestHook }).__dogfight?.frame ?? 0) > 0,
      undefined,
      { timeout: 300_000 },
    )
    const before = (await readHook(page))!.programs

    // SwiftShader は遅いので自動降格が起きる。起きなければこの検査は素通り
    const degraded = await page
      .waitForFunction(
        () =>
          (window as unknown as { __dogfight?: TestHook }).__dogfight?.preset !== 'high',
        undefined,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false)

    if (!degraded) {
      test.skip(true, '降格が起きなかった（速い環境）')
      return
    }
    await page.waitForTimeout(1500)
    const after = (await readHook(page))!.programs
    // 事前コンパイルが無いと 13 個増えていた。残るのは環境マップ関連の数個
    expect(after - before, '降格でプログラムが大量に作られている').toBeLessThan(8)
  })

  /** キャプチャモードは早期 return より前なので通らない */
  test('キャプチャモードでは走らない', async ({ page }) => {
    const hook = await capture(page, { frame: 60 })
    expect(hook.compileMs, 'キャプチャで事前コンパイルが走っている').toBe(0)
  })
})

/**
 * 降着装置。
 *
 * **判定は sim が持つ**（`AircraftSample.gearDown`）。描画側に高度を見る
 * 処理を置くと、キャプチャモードは `sync()` が 1 回しか走らないので出ない。
 *
 * 閾値は対地 80 m（`GEAR_DOWN_AGL`）。ゲームの値で、実機は速度で制限する。
 * 甲板（海面から 20 m）にいるあいだ出ていて、射出後すぐ引き込まれる高さ。
 */
test.describe('降着装置', () => {
  test('対地 30 m では出ている', async ({ page }) => {
    const hook = await capture(page, { script: 'gear-down', frame: 30 })
    expect(hook.agl, '対地高度が想定と違う').toBeLessThan(80)
    expect(hook.gearDown, '低空で脚が出ていない').toBe(true)
  })

  test('空戦の高度では出ていない', async ({ page }) => {
    const hook = await capture(page, { script: 'mission-01', frame: 120 })
    expect(hook.agl, '高度が想定と違う').toBeGreaterThan(80)
    expect(hook.gearDown, '高空で脚が出ている').toBe(false)
  })

  /**
   * **絵に出ていることを三角形の数で確かめる。**`gearDown` が true でも、
   * 描画側が `visible` を切り替えていなければ意味がない。
   */
  test('出ていると三角形が増える', async ({ page }) => {
    const low = await capture(page, {
      script: 'gear-down',
      frame: 30,
      targets: false,
      enemies: false,
    })
    const high = await capture(page, {
      script: 'gear-down-high',
      frame: 30,
      targets: false,
      enemies: false,
    })
    expect(low.gearDown).toBe(true)
    expect(high.gearDown).toBe(false)
    // 同じ台本で高度だけ違う。差は脚のぶん
    expect(
      low.drawnTriangles - high.drawnTriangles,
      '脚を出しても三角形が増えていない',
    ).toBeGreaterThan(500)
  })
})
