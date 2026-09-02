import { test, expect } from '@playwright/test'
import type { TestHook } from './harness'
import {
  hashProbeExpected,
  HASH_PROBE_SIDE,
} from '../../src/render/hashReference'
import {
  histogramL1,
  maxAbsDifference,
  SHADOW_TILES,
} from '../../src/render/clouds/geometry'
import { encodeShadowInputs } from '../../src/render/clouds/shadowInputs'
import { DEFAULT_COVERAGE } from '../../src/render/pipeline/types'

/**
 * node 経路（`WebGPURenderer`）が立つことを確かめる。
 *
 * 段 9 の目的は移行の前提を測ることで、絵を作ることではない。既定の経路
 * （`?gpu=0`）には一切触れないので、基準画像 42 枚はこの spec の影響を受けない。
 *
 * `chromium-swiftshader` では WebGPU の起動引数が無いので `?gpu=2` は
 * WebGL2 へ落ちる。`chromium-webgpu` では落ちない。**その差そのものを検査する。**
 */
async function probe(page: import('@playwright/test').Page, query: string) {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto(`/dogfight/?${query}`)
  const handle = await page.waitForFunction(
    () => (window as unknown as { __dogfight?: TestHook }).__dogfight?.gpuProbe ?? null,
    undefined,
    { timeout: 120_000 },
  )
  return { result: (await handle.jsonValue()) as NonNullable<TestHook['gpuProbe']>, errors }
}

test.describe('node 経路', () => {
  test('?gpu=1 は WebGL2 バックエンドで立ち、glb を描く', async ({ page }) => {
    const { result, errors } = await probe(page, 'gpu=1')

    expect(result.backend).toBe('node-webgl')
    expect(result.fellBack).toBe(false)
    // **ここが false なら移行は総取り替えになる。**`three` と `three/webgpu` が
    // `three.core.js` を共有しているので、既存のローダがそのまま使える
    expect(result.sharedCore).toBe(true)
    // glb が実際にシーンへ入って描かれている
    expect(result.meshes).toBeGreaterThan(0)
    expect(result.drawCalls).toBeGreaterThan(0)
    expect(result.triangles).toBeGreaterThan(0)
    expect(result.programs).toBeGreaterThan(0)
    // **`ShaderMaterial` を入れていないから出ない。**1 枚入れて実測した
    // ところ、`THREE.NodeBuilder: Material "ShaderMaterial" is not
    // compatible.` がコンソールに 2 行出た。**例外にはならず描画は進む**ので、
    // 数と `errors` の両方で見張る
    expect(result.shaderMaterials).toBe(0)
    // **大気は組まない。**node 経路の WebGL2 バックエンドでは、大気の
    // 構造体が GLSL のコンパイルで落ちる（実測。`'AtmosphereParameters' :
    // syntax error`）。計画が退避路として当てにしていた `forceWebGL` は、
    // 大気には効かない
    expect(result.atmosphere).toBe(false)
    // 形状 64³・ディテール 32³・気象 512² を実際に焼いている
    expect(result.volumeMs).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  test('?gpu=2 の結果は起動引数で決まる', async ({ page }, testInfo) => {
    const hasWebGPU = testInfo.project.name === 'chromium-webgpu'
    const { result, errors } = await probe(page, 'gpu=2')

    expect(result.backend).toBe(hasWebGPU ? 'node-webgpu' : 'node-webgl')
    // 引数が無ければ adapter が取れず WebGL2 へ落ちる。**落ちても止まらない**
    expect(result.fellBack).toBe(!hasWebGPU)
    expect(result.shaderMaterials).toBe(0)
    expect(result.triangles).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  test('WebGPU なら大気まで組み、LUT を実行時に計算する', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-webgpu',
      'WebGPU の起動引数が要る',
    )
    const { result, errors } = await probe(page, 'gpu=2')

    expect(result.backend).toBe('node-webgpu')
    expect(result.atmosphere).toBe(true)
    // **4.1 MB の EXR を配らずに済むかは、この値で決まる。**実測 76 ms
    expect(result.lutMs).toBeGreaterThan(0)
    expect(result.lutMs).toBeLessThan(3_000)
    expect(result.lutScale).toBeGreaterThan(0)
    expect(errors).toEqual([])

    // **絵を見比べても分からない。**同じ時刻から同じ太陽が出ることを数値で
    // 確かめる。ずれていれば座標系の橋渡しがどこかで違っている。
    // 大気付きの WebGPU 起動は 2 分かかるので、同じ 1 回に相乗りさせる
    await page.goto('/dogfight/?capture=1&frame=0')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    const webglDeg = ((hook?.sunElevation ?? 0) * 180) / Math.PI
    expect(result.sunElevationDeg).toBeCloseTo(webglDeg, 6)
  })

  test('TSL のハッシュが CPU 参照とビット一致する', async ({ page }) => {
    // **ここが移行全体の決定論の土台。**PCG が 1 ビットずれたら、以降の
    // 雲の絵はすべて別物になる。`uint` の乗算は GLSL でも WGSL でも 2^32 で
    // 巻くので、仕様上は一致するはず。**「はず」を数値で確かめる**
    const { result, errors } = await probe(page, 'gpu=1')
    expect(errors).toEqual([])

    const expected = hashProbeExpected()
    const side = HASH_PROBE_SIDE
    expect(result.hashProbe.length).toBe(side * side * 4)

    const actual: number[] = []
    for (let i = 0; i < side * side; i++) {
      actual.push(
        result.hashProbe[i * 4]!,
        result.hashProbe[i * 4 + 1]!,
        result.hashProbe[i * 4 + 2]!,
      )
    }
    expect(actual).toEqual([...expected])
  })

  test('TSL のノイズが GLSL 版とビット一致する', async ({ page }) => {
    // 中央スライスの左下 16x16 を RGBA8 で 1,024 個。**統計だけでは
    // 1 ビットのずれが埋もれる**ので生バイトで比べる
    const { result, errors } = await probe(page, 'gpu=1')
    expect(errors).toEqual([])
    expect(result.noiseSlice.length).toBe(16 * 16 * 4)

    await page.goto('/dogfight/?capture=1&frame=0&noiseprobe=1')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    expect(hook?.noiseSlice?.length, 'GLSL 側が読み戻せていない').toBe(16 * 16 * 4)
    expect(result.noiseSlice).toEqual(hook?.noiseSlice)
  })

  test('TSL の気象マップが GLSL 版とビット一致する', async ({ page }) => {
    // **雲の配置を決めるのは 3D ノイズではなくこちら。**周期は 42 km で、
    // 影マップの一辺 30 km より長い。ずれると雲の湧く場所がまるごと変わる。
    // それでも雲影の分布（16 ビン）では捕まらないので、生バイトで比べる
    const { result, errors } = await probe(page, 'gpu=1')
    expect(errors).toEqual([])
    expect(result.weatherSlice.length).toBe(16 * 16 * 4)

    await page.goto('/dogfight/?capture=1&frame=0&noiseprobe=1')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    expect(hook?.weatherSlice?.length, 'GLSL 側が読み戻せていない').toBe(16 * 16 * 4)
    expect(result.weatherSlice).toEqual(hook?.weatherSlice)
  })

  test('WGSL でも GLSL 版とビット一致する', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-webgpu', 'WebGPU の起動引数が要る')
    const { result, errors } = await probe(page, 'gpu=2')
    expect(errors).toEqual([])

    // ハッシュ
    const expected = hashProbeExpected()
    const side = HASH_PROBE_SIDE
    const actual: number[] = []
    for (let i = 0; i < side * side; i++) {
      actual.push(
        result.hashProbe[i * 4]!,
        result.hashProbe[i * 4 + 1]!,
        result.hashProbe[i * 4 + 2]!,
      )
    }
    expect(actual, 'WGSL のハッシュが CPU 参照とずれた').toEqual([...expected])

    // ノイズ
    await page.goto('/dogfight/?capture=1&frame=0&noiseprobe=1')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    expect(result.noiseSlice, 'WGSL のノイズが GLSL 版とずれた').toEqual(
      hook?.noiseSlice,
    )
    expect(result.weatherSlice, 'WGSL の気象マップが GLSL 版とずれた').toEqual(
      hook?.weatherSlice,
    )
  })

  /**
   * GLSL 側で雲影を焼き、分布とその入力を取り出す。
   *
   * **入力ごと持ち帰る。**別の入力で焼いたものを比べると、一致しなかった
   * ときに移植の欠陥なのか入力の違いなのかが分からない
   */
  async function bakeShadowWithGlsl(page: import('@playwright/test').Page) {
    await page.goto(
      `/dogfight/?capture=1&script=level&frame=240&hour=16&coverage=${DEFAULT_COVERAGE}&shadowprobe=1`,
    )
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    const bins = hook?.shadowHistogram
    const tiles = hook?.shadowTiles
    const inputs = hook?.shadowInputs
    expect(bins, 'GLSL 側が影の分布を返していない').toBeTruthy()
    expect(tiles, 'GLSL 側が影の配置を返していない').toBeTruthy()
    expect(tiles!.length).toBe(SHADOW_TILES * SHADOW_TILES)
    expect(inputs, 'GLSL 側が影の入力を返していない').toBeTruthy()
    // **1 つのビンに寄っていたら比較が空回りする。**真っ白な影マップ
    // どうしは何を移植し間違えても一致する
    const nonEmpty = bins!.filter((v) => v > 0).length
    expect(nonEmpty, `ビンが ${nonEmpty} 個しか埋まっていない`).toBeGreaterThan(1)
    // 太陽が地平線の上にいないと影マップは全面 1 になる
    expect(inputs!.sunY, '太陽が地平線より下にいる').toBeGreaterThan(0.02)
    // 区画がすべて同じ値なら配置の検査が空回りする
    const spread = Math.max(...tiles!) - Math.min(...tiles!)
    expect(spread, `区画の差が ${spread} しかない`).toBeGreaterThan(0.01)
    return { bins: bins!, tiles: tiles!, inputs: inputs! }
  }

  test('TSL の雲影が GLSL 版と分布で一致する', async ({ page }) => {
    // **段 12 の合格条件。**16 ビンのヒストグラムで L1 距離 0.01 未満。
    // 密度は形状 64³ とディテール 32³ と気象 512² を引くので、この検査は
    // 3 つの体積が層まで正しく焼けていることも同時に見張る
    const { bins, tiles, inputs } = await bakeShadowWithGlsl(page)

    const { result, errors } = await probe(
      page,
      `gpu=1&shadowinputs=${encodeShadowInputs(inputs)}`,
    )
    expect(errors).toEqual([])
    expect(result.shadowHistogram, 'TSL 側が影を焼いていない').toBeTruthy()

    const distance = histogramL1(bins, result.shadowHistogram!)
    expect(distance, `L1 距離 ${distance}`).toBeLessThan(0.01)

    // **分布だけでは足りない。**ノイズの体積を上下反転しても、気象マップを
    // 上下反転しても、16 ビンの分布は 0.01 の内側に収まった（どちらも実測）。
    // 区画ごとの平均なら配置が効く
    expect(result.shadowTiles, 'TSL 側が影の配置を返していない').toBeTruthy()
    const worst = maxAbsDifference(tiles, result.shadowTiles!)
    expect(worst, `区画ごとの平均の最大のずれ ${worst}`).toBeLessThan(0.02)
  })

  test('入力が違えば雲影の分布は一致しない', async ({ page }) => {
    // **検査が働くことの確認。**同じ入力なら一致するという主張は、違う
    // 入力なら一致しないことを見せて初めて意味を持つ。雲量だけを 0 にする
    const { bins, tiles, inputs } = await bakeShadowWithGlsl(page)

    const { result } = await probe(
      page,
      `gpu=1&shadowinputs=${encodeShadowInputs({ ...inputs, coverage: 0 })}`,
    )
    const distance = histogramL1(bins, result.shadowHistogram!)
    expect(distance, `L1 距離 ${distance}`).toBeGreaterThan(0.01)
    const worst = maxAbsDifference(tiles, result.shadowTiles!)
    expect(worst, `区画ごとの平均の最大のずれ ${worst}`).toBeGreaterThan(0.02)
  })

  test('既定の経路は node を立てない', async ({ page }) => {
    await page.goto('/dogfight/?capture=1&frame=0')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    // **既定の絵には触らない。**`?gpu` を渡さなければ第 2 経路は動かない
    expect(hook?.gpuProbe).toBeNull()
    expect(hook?.backend).toBe('webgl')
  })
})
