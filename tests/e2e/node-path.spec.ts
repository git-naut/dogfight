import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { captureParams, SCENES } from './scenes.mjs'
import { hasWebGPU, type TestHook } from './harness'
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
import {
  SEABED_HEIGHT,
  TERRAIN_EXTENT,
  defaultTerrain,
} from '../../src/sim/terrain'
import { toneProbeExpected, toneProbeLevels } from '../../src/render/toneProbe'
import { NODE_REFERENCE as ref } from './nodeReference'
import * as skyReference from '../../src/render/sky/reference'
import {
  AERIAL_PROBE_CAMERA,
  AERIAL_PROBE_SUN,
  IRRADIANCE_PROBE_HEIGHT,
  IRRADIANCE_PROBE_WIDTH,
  SKY_PROBE_IRRADIANCE_TOLERANCE,
  SKY_PROBE_LUT_TOLERANCE,
  SKY_PROBE_SUN_MU,
  irradianceProbePoint,
  lutNormalizedError,
  screenRay,
} from '../../src/render/sky/skyProbe'
import { IRRADIANCE_TABLE } from '../../src/render/sky/irradianceTable'
import { OCEAN_MOMENT_TOLERANCE, OCEAN_PROBE_TOLERANCE, OCEAN_SURFACE_TOLERANCE } from '../../src/render/ocean/oceanProbe'
import {
  SURFACE_PROBE_SIDE,
  WATER_PROBE_REGIONS,
  surfaceBranchCounts,
  terrainPatchProbePoint,
  terrainPatchProbeValues,
} from '../../src/render/terrain/surfaceProbe'
import {
  OVERLAY_PROBE_COUNT,
  OVERLAY_PROBE_EARLY_COUNT,
  OVERLAY_PROBE_BASE_RATIO,
  OVERLAY_PROBE_LATE_COUNT,
  OVERLAY_PROBE_SIDE,
  overlayMarkerCounts,
  overlayProbeExpected,
} from '../../src/render/overlayProbe'
import {
  SPRITE_PROBE_SIDE,
  spriteDrawnPixels,
  spriteProbeCrossesCoreCut,
  spriteProbeExpected,
} from '../../src/render/weapons/spriteProbe'
import {
  HEIGHT_PROBE_COUNT,
  heightMaxError,
  heightProbePoint,
} from '../../src/render/terrain/heightProbe'
import { byteDifference } from '../../src/render/clouds/marchProbe'

/**
 * node 経路（`WebGPURenderer`）が立つことを確かめる。
 *
 * 段 9 の目的は移行の前提を測ることで、絵を作ることではない。自己診断
 * （`?gpu=1|2`）は固定入力のプローブ用の場面を描くので、基準画像はこの spec の
 * 影響を受けない。
 *
 * `?gpu=1` は `forceWebGL: true` で WebGL2 バックエンドへ落とし、`?gpu=2` は
 * WebGPU を要求する。**両方で同じ TSL が同じ値を出すことを検査する。**
 */
/**
 * プローブが結果を置くまでの待ち。
 *
 * **これは固まりの検出ではない。**固まりを見るのは e2e.yml の段の上限
 * （18 分）で、`playwright.config.ts` の注記もそう書いている。ここは
 * 「まだ描いている最中」と「もう来ない」を分けるだけ。
 *
 * 120 秒では足りなくなった。`RenderPipeline でポストの鎖が立つ` の実測は
 * 104.6 秒（run 34056675131）、116.2 秒（run 34100372031）、そして
 * run 34111954315 で 120 秒を超えて本番とリトライの両方が落ちた。
 * 直列の起動は 7.3 秒なので、伸びているぶんはほぼ競合。**シャードを
 * 所要で釣り合わせると重い物が同じ台に集まるので、さらに伸びる。**
 *
 * 300 秒にして直列比 40 倍、実測の最悪 116.2 秒に対して 2.6 倍を取る。
 */
const PROBE_TIMEOUT_MS = 300_000

/**
 * **突き合わせの相手（段 S1 で付け替えた）。**GLSL 経路を捨てたので、CPU に参照の
 * あるもの（スプライト・AgX・雲の合成・ハッシュ・高さ場）は CPU と、無いもの
 * （ノイズ・気象・雲影・マーチ・地表と海面・放射輝度・半透明の画素数）は GLSL の
 * 最後の出力の記録（`nodeReference.ts`）と比べる。記録が GLSL の写しであることは、
 * GLSL が残っていた段 S1a の CI（7723c7c）で確かめた
 */
/**
 * TSL の地表と海面を記録と比べる。**枝の数は整数なので一致、色は階調 1 まで**
 * （GLSL と比べていたときと同じ許容。WGSL は演算順序が動きうる）
 */
function expectSurfaceMatchesReference(surface: {
  terrain: number[]
  terrainBranches: number[]
  water: number[][]
  waterBranches: number[][]
}) {
  expect(surfaceBranchCounts(surface.terrainBranches), '地表の枝が記録と違う').toEqual(
    surfaceBranchCounts(ref.surface.terrainBranches),
  )
  const terrain = byteDifference(ref.surface.terrain, surface.terrain)
  expect(terrain.max, `記録との地表の最大差 ${terrain.max}（違うバイト ${terrain.differing}）`)
    .toBeLessThanOrEqual(1)
  for (let i = 0; i < WATER_PROBE_REGIONS.length; i++) {
    expect(surfaceBranchCounts(surface.waterBranches[i]!), `海面 ${i} の枝が記録と違う`).toEqual(
      surfaceBranchCounts(ref.surface.waterBranches[i]!),
    )
    const d = byteDifference(ref.surface.water[i]!, surface.water[i]!)
    expect(d.max, `記録との海面 ${i} の最大差 ${d.max}（違うバイト ${d.differing}）`)
      .toBeLessThanOrEqual(1)
  }
}

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
    { timeout: PROBE_TIMEOUT_MS },
  )
  return { result: (await handle.jsonValue()) as NonNullable<TestHook['gpuProbe']>, errors }
}

test.describe('node 経路', () => {
  // 1 テストの制限をこの spec だけ上げる。**`mode` は渡さない。**
  // `_configure` は `mode` を渡したときだけ `_parallelMode` を書くので、
  // `timeout` だけなら群の作り方（1 テストずつ）は変わらず、
  // `PWTEST_SHARD_WEIGHTS` の前提も崩れない
  test.describe.configure({ timeout: 420_000 })

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

  test('?gpu=2 の結果は起動引数で決まる', async ({ page }) => {
    // **判定は project が宣言する。**名前で見ていたので、同じ引数で走る
    // `chromium-node` を「WebGPU が無い」と読んで落ちた（2026-09-14）
    const webgpu = hasWebGPU()
    const { result, errors } = await probe(page, 'gpu=2')

    expect(result.backend).toBe(webgpu ? 'node-webgpu' : 'node-webgl')
    // 引数が無ければ adapter が取れず WebGL2 へ落ちる。**落ちても止まらない**
    expect(result.fellBack).toBe(!webgpu)
    expect(result.shaderMaterials).toBe(0)
    expect(result.triangles).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  test('WebGPU なら空まで組み、LUT を実行時に焼く', async ({ page }) => {
    test.skip(
      !hasWebGPU(),
      'WebGPU の起動引数が要る',
    )
    const { result, errors } = await probe(page, 'gpu=2')

    expect(result.backend).toBe('node-webgpu')
    expect(result.atmosphere).toBe(true)
    // 自前の空（段 S2b-2）を組む時間。起動時に透過率と多重散乱の LUT を焼く。
    // takram の LUT の計算（段 10、実測 76 ms）と同じく 3 秒を上限にする
    expect(result.lutMs).toBeGreaterThan(0)
    expect(result.lutMs).toBeLessThan(3_000)
    expect(errors).toEqual([])

    // **絵を見比べても分からない。**同じ時刻から同じ太陽が出ることを数値で
    // 確かめる。相手は GLSL 経路（takram の GLSL 版）が最後に出した値の記録。
    // 段 S2b-2 で太陽の式を自前（NOAA、`sky/solar.ts`）に替えたので、小数 6 桁の
    // 一致から、太陽の式の検査（`tests/render/solar.test.ts`）と同じ 0.02 度に改めた
    const recorded = (ref.sunElevation * 180) / Math.PI
    expect(Math.abs(result.sunElevationDeg - recorded)).toBeLessThanOrEqual(0.02)
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

  test('TSL のノイズが GLSL の記録とビット一致する', async ({ page }) => {
    // 中央スライスの左下 16x16 を RGBA8 で 1,024 個。**統計だけでは
    // 1 ビットのずれが埋もれる**ので生バイトで比べる
    const { result, errors } = await probe(page, 'gpu=1')
    expect(errors).toEqual([])
    expect(result.noiseSlice.length).toBe(16 * 16 * 4)
    expect(result.noiseSlice, 'TSL のノイズが記録とずれた').toEqual(ref.noiseSlice)
  })

  test('TSL の気象マップが GLSL の記録とビット一致する', async ({ page }) => {
    // **雲の配置を決めるのは 3D ノイズではなくこちら。**周期は 42 km で、
    // 影マップの一辺 30 km より長い。ずれると雲の湧く場所がまるごと変わる。
    // それでも雲影の分布（16 ビン）では捕まらないので、生バイトで比べる
    const { result, errors } = await probe(page, 'gpu=1')
    expect(errors).toEqual([])
    expect(result.weatherSlice.length).toBe(16 * 16 * 4)
    expect(result.weatherSlice, 'TSL の気象マップが記録とずれた').toEqual(ref.weatherSlice)
  })

  test('WGSL でも GLSL の記録とビット一致する', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    const { result, errors } = await probe(
      page,
      'gpu=2&marchprobe=1&heightprobe=1&spriteprobe=1',
    )
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

    // ノイズと気象マップ。相手は GLSL の最後の出力の記録
    expect(result.noiseSlice, 'WGSL のノイズが記録とずれた').toEqual(ref.noiseSlice)
    expect(result.weatherSlice, 'WGSL の気象マップが記録とずれた').toEqual(ref.weatherSlice)

    // **歩き方は整数で比べられる。**WGSL でもループと分岐が同じなら
    // 密度サンプル数が完全に一致するはず
    expect(result.march, 'WGSL 側がマーチを焼いていない').toBeTruthy()
    expect(result.march!.samples, 'WGSL のマーチの歩き方が記録とずれた').toEqual(ref.march.samples)
    expect(result.march!.exhausted, 'WGSL の打ち切りの数が記録とずれた').toBe(ref.march.exhausted)
    // **足し込みのバイト一致は基準から外した（2026-09-14）。**引き方を
    // `TextureNode.setupUV()` に任せたので、素の GLSL で `vUv` を引く側とは
    // 揃わない（実測で 36,864 中 26,763 個・最大 181。**絵はほとんど
    // 変わらない**ことを `tools/cloud-live.mjs` で確かめた）。
    // 足し込みが働いていることは `resolveChanged` が見る

    // 高さ場。突き合わせる相手は sim の `heightAt` そのもの
    expect(result.heightProbe, 'WGSL 側が高さ場を引いていない').toBeTruthy()
    const terrain = defaultTerrain()
    const expectedHeights = Array.from({ length: HEIGHT_PROBE_COUNT }, (_, i) => {
      const p = heightProbePoint(i)
      return terrain.heightAt(p.x, p.z)
    })
    const heightWorst = heightMaxError(expectedHeights, result.heightProbe!)
    expect(
      heightWorst,
      `WGSL の高さ場の最大のずれ ${heightWorst} m`,
    ).toBeLessThan(1e-2)

    // 円形スプライト。相手は CPU 参照。**WGSL は演算順序が変わるのでバイト
    // 一致は求めない**
    expect(result.sprite, 'WGSL 側がスプライトを焼いていない').toBeTruthy()
    for (const [key, opaqueCore] of [
      ['soft', false],
      ['core', true],
    ] as const) {
      const d = byteDifference(spriteProbeExpected(opaqueCore), result.sprite![key])
      expect(d.max, `WGSL のスプライト（${key}）と CPU 参照の最大差 ${d.max}`).toBeLessThanOrEqual(1)
    }
  })

  test('TSL の雲影が GLSL の記録と分布で一致する', async ({ page }) => {
    // **段 12 の合格条件。**16 ビンのヒストグラムで L1 距離 0.01 未満。
    // 密度は形状 64³ とディテール 32³ と気象 512² を引くので、この検査は
    // 3 つの体積が層まで正しく焼けていることも同時に見張る。
    //
    // **入力ごと記録から取る。**別の入力で焼いたものを比べると、一致しなかった
    // ときに移植の欠陥なのか入力の違いなのかが分からない。記録が空回りしない
    // こと（ビンが散っている・太陽が地平線の上）は `nodeReference.test.ts` が見る
    const { result, errors } = await probe(
      page,
      `gpu=1&shadowinputs=${encodeShadowInputs(ref.shadow.inputs)}`,
    )
    expect(errors).toEqual([])
    expect(result.shadowHistogram, 'TSL 側が影を焼いていない').toBeTruthy()

    const distance = histogramL1(ref.shadow.bins, result.shadowHistogram!)
    expect(distance, `L1 距離 ${distance}`).toBeLessThan(0.01)

    // **分布だけでは足りない。**ノイズの体積を上下反転しても、気象マップを
    // 上下反転しても、16 ビンの分布は 0.01 の内側に収まった（どちらも実測）。
    // 区画ごとの平均なら配置が効く
    expect(result.shadowTiles, 'TSL 側が影の配置を返していない').toBeTruthy()
    expect(result.shadowTiles!.length).toBe(SHADOW_TILES * SHADOW_TILES)
    const worst = maxAbsDifference(ref.shadow.tiles, result.shadowTiles!)
    expect(worst, `区画ごとの平均の最大のずれ ${worst}`).toBeLessThan(0.02)
  })

  test('入力が違えば雲影の分布は一致しない', async ({ page }) => {
    // **検査が働くことの確認。**同じ入力なら一致するという主張は、違う
    // 入力なら一致しないことを見せて初めて意味を持つ。雲量だけを 0 にする
    const { result } = await probe(
      page,
      `gpu=1&shadowinputs=${encodeShadowInputs({ ...ref.shadow.inputs, coverage: 0 })}`,
    )
    const distance = histogramL1(ref.shadow.bins, result.shadowHistogram!)
    expect(distance, `L1 距離 ${distance}`).toBeGreaterThan(0.01)
    const worst = maxAbsDifference(ref.shadow.tiles, result.shadowTiles!)
    expect(worst, `区画ごとの平均の最大のずれ ${worst}`).toBeGreaterThan(0.02)
  })

  test('TSL のマーチが GLSL の記録と同じ歩き方をする', async ({ page }) => {
    // **段 13 の合格条件。**固定のカメラと固定の入力で焼く。密度サンプル数と
    // 打ち切りの数は整数なので、ループと分岐が同じなら完全に一致するはず。
    // 絵は浮動小数の演算順序で動くので区画平均で見る。
    //
    // 相手は GLSL の最後の出力の記録。**通っていない枝は検査されない**ので、
    // 記録が歩数を使い切る枝と透過率で抜ける枝の両方を通り、雲が視野いっぱいに
    // あることは `nodeReference.test.ts` が見る（下限はすべて実測から取った）
    const { result, errors } = await probe(page, 'gpu=1&marchprobe=1')
    expect(errors).toEqual([])
    expect(result.march, 'TSL 側がマーチを焼いていない').toBeTruthy()

    // 整数どうし。1 でも違えば歩き方が違う
    expect(result.march!.samples, '密度サンプル数が記録とずれた').toEqual(ref.march.samples)
    expect(result.march!.exhausted, '打ち切りの数が記録とずれた').toBe(ref.march.exhausted)

    const worst = maxAbsDifference(ref.march.tiles, result.march!.tiles)
    expect(worst, `区画ごとの平均の最大のずれ ${worst}`).toBeLessThan(0.02)

    // ---- 時間方向の足し込み ----
    //
    // 入力（ずらしを変えたマーチ 2 枚）は上で一致を確かめた経路そのもの。
    // **履歴を読む枝を通っていること**を見張る。再投影が全部外れていても
    // 足し込みの結果は現フレームと同じになるだけで、落ちる検査が他に無い
    expect(result.march!.resolveChanged, '足し込みが現フレームを動かしていない')
      .toBeGreaterThan(1000)
    // **足し込みのバイト一致は基準から外した（2026-09-14）。**引き方を
    // `TextureNode.setupUV()` に任せたので、素の GLSL で `vUv` を引く側とは
    // バイトが揃わない（実測で 36,864 バイト中 26,763 個・最大 181。**絵は
    // ほとんど変わらない**ことを `tools/cloud-live.mjs` で確かめた）。
    //
    // ---- `prevUv` を数値で突き合わせる ----
    //
    // **絵の印象では座標のずれが読めない。**上下反転の切り分けで何度も
    // 外した（2026-09-14）。`prevUv` を色として焼き、記録とバイトを比べる。
    // RG に uv、B に「画面内か」が入る
    const recorded = ref.march.resolveUv
    const uvDiff = byteDifference(recorded, result.march!.resolveUv)
    // eslint-disable-next-line no-console
    console.log(`[prevUv] 違う ${uvDiff.differing} / 最大 ${uvDiff.max}`)
    // **チャンネル別に見る。**R=u、G=v、B=画面内か。どれがずれているかで
    // 原因が分かれる（座標そのものか、判定の枝か）
    const perChannel = [0, 1, 2].map((c) => {
      let n = 0
      let max = 0
      for (let i = c; i < recorded.length; i += 4) {
        const d = Math.abs(recorded[i]! - result.march!.resolveUv[i]!)
        if (d > 0) n++
        if (d > max) max = d
      }
      return { n, max }
    })
    expect(
      uvDiff.max,
      `再投影の座標が記録とずれる。` +
        `u=${perChannel[0]!.n}個/最大${perChannel[0]!.max} ` +
        `v=${perChannel[1]!.n}個/最大${perChannel[1]!.max} ` +
        `画面内=${perChannel[2]!.n}個/最大${perChannel[2]!.max}`,
    ).toBeLessThanOrEqual(2)
  })

  test('TSL の高さ場が sim の高さと一致する', async ({ page }) => {
    // **段 14 の合格条件。**「見えている山と当たる山が違う」を機械で止める。
    // 突き合わせる相手は GLSL 版ではなく `src/sim/terrain.ts` そのもの
    const { result, errors } = await probe(page, 'gpu=1&heightprobe=1')
    expect(errors).toEqual([])
    expect(result.heightProbe, 'TSL 側が高さ場を引いていない').toBeTruthy()
    expect(result.heightProbe!.length).toBe(HEIGHT_PROBE_COUNT)

    const terrain = defaultTerrain()
    const expected = Array.from({ length: HEIGHT_PROBE_COUNT }, (_, i) => {
      const p = heightProbePoint(i)
      return terrain.heightAt(p.x, p.z)
    })

    // **平らな海底ばかりを引いていないこと。**双三次を間違えても一致する
    const land = expected.filter((h) => h > 0).length
    const varied = expected.filter((h) => Math.abs(h - SEABED_HEIGHT) > 0.5).length
    expect(land, `陸地の標本が ${land} 点しかない`).toBeGreaterThan(20)
    expect(varied, `平らでない標本が ${varied} 点しかない`).toBeGreaterThan(40)
    expect(Math.max(...expected), '高い山を通っていない').toBeGreaterThan(1000)
    // **縁の外を通っていること。**止める処理はここでしか通らない
    const half = TERRAIN_EXTENT / 2
    const outside = Array.from({ length: HEIGHT_PROBE_COUNT }, (_, i) =>
      heightProbePoint(i),
    ).filter((p) => Math.abs(p.x) > half || Math.abs(p.z) > half).length
    expect(outside, `範囲の外の標本が ${outside} 点しかない`).toBeGreaterThan(4)

    // **1e-3 m には収まらない。**計画はそこを合格条件に置いていたが、
    // GPU は float32 で解く。CPU 側の式を `Math.fround` で float32 に丸める
    // だけで最大 1.03 mm ずれることを測った。実測のずれは 4.5 mm で、
    // 高さ 2,050 m に対して相対 2.2e-6（float32 の 18 ulp ぶん）。
    // **移植を間違えれば m の単位で外れる**ので、1 cm を関門にする
    const worst = heightMaxError(expected, result.heightProbe!)
    expect(worst, `最大のずれ ${worst} m`).toBeLessThan(1e-2)
  })

  /**
   * **自前の空（段 S2a）。**Hillaire の 3 つの LUT と天空光を GPU で焼き、CPU 参照
   * （`src/render/sky/reference.ts`）と比べる。光の強さそのもの（正解との関門）は
   * vitest（`tests/render/skyTruth.test.ts`）が CPU 参照の側で見るので、ここは
   * 「GPU が CPU 参照と同じ値を出す」だけを見る。
   *
   * 許容は各色の LUT の最大値に対する差で 2e-3、天空光は相対 1e-3（ユーザーの決定、
   * 2026-10-26。理由は `sky/skyProbe.ts`）。実測は透過率 5.5e-4、多重散乱 1.4e-3、
   * 空の見え方 5.9e-4、天空光 3.5e-4
   */
  async function expectSkyMatchesReference(page: Page, gpu: 1 | 2) {
    const { result, errors } = await probe(page, `gpu=${gpu}&skyprobe=1`)
    expect(errors).toEqual([])
    const sky = result.sky
    expect(sky, '自前の空を焼いていない').toBeTruthy()

    const transmittance = skyReference.buildTransmittanceTable()
    const multiscatter = skyReference.buildMultiscatterTable(transmittance)
    const skyView = skyReference.buildSkyViewTable(transmittance, multiscatter, 0, SKY_PROBE_SUN_MU)
    expect(sky!.transmittance.length).toBe(transmittance.width * transmittance.height * 4)
    expect(sky!.multiscatter.length).toBe(multiscatter.width * multiscatter.height * 4)
    expect(sky!.skyView.length).toBe(skyView.width * skyView.height * 4)

    for (const [label, gpuTable, cpuTable] of [
      ['透過率', sky!.transmittance, transmittance],
      ['多重散乱', sky!.multiscatter, multiscatter],
      ['空の見え方', sky!.skyView, skyView],
    ] as const) {
      const error = lutNormalizedError(gpuTable, cpuTable)
      // eslint-disable-next-line no-console
      console.log(`[空 gpu=${gpu}] ${label} 最大値に対する差 ${error.toExponential(2)}`)
      expect(error, `${label}の差 ${error.toExponential(2)}`).toBeLessThanOrEqual(SKY_PROBE_LUT_TOLERANCE)
      // **向きを取り違えたら落ちること。**上下が逆でも一致するなら、比べ方が空回りしている
      expect(lutNormalizedError(gpuTable, cpuTable, false), `${label}の向きの検査に歯がない`).toBeGreaterThan(0.1)
    }

    // LUT を引いて半球で足した天空光。**LUT の引き方（v の向き）の誤りはここで出る。**
    // 焼いた LUT が正しくても、引くときに上下を取り違えると天空光がずれる
    const cpu = skyReference.skyIrradianceOverPi(transmittance, multiscatter, SKY_PROBE_SUN_MU)
    for (let c = 0; c < 3; c++) {
      const ratio = sky!.irradianceOverPi[c]! / cpu[c]!
      expect(Math.abs(ratio - 1), `天空光の色 ${c} の GPU/CPU ${ratio.toFixed(5)}`).toBeLessThanOrEqual(
        SKY_PROBE_IRRADIANCE_TOLERANCE,
      )
    }

    // ---- 段 S2b ----
    // 同梱の照度の表を GPU で引いた格子。場面の地形・海・雲の天空光はこの引き方で決まる。
    // **表の行の向き（`DataTexture` は v を裏返さない）の誤りはここで出る**
    const shipped = {
      width: skyReference.IRRADIANCE_WIDTH,
      height: skyReference.IRRADIANCE_HEIGHT,
      data: Float64Array.from(IRRADIANCE_TABLE),
    }
    const grid = skyReference.buildTable(IRRADIANCE_PROBE_WIDTH, IRRADIANCE_PROBE_HEIGHT, (x, y) => {
      const p = irradianceProbePoint(x, y)
      return skyReference.sampleIrradiance(shipped, p.sunMu, p.altitude)
    })

    // 霞のアトラス。焼いたカメラの行列から CPU が同じ視線を作る。**画面の上下の約束を
    // 取り違えると、地面へ向く視線と空へ向く視線が入れ替わって桁で外れる**
    const cam = sky!.aerialCamera
    const altitude = AERIAL_PROBE_CAMERA.position[1] / 1000
    const width = skyReference.AERIAL_SIZE * skyReference.AERIAL_SLICES
    const aerialOf = (x: number, y: number) => {
      const slice = Math.floor(x / skyReference.AERIAL_SIZE)
      const cx = x % skyReference.AERIAL_SIZE
      const dir = screenRay(
        (cx + 0.5) / skyReference.AERIAL_SIZE,
        (y + 0.5) / skyReference.AERIAL_SIZE,
        cam.projectionInverse,
        cam.cameraWorld,
      )
      return skyReference.aerialPerspective(
        transmittance,
        multiscatter,
        altitude,
        dir,
        AERIAL_PROBE_SUN,
        skyReference.aerialSliceDistance(slice),
      )
    }
    // CPU の表の行 y は LUT の uv の行 y で、画面の上から y 番目（焼く側と引く側が同じ
    // `screenUV` の約束を使う）。読み戻しの行との裏返しは `lutNormalizedError` が持つ
    const rows = skyReference.AERIAL_SIZE
    const inscatter = skyReference.buildTable(width, rows, (x, y) => aerialOf(x, y).inscatter)
    const trans = skyReference.buildTable(width, rows, (x, y) => aerialOf(x, y).transmittance)

    for (const [label, gpuTable, cpuTable] of [
      ['照度の表の格子', sky!.irradianceGrid, grid],
      ['霞の入る光', sky!.aerialInscatter, inscatter],
      ['霞の透過率', sky!.aerialTransmittance, trans],
    ] as const) {
      expect(gpuTable.length).toBe(cpuTable.width * cpuTable.height * 4)
      const error = lutNormalizedError(gpuTable, cpuTable)
      // eslint-disable-next-line no-console
      console.log(`[空 gpu=${gpu}] ${label} 最大値に対する差 ${error.toExponential(2)}`)
      expect(error, `${label}の差 ${error.toExponential(2)}`).toBeLessThanOrEqual(SKY_PROBE_LUT_TOLERANCE)
      expect(lutNormalizedError(gpuTable, cpuTable, false), `${label}の向きの検査に歯がない`).toBeGreaterThan(0.1)
    }
  }

  /**
   * **FFT の海（段 S3）。**全カスケード 256² を GPU で解き、ページの中で CPU 参照
   * （`src/render/ocean/reference.ts`）と比べた要約を読む（場が大きく、JSON で取り出せない）。
   * 許容は各カスケード・各成分の最大値に対する差で 1e-4（ユーザーの決定）。2026-10-28 の
   * 実測は最大 4.1e-6。WebGL2 の組み立てに共有メモリが無いので WebGPU だけで流す
   */
  test('FFT の海が CPU 参照と一致する', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    const { result, errors } = await probe(page, 'gpu=2&oceanprobe=1')
    expect(errors).toEqual([])
    const ocean = result.ocean
    expect(ocean, '海を解いていない').toBeTruthy()
    const count = 6 * 256 * 256
    expect(ocean!.lengths).toEqual({
      h0: count * 4,
      frequencyIndex: count,
      specA: count * 4,
      specB: count * 4,
      displacement: count * 4,
      derivatives: count * 4,
    })
    // 周波数の番号の食い違いは、32 ビットの丸めで境目をまたいだものだけ（実測 644 個）
    expect(ocean!.index.unexplained, JSON.stringify(ocean!.index)).toBe(0)
    for (const key of ['h0', 'specA', 'specB', 'displacement', 'derivatives'] as const) {
      // eslint-disable-next-line no-console
      console.log(`[海] ${key} 最大値に対する差 ${ocean![key].toExponential(2)}`)
      expect(ocean![key], `${key}（最大の要素 ${JSON.stringify(ocean!.worst[key])}）`).toBeLessThanOrEqual(
        OCEAN_PROBE_TOLERANCE,
      )
    }
    // **向きを取り違えたら落ちること。**x と y を入れ替えても一致するなら比べ方が空回り
    expect(ocean!.displacementTransposed, '向きの検査に歯がない').toBeGreaterThan(0.1)

    // **海面のテクスチャ（段 S4a-1）。**変位をミップ付きのテクスチャへ写し、頂点シェーダと
    // 同じ引き方（`oceanCascadeLod`・`oceanUvOffset`）で引いた値を CPU 参照と比べる
    // eslint-disable-next-line no-console
    console.log(`[海面] float32-filterable ${ocean!.float32Filterable} ${JSON.stringify(ocean!.surface)}`)
    // eslint-disable-next-line no-console
    console.log(`[海面] 1 回の所要 ${JSON.stringify(ocean!.surfaceCost)}`)

    // **泡（段 S4a-2）。**前から 16 回回した泡を 2 回作り、ビット単位で一致すること（キャプチャの
    // 決定論）。穏やかな海でも泡が出ていること（2026-10-29 の実測で 3.2%、J の最小 0.33）
    const foam = ocean!.surfaceCost.foam
    // high の泡（2 段 × 512²、品質表の `oceanFoamLevels`・`oceanFoamResolution`）
    expect(foam.texels, '泡のクリップマップの大きさ').toBe(2 * 512 * 512)
    expect(foam.differing, '同じ手順で作った泡が食い違う').toBe(0)
    expect(foam.covered, '泡が出ていない').toBeGreaterThan(0.005)
    expect(foam.covered, '泡が出すぎている').toBeLessThan(0.2)
    expect(foam.minJ, '面が畳まれる所が無い（J の閾値 0.68）').toBeLessThan(0.68)
    for (const precision of ['16', '32'] as const) {
      for (const span of ['far', 'near', 'momentsFar', 'momentsNear'] as const) {
        const s = ocean!.surface[precision][span]
        // LEAN のモーメント（段 S4a-2）は 2 乗の量なので 16 ビットの丸めが大きく残る
        const tolerance =
          span === 'far'
            ? OCEAN_SURFACE_TOLERANCE.far
            : span === 'near'
              ? OCEAN_SURFACE_TOLERANCE.near[precision]
              : span === 'momentsFar'
                ? OCEAN_MOMENT_TOLERANCE.far
                : OCEAN_MOMENT_TOLERANCE.near[precision]
        expect(s.error, `${precision} ビット・${span} の差（間隔ごと ${JSON.stringify(s.byCell)}）`).toBeLessThanOrEqual(tolerance)
        expect(s.skipped, '足さないカスケードが無い（粗い段の検査が空回り）').toBeGreaterThan(0)
        expect(s.transposed, `${precision} ビット・${span} の向きの検査に歯がない`).toBeGreaterThan(0.1)
      }
    }
  })

  /**
   * **FFT の海面は同じフレームを 2 回撮ると画素が一致する**（段 S4a-2）。
   *
   * 泡は履歴を持つので、キャプチャは前から 4 フレーム刻みで 16 回回して作る（S4a-2 の合意）。
   * ページを開き直して同じフレームを撮り、1 画素も動かないことを見る。泡の状態そのものの一致は
   * 「FFT の海が CPU 参照と一致する」が記憶域で見ている。ここは描画まで含めた決定論
   */
  test('FFT の海面は同じフレームを 2 回撮ると画素が一致する', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    test.setTimeout(900_000)
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 200))
    })
    const scene = SCENES.find((sc: { name: string }) => sc.name === 'low-pass-afternoon')!
    const shoot = async () => {
      const params = captureParams(scene)
      params.set('ocean', '1')
      await page.goto(`/dogfight/?${params.toString()}`)
      await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 600_000 })
      // 前から回した海の仕事が GPU に残っていると、撮る処理がそれを待つ（SwiftShader で数十秒）
      return PNG.sync.read(await page.locator('#viewport').screenshot({ timeout: 300_000 }))
    }
    const a = await shoot()
    const b = await shoot()
    let differing = 0
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differing++
    }
    expect(differing, `2 回撮って ${differing} 画素が動いた`).toBe(0)
    expect(errors).toEqual([])
  })

  test('TSL の自前の空が CPU 参照と一致する', async ({ page }) => {
    await expectSkyMatchesReference(page, 1)
  })

  test('WGSL でも自前の空が CPU 参照と一致する', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    await expectSkyMatchesReference(page, 2)
  })

  test('node 経路で影が立ち、影マップは 1 回しか焼かれない', async ({ page }) => {
    // **段 15。**`BasicShadowMap` を選んだ理由（比較モードが付くと自前 GLSL の
    // `sampler2D` から読めない）は node 経路では消える。プリセットの
    // `shadowFilter` をそのまま渡して、立つことと回数を測る
    const { result, errors } = await probe(page, 'gpu=1&nodeshadow=1&preset=high')
    expect(errors).toEqual([])
    const shadow = result.nodeShadow
    expect(shadow, 'node 経路の影を測っていない').toBeTruthy()
    expect(shadow!.filter, 'high のフィルタ').toBe('pcf')
    expect(shadow!.casters, '影の投げ手が居ない').toBeGreaterThan(0)

    // **焼き込みは 1 フレームに 1 回。**パスの数で見る。ドローコールでは
    // 視錐台の切り方の違いが混ざって当てにならない（機体の 31 回に対して
    // 影のパスは 47 回だった。実測）
    // **影マップの回数は「投げ手あり」と「投げ手なし」の差で見る。**
    // 有効にするだけでパスが 1 つ増える経路がある（WebGPU 側。実測）ので、
    // 無効との差で数えると 2 回焼いていると読み違える
    const bakes = shadow!.frameCallsWith - shadow!.frameCallsEnabledNoCaster
    expect(
      bakes,
      `影マップのパスが ${bakes} 回（無効 ${shadow!.frameCallsWithout} / 投げ手なし ${shadow!.frameCallsEnabledNoCaster} / あり ${shadow!.frameCallsWith}）`,
    ).toBe(1)
    // node 経路の WebGL2 では、有効にするだけでは増えない
    expect(
      shadow!.frameCallsEnabledNoCaster - shadow!.frameCallsWithout,
      '投げ手が無いのにパスが増えた',
    ).toBe(0)
    // 2 枚目でも同じ。積算していれば増える
    expect(shadow!.frameCallsSecond, '2 枚目でパスの数が変わった').toBe(
      shadow!.frameCallsWith,
    )
    // 影のパスがドローコールを払っていること
    const added = shadow!.drawCallsWith - shadow!.drawCallsWithout
    expect(added, `影で増えたドローコール ${added}`).toBeGreaterThan(0)

    // **絵が変わっていること。**係数が常に 1 なら影は出ていない。
    // 区画平均では鈍すぎる（1280x720 を 4x4 に均すと 0.0003 しか動かない）
    expect(shadow!.changed, `影で動いたバイトが ${shadow!.changed} 個`)
      .toBeGreaterThan(1000)
    expect(shadow!.changedMax, `最大の差が ${shadow!.changedMax}`)
      .toBeGreaterThan(20)
  })

  test('WebGPU で ultra の影マップが 1 パスで焼かれる', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    // もとは `pcfSoft` が node 経路で通ることを見ていた。**three 0.186 で
    // `PCFSoftShadowMap` が `WebGPURenderer` から無くなった**ので、ultra の
    // 列を `pcf` へ倒した（`quality.ts` の `ShadowFilter`）。パスの回数と
    // 動いたバイトを見る部分はそのまま価値があるので残す
    const { result, errors } = await probe(page, 'gpu=2&nodeshadow=1&preset=ultra')
    expect(errors).toEqual([])
    expect(result.nodeShadow!.filter).toBe('pcf')
    const n = result.nodeShadow!
    // 影マップは 1 パス。投げ手なしとの差で数える
    const bakes = n.frameCallsWith - n.frameCallsEnabledNoCaster
    expect(
      bakes,
      `ultra の影マップのパスが ${bakes} 回（なし ${n.frameCallsWithout} / 投げ手なし ${n.frameCallsEnabledNoCaster} / あり ${n.frameCallsWith}）`,
    ).toBe(1)
    // **有効にするだけではパスが増えない。**段 S2b-2 まで、WebGPU では有効に
    // するだけで投げ手が無くてもパスが 1 つ増えていた（原因は未特定のまま値を
    // 固定していた）。takram を外したら 0 になったので、足していたのは takram の
    // 側だったと見ている（推測）。値は固定のまま、変わったら気づけるようにしておく
    expect(
      n.frameCallsEnabledNoCaster - n.frameCallsWithout,
      '有効にするだけで増えるパスの数が変わった',
    ).toBe(0)
    expect(
      result.nodeShadow!.changed,
      `ultra で動いたバイトが ${result.nodeShadow!.changed} 個`,
    ).toBeGreaterThan(1000)
  })

  test('TSL の円形スプライトが CPU 参照とバイト一致する', async ({ page }) => {
    // **段 16。**爆発とフレアの断片は `vUv` だけの関数なので、場面を組まずに
    // 全画面のクアッドへ焼いて比べられる。`#ifdef OPAQUE_CORE` は GLSL 版で
    // リポジトリ唯一の `defines` だったもので、TSL では JS の分岐になる。
    // 相手の CPU 参照は GLSL の最後の出力とバイトで一致する（vitest の
    // `nodeReference.test.ts`）
    const { result, errors } = await probe(page, 'gpu=1&spriteprobe=1')
    expect(errors).toEqual([])
    expect(result.sprite, 'TSL 側がスプライトを焼いていない').toBeTruthy()

    const expectedSoft = spriteProbeExpected(false)
    const expectedCore = spriteProbeExpected(true)
    // **捨てられた画素ばかりでないこと。**全部 discard なら空どうしで一致する
    const pixels = SPRITE_PROBE_SIDE * SPRITE_PROBE_SIDE
    const drawnSoft = spriteDrawnPixels(expectedSoft)
    const drawnCore = spriteDrawnPixels(expectedCore)
    expect(drawnSoft, `暈の描かれた画素 ${drawnSoft}`).toBeGreaterThan(pixels / 4)
    expect(drawnCore, `芯の描かれた画素 ${drawnCore}`).toBeGreaterThan(100)
    // **芯は暈より狭いこと。**同じなら `OPAQUE_CORE` の枝が効いていない
    expect(drawnCore, '芯が暈と同じ広さ').toBeLessThan(drawnSoft)
    expect(spriteProbeCrossesCoreCut(), '濃さが CORE_CUT を跨いでいない').toBe(true)

    const soft = byteDifference(expectedSoft, result.sprite!.soft)
    expect(soft.differing, `暈で違うバイトが ${soft.differing} 個（最大差 ${soft.max}）`).toBe(0)
    const core = byteDifference(expectedCore, result.sprite!.core)
    expect(core.differing, `芯で違うバイトが ${core.differing} 個（最大差 ${core.max}）`).toBe(0)
  })

  test('TSL の AgX が CPU 参照と一致し、露出 6 が持ち越せる', async ({ page }) => {
    // **段 17 の入口。**計画は「AgX は式が同じで露出 6 はそのまま持ち越せる」と
    // 書いていた。持ち越せるなら VFX の色定数を測り直さずに済む。当時は
    // three の GLSL 版（`AgXToneMapping`）と TSL 版を比べ、段 S1 で相手を
    // GLSL 版の写しの CPU 参照（`agxToneMap`）へ替えた
    const { result, errors } = await probe(page, 'gpu=1&toneprobe=1')
    expect(errors).toEqual([])
    expect(result.tone, 'TSL 側がトーンマッピングを焼いていない').toBeTruthy()

    const expected = toneProbeExpected()
    // **階調を使い切っていること。**全部 0 か全部 255 なら曲線を
    // 間違えても一致する
    const levels = toneProbeLevels(expected)
    expect(levels, `階調が ${levels} 段しかない`).toBeGreaterThan(100)
    // **AgX は暗部を持ち上げる。**10^-3 に露出 6 を掛けても 0 にはならない
    const reds = expected.filter((_, i) => i % 4 === 0)
    const span = Math.max(...reds) - Math.min(...reds)
    expect(span, `階調の幅が ${span} しかない`).toBeGreaterThan(200)
    expect(Math.max(...reds), '白飛びまで届いていない').toBeGreaterThan(250)

    // **式は同じ。**GLSL 版と比べていたときの実測で 4,096 バイト中 1 バイトが
    // 1 階調だけ違った。1,024 段のうち 1 段で丸めが分かれただけで、曲線も
    // 定数も同じ。**露出 6 はそのまま持ち越せる**
    const diff = byteDifference(expected, result.tone!)
    expect(diff.max, `AgX の最大差 ${diff.max}`).toBeLessThanOrEqual(1)
    expect(diff.differing, `AgX で違うバイトが ${diff.differing} 個`).toBeLessThan(
      expected.length * 0.01,
    )
  })

  test('TSL の雲の合成が CPU 参照と一致し、両方の枝を通る', async ({ page }) => {
    // **段 17。**`AerialPerspectiveNode` に `overlay` が無いので、雲を大気へ
    // 差し込む合成を自前で書く。式は takram の断片シェーダから写した
    // （原本との照合は `tests/render/overlayProbe.test.ts`）。段 S1 までは
    // GLSL 版とも比べていた。CPU 参照と GLSL の最後の出力の差は 1 階調まで
    // （vitest の `nodeReference.test.ts`）
    const { result, errors } = await probe(page, 'gpu=1&overlayprobe=1')
    expect(errors).toEqual([])
    expect(result.overlay, 'TSL 側が合成を焼いていない').toBeTruthy()

    // **枝を数えるのが先。**通っていない枝は検査されない（段 13・14・16）。
    // 早期打ち切りは値としては何も変えないので、合成の結果を比べても
    // 枝を通ったかどうかは出てこない
    expect(overlayMarkerCounts(result.overlay!.marker), 'TSL の合成の枝の数').toEqual({
      early: OVERLAY_PROBE_EARLY_COUNT,
      late: OVERLAY_PROBE_LATE_COUNT,
      other: 0,
    })

    // 階調を使い切っていること。片側が空の絵なら式を間違えても一致する
    const cpu = overlayProbeExpected()
    expect(cpu.length).toBe(OVERLAY_PROBE_COUNT * 4)
    const reds = cpu.filter((_, i) => i % 4 === 0)
    const span = Math.max(...reds) - Math.min(...reds)
    expect(span, `階調の幅が ${span} しかない`).toBeGreaterThan(150)

    // **掛けて足すだけの式で、順序も揃えてある。**差は丸めの 1 階調まで
    const diff = byteDifference(cpu, result.overlay!.composite)
    expect(diff.max, `CPU 参照との最大差 ${diff.max}`).toBeLessThanOrEqual(1)
    expect(diff.differing, `CPU 参照と違うバイトが ${diff.differing} 個`).toBeLessThan(
      cpu.length * 0.01,
    )

    // **レンダーターゲットから引き直しても同じ絵になるか。**本番の雲は
    // レンダーターゲットから来る。node 経路は v を裏返して読むので、
    // そこが合っていなければ上下の裏返った雲を合成することになる。
    //
    // **一致は階調 1 まで。**8 ビットのレンダーターゲットを経由するので、
    // 雲の色と不透明度が 1/255 刻みへ丸められる（実測で 16,384 バイト中
    // 2,279 個が 1 階調ずれた）。**向きの検査に量子化は関係ない**ので、
    // 裏返した絵との差で歯があることを裏取りする
    const sampled = byteDifference(
      result.overlay!.composite,
      result.overlay!.sampled,
    )
    expect(
      sampled.max,
      `引き直すと最大 ${sampled.max} 階調ずれる（上下が裏返っている疑い）`,
    ).toBeLessThanOrEqual(1)

    const flipped: number[] = []
    for (let row = OVERLAY_PROBE_SIDE - 1; row >= 0; row--) {
      const at = row * OVERLAY_PROBE_SIDE * 4
      flipped.push(
        ...result.overlay!.composite.slice(at, at + OVERLAY_PROBE_SIDE * 4),
      )
    }
    const vsFlipped = byteDifference(flipped, result.overlay!.sampled)
    expect(
      vsFlipped.max,
      '上下を裏返しても差が出ない。向きの検査に歯がない',
    ).toBeGreaterThan(20)

    // **早期打ち切りが効いているかは絵に出ない。**枝を通った数を数えても、
    // 大気の組み立てが `else` の中にあるかは分からない。生成された本文を
    // 読んで位置で確かめる。**外へ出た瞬間に稼ぎが消える**
    const source = (result.overlaySource ?? '').replace(/\s+/g, ' ')
    expect(source, '断片シェーダの本文が取れていない').toContain('void main()')
    const elseAt = source.indexOf('} else {')
    expect(elseAt, '生成された本文に else が無い').toBeGreaterThan(0)

    const baseNeedle = `vec3( ${OVERLAY_PROBE_BASE_RATIO.r}, ${OVERLAY_PROBE_BASE_RATIO.g}, ${OVERLAY_PROBE_BASE_RATIO.b} )`
    const occurrences = source.split(baseNeedle).length - 1
    expect(occurrences, `下地の組み立てが本文に ${occurrences} 回現れる`).toBe(1)
    expect(
      source.indexOf(baseNeedle),
      '下地の組み立てが else の外にある。早期打ち切りが稼がない',
    ).toBeGreaterThan(elseAt)

    // 早期打ち切りの条件そのものも本文にあること
    expect(source, '不透明度 1 の判定が本文に無い').toMatch(/\.w == 1\.0/)
  })

  test('WebGPU でも雲の合成が GLSL の記録と一致する', async ({ page }) => {
    test.skip(
      !hasWebGPU(),
      'WebGPU の起動引数が要る',
    )
    const { result, errors } = await probe(page, 'gpu=2&overlayprobe=1')
    expect(errors).toEqual([])
    expect(result.backend).toBe('node-webgpu')
    expect(result.overlay, 'TSL 側が合成を焼いていない').toBeTruthy()

    // **枝の数は WGSL でも同じはず。**整数なので丸めが効かない
    const branch = overlayMarkerCounts(result.overlay!.marker)
    expect(branch).toEqual({
      early: OVERLAY_PROBE_EARLY_COUNT,
      late: OVERLAY_PROBE_LATE_COUNT,
      other: 0,
    })

    // WGSL は演算順序が動きうるので階調 1 まで許す（段 13・16 と同じ）。
    // 相手は GLSL の最後の出力の記録
    const diff = byteDifference(ref.overlay.composite, result.overlay!.composite)
    expect(diff.max, `記録との最大差 ${diff.max}`).toBeLessThanOrEqual(1)
  })

  test('RenderPipeline でポストの鎖が立つ', async ({ page }) => {
    test.skip(
      !hasWebGPU(),
      'WebGPU の起動引数が要る',
    )
    const { result, errors } = await probe(page, 'gpu=2&nodepipeline=1')
    expect(errors).toEqual([])
    expect(result.pipeline, '鎖が組めていない').toBeTruthy()
    const p = result.pipeline!

    // **雲は場面のパスより後に走ること。**先に走ると 1 フレーム前の深度を
    // 読む。順はノードを辿った順で決まるので、式の順を入れ替えると落ちる。
    //
    // **描画呼び出しの数で見る。**`frameCalls` は全画面クアッドのパス
    // （雲影や SMAA）も 1 つずつ数えるので、場面が描かれたかどうかは出て
    // こない。場面は機体と空母のメッシュぶんを投げる
    expect(
      p.cloudDrawCallsAtRun,
      `雲を焼いた時点の描画呼び出しが ${p.cloudDrawCallsAtRun}。場面のパスより先に走っている疑い`,
    ).toBeGreaterThan(20)

    // 絵が出ていること。真っ黒なら鎖のどこかで落ちている
    const bright = p.tiles.filter((t) => t > 0.02).length
    expect(bright, `明るい区画が ${bright} しかない`).toBeGreaterThan(8)

    // ---- ライティングの置き換え（段 17c）----
    //
    // **直達は同じ物理なので近いはず。**`getSplitIrradiance` の直達は
    // 太陽放射照度に透過率と `max(N・L, 0)` を掛けたもので、GLSL 経路の
    // `SunDirectionalLight` が CPU で出していたものと同じ式
    expect(p.directAwayFromSun, '太陽に背けた面の直達が 0 でない').toEqual([
      0, 0, 0,
    ])
    for (const v of p.indirectFacingSun) {
      expect(v, '間接照度が 0。LUT ができる前に焼いている疑い').toBeGreaterThan(0)
    }

    // 相手は GLSL 経路（takram の GLSL 版が同梱の EXR から出していた値）の
    // 記録。CPU では作り直せない
    const glslSun = ref.sunRadiance
    const glslSky = ref.skyRadiance

    // 実測で 1.705 対 1.751（2.6% 違い）。**π を掛け違えれば 3.14 倍ずれる**
    for (let c = 0; c < 3; c++) {
      const ratio = p.directFacingSun[c]! / glslSun[c]!
      expect(
        ratio,
        `直達の比 ${ratio}（node ${p.directFacingSun[c]} 対 GLSL の記録 ${glslSun[c]}）`,
      ).toBeGreaterThan(0.8)
      expect(ratio).toBeLessThan(1.2)
    }

    // **間接は式が違うので離れる。**実測 2.7〜3.5 倍。内訳は 2 つで、
    // 式で 1.64 倍（GLSL 経路は SH の L0 だけを読んで 0.28 を掛ける。
    // node は `(1 + N・up) / 2` を 1/pi で割る）、LUT そのもので 1.7〜2.1 倍
    // （実行時計算と同梱の EXR）。**段 20 の差分の台帳へ入れた数**
    for (let c = 0; c < 3; c++) {
      const ratio = p.indirectFacingSun[c]! / Math.PI / glslSky[c]!
      expect(
        ratio,
        `間接の比 ${ratio}（node ${p.indirectFacingSun[c]! / Math.PI} 対 GLSL の記録 ${glslSky[c]}）`,
      ).toBeGreaterThan(1.5)
      expect(ratio).toBeLessThan(6)
    }

    // ---- 機体の影（段 17c の後半）----
    //
    // **投げ手を切って数える。**光の `castShadow` は触らない（組み立ての
    // 時点で立っていると three の光の系が影のノードをもう 1 つ作って落ちる）
    expect(
      p.shadowChangedMax,
      `投げ手を切っても最大 ${p.shadowChangedMax} 階調しか動かない`,
    ).toBeGreaterThan(10)
    //
    // **閾値は雑音を除いた実測の半分。**もとは 500 で、雑音込みの約 1,900 に
    // 支えられて通っていた。SwiftShader は撮り直すだけで約 1,800 バイトが 1
    // 動き、0 の回もある。0 の回に本当の値だけが残って落ちた。`NOISE_FLOOR`
    // で雑音を除くと毎回 132（F/A-18E）。C 型でも 279 で、500 は書いた時から
    // 本当の値では一度も越えていない
    expect(
      p.shadowChanged,
      `投げ手を切って動いたのが ${p.shadowChanged} バイト`,
    ).toBeGreaterThan(66)
    // **パスの数では分からない。**投げ手が無くても影のパスは走る（段 15）
    expect(p.shadowFrameCalls).toBe(p.noShadowFrameCalls)

    // 置き換えで地表が動くこと。**0 なら効いていない**
    expect(
      p.lightingProbeChanged,
      `矩形で動いた ${p.lightingProbeChanged} バイト`,
    ).toBeGreaterThan(1000)

    // ---- 事前コンパイルと起動時間（段 19）----
    //
    // **`compileAsync` は場面の物しか組まない。**鎖の全画面クアッドは
    // 場面に入っていないので、暖機の 1 枚で実描画が要る。私物の
    // `_quadMesh` へ手を伸ばして組む道も測ったが、描き先・トーンマッピング・
    // 出力の色空間まで揃えても 1 枚目の差が 1,578 ms 残った
    //
    // **組み立ては数で数える**（段 S2b-2 の追補、ユーザーの決定）。2026-10-28 まで
    // 「暖機 > 2 枚目 × 1.5」「1 枚目 < 暖機 × 0.6」と時間の比で縛っていたが、CI の
    // 分割 18 で 3 度落ちた（9de0e6c・ef8dd11・0441de9、どれもやり直しで通過）。
    // 毎フレームの描画が組み立てより重く、CPU の取り合いで 1 枚だけ伸びると比が崩れる。
    // シェーダのプログラムの数は取り合いに左右されない。手元の実測は 28 → 53 → 53 → 53
    expect(
      p.programsAfterWarmup,
      `暖機でプログラムが増えていない（前 ${p.programsBeforeWarmup}、後 ${p.programsAfterWarmup}）`,
    ).toBeGreaterThan(p.programsBeforeWarmup)
    // 暖機のあとは 1 枚目も 2 枚目も組み立てない
    expect(p.programsAfterFirst, '暖機のあとの 1 枚目で組み立てた').toBe(p.programsAfterWarmup)
    expect(p.programsAfterSecond, '暖機のあとの 2 枚目で組み立てた').toBe(p.programsAfterWarmup)
    // **起動は壁時計で縛らない。**SwiftShader は CPU 律速なので、ワーカーが
    // 同時に描くと伸びる（`docs/lessons.md` の記録）。単独で回すと 5,952 ms
    // だったものが、spec を丸ごと回すと 31,702 ms になった。**競合を
    // 測っているだけ。**計画の 15 秒は直列の実測で見る（`docs/measuring.md`）。
    //
    // 検査は比で縛る。定常の 1 枚に対して起動が何倍かなら、機械の負荷が
    // 上がっても両方が伸びるので形が残る。単独の実測で 5.9 倍
    expect(
      p.startupMs / p.steadyMs,
      `起動 ${p.startupMs} ms が定常 ${p.steadyMs} ms の何倍か`,
    ).toBeLessThan(25)

    // 地形が場面に入っていること。**材質が非互換だと黙って描かれない**
    // （段 9 の記録）ので、パッチ枚数と三角形の数で見る
    expect(p.terrainPatches, `パッチが ${p.terrainPatches} 枚`).toBeGreaterThan(50)
    expect(
      p.terrainTriangles,
      `地形の三角形が ${p.terrainTriangles}`,
    ).toBeGreaterThan(10_000)
    // 地形と海面のぶん、描画呼び出しが増える
    expect(p.drawCalls, `描画呼び出しが ${p.drawCalls}`).toBeGreaterThan(60)

    // **SMAA が鎖に入っているだけでは足りない。**外すとパスの数が減り、
    // 辺の画素が動くことを見る
    expect(
      p.smaaFrameCalls,
      `SMAA 入り ${p.smaaFrameCalls} 対 外し ${p.plainFrameCalls}`,
    ).toBeGreaterThan(p.plainFrameCalls)
    expect(
      p.smaaChanged,
      'SMAA を外しても画素が動かない。辺を拾っていない',
    ).toBeGreaterThan(0)

    // 同じプリセットを当て直すと同じ材質が出る。`useDetail` が生成時に
    // 畳まれるので、切り替えには材質の組み直しが要る。
    //
    // **1 枚の絵では確かめられない。**ずらしがフレームごとに動くので、
    // 同じ材質でも 2 枚は一致しない（実測で 328 バイト）
    expect(
      p.marchSourceLength,
      'マーチの本文が取れていない',
    ).toBeGreaterThan(1000)
    const diff = p.requiltDiff
    expect(
      p.requiltSameSource,
      diff === null
        ? 'プリセットを当て直すと別の材質が出る'
        : `プリセットを当て直すと別の材質が出る。${diff.index} 文字目で分岐` +
          `（長さ ${diff.beforeLength} → ${diff.afterLength}）\n` +
          `  前: ${JSON.stringify(diff.before)}\n` +
          `  後: ${JSON.stringify(diff.after)}`,
    ).toBe(true)
    // 組み直しが何もしていなくても上は通る。変わる側も見る
    expect(
      p.requiltOtherDiffers,
      '違うプリセットを当てても材質が変わらない。組み直しが働いていない',
    ).toBe(true)
  })

  test('TSL の地表と海面が GLSL の記録と一致し、枝をすべて通る', async ({
    page,
  }) => {
    // **段 17b。**`terrain.frag` と `water.frag` の色の本体を TSL へ移した。
    // 大気に触らせていないので `?gpu=1` でも走る。段 S1 で相手を GLSL の
    // 最後の出力の記録へ替えた
    const { result, errors } = await probe(page, 'gpu=1&surfaceprobe=1')
    expect(errors).toEqual([])
    expect(result.surface, 'TSL 側が地表を焼いていない').toBeTruthy()

    const pixels = SURFACE_PROBE_SIDE * SURFACE_PROBE_SIDE
    expect(result.surface!.terrain.length).toBe(pixels * 4)
    expect(result.surface!.water.length).toBe(WATER_PROBE_REGIONS.length)

    // **枝を数えるのが先。**通っていない枝は検査されない（段 13・14・16）。
    // 記録が摂動・雪・急斜面の岩、海面の 1 タップ・双三次・白波・波の遠近を
    // すべて通り、階調を使い切っていることは `nodeReference.test.ts` が見る。
    // ここは枝の数（整数）が記録と一致し、色が階調 1 まで一致することを見る
    expectSurfaceMatchesReference(result.surface!)

    // 頂点変位は CPU 参照と突き合わせる（高さ場と同じ作法）
    const patch = terrainPatchProbeValues(result.surface!.patch)
    expect(patch.length).toBe(pixels)
    let worstXZ = 0
    let worstMorph = 0
    let clampedLow = 0
    let clampedHigh = 0
    let ramp = 0
    for (let row = 0; row < SURFACE_PROBE_SIDE; row++) {
      for (let col = 0; col < SURFACE_PROBE_SIDE; col++) {
        const want = terrainPatchProbePoint(col, row)
        const got = patch[row * SURFACE_PROBE_SIDE + col]!
        worstXZ = Math.max(worstXZ, Math.abs(want.x - got.x), Math.abs(want.z - got.z))
        worstMorph = Math.max(worstMorph, Math.abs(want.morph - got.morph))
        if (want.morph === 0) clampedLow++
        else if (want.morph === 1) clampedHigh++
        else ramp++
      }
    }
    // **寄せ量が片側で頭打ちするだけでは `clamp` を外しても気づけない。**
    // 3 つの領域をすべて通す
    expect(clampedLow, `寄せ量 0 が ${clampedLow} 画素`).toBeGreaterThan(0)
    expect(clampedHigh, `寄せ量 1 が ${clampedHigh} 画素`).toBeGreaterThan(0)
    expect(ramp, `途中の寄せ量が ${ramp} 画素`).toBeGreaterThan(pixels / 10)
    expect(worstXZ, `頂点位置のずれ ${worstXZ} m`).toBeLessThan(0.01)
    expect(worstMorph, `寄せ量のずれ ${worstMorph}`).toBeLessThan(1e-5)

    // **照度の形が同じ絵を出すこと。**段 17c で地表のライティングを
    // `getSplitIlluminance` へ移す。1/pi の掛け忘れや二重掛けがあれば
    // 3.14 倍ずれるので、同じ値を流し込んで突き合わせる
    const matched = byteDifference(
      result.surface!.terrain,
      result.surface!.terrainMatched,
    )
    expect(
      matched.max,
      `照度の形との差 ${matched.max} 階調（違うバイト ${matched.differing}）`,
    ).toBeLessThanOrEqual(1)
  })

  test('WebGPU でも地表と海面が GLSL の記録と一致する', async ({ page }) => {
    test.skip(
      !hasWebGPU(),
      'WebGPU の起動引数が要る',
    )
    const { result, errors } = await probe(page, 'gpu=2&surfaceprobe=1')
    expect(errors).toEqual([])
    expect(result.backend).toBe('node-webgpu')
    expect(result.surface, 'TSL 側が地表を焼いていない').toBeTruthy()

    // **枝の数は WGSL でも同じはず。**通ったか通らないかの整数なので
    // 丸めが効かない。色は WGSL の演算順序が動きうるので階調 1 まで許す
    // （段 13・16 と同じ）
    expectSurfaceMatchesReference(result.surface!)
  })

  test('`?gpu=1` では鎖を組まない', async ({ page }) => {
    // 大気の構造体が GLSL へ落ちないので、鎖は WebGPU だけ（ADR 0010）
    const { result, errors } = await probe(page, 'gpu=1&nodepipeline=1')
    expect(errors).toEqual([])
    expect(result.atmosphere).toBe(false)
    expect(result.pipeline).toBeNull()
  })

  test('node/WebGL2 で GPU 時間が取れる', async ({ page }) => {
    // **段 18。**WebGL2 の `EXT_disjoint_timer_query_webgl2` は node 経路に
    // 無い。`trackTimestamp` は `timestamp-query` が無いと静かに false に
    // なり、例外も出ずに `undefined` が返る。**回収できた件数で判定する。**
    //
    // 実測（SwiftShader）で GPU 11.0 ms 対 CPU 16.2 ms。差は読み戻しの排出ぶん
    const { result, errors } = await probe(page, 'gpu=1')
    expect(errors).toEqual([])
    expect(result.backend).toBe('node-webgl')
    expect(
      result.timestampSamples,
      `回収 ${result.timestampSamples} 件・破棄 ${result.timestampDropped} 件`,
    ).toBeGreaterThanOrEqual(4)
    expect(result.gpuFrameMs).not.toBeNull()
    // **0 が混ざると最小値がそのまま 0 になる。**解決を重ねたときに
    // three が返す前の値を数に入れていた（段 19 の後で踏んだ）
    expect(
      result.gpuFrameMs!,
      `GPU ${result.gpuFrameMs}・破棄 ${result.timestampDropped} 件`,
    ).toBeGreaterThan(0)
    // GPU 時間は CPU 側の経過を超えない。超えるなら別の枠を測っている
    expect(
      result.gpuFrameMs!,
      `GPU ${result.gpuFrameMs} 対 CPU ${result.renderMs}`,
    ).toBeLessThanOrEqual(result.renderMs * 1.1)
  })

  test('WebGPU でも GPU 時間が取れる', async ({ page }) => {
    test.skip(
      !hasWebGPU(),
      'WebGPU の起動引数が要る',
    )
    // 実測で GPU 229.9 ms 対 CPU 231.9 ms
    const { result, errors } = await probe(page, 'gpu=2')
    expect(errors).toEqual([])
    expect(result.backend).toBe('node-webgpu')
    expect(
      result.timestampSamples,
      `回収 ${result.timestampSamples} 件・破棄 ${result.timestampDropped} 件`,
    ).toBeGreaterThanOrEqual(4)
    expect(result.gpuFrameMs).not.toBeNull()
    expect(
      result.gpuFrameMs!,
      `GPU ${result.gpuFrameMs}・破棄 ${result.timestampDropped} 件`,
    ).toBeGreaterThan(0)
    expect(
      result.gpuFrameMs!,
      `GPU ${result.gpuFrameMs} 対 CPU ${result.renderMs}`,
    ).toBeLessThanOrEqual(result.renderMs * 1.1)
  })

  test('本番の場面が node 経路で立つ', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')

    // **段 20a の到達点。**`?gpu=1|2` は自己診断で、固定入力のプローブ用の
    // 場面を描く。`?gpu=3` は `createNodePipeline` を立てて**本番の場面**
    // （mission-01 の台本・HUD の帳簿・views 11 種）を node 経路で描く。
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/dogfight/?capture=1&frame=60&script=level&gpu=3')
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    expect(errors, `コンソールに ${errors.length} 件`).toEqual([])
    expect(hook!.backend).toBe('node-webgpu')

    // **場面が毎フレーム描かれていること。**手で `render()` を回すと
    // `nodeFrame.frameId` が進まず、`FRAME` 型の更新が 1 枚目だけになる。
    // レンダーターゲットに前の中身が残るので**絵は出続ける。**実測で
    // 1 枚目 167 呼び出し・458,486 三角形、2 枚目以降 2 呼び出し・3 三角形。
    // ここが読むのは最後のフレームの数なので、進んでいないと落ちる
    expect(
      hook!.drawCalls,
      `最後のフレームの描画呼び出しが ${hook!.drawCalls}。` +
        'nodeFrame が進んでいない疑い',
    ).toBeGreaterThan(100)
    expect(hook!.drawnTriangles).toBeGreaterThan(400_000)

    // 雲ノイズが焼けていること。GLSL 経路と同じ主張
    expect(hook!.noiseStats.max).toBeGreaterThan(hook!.noiseStats.min)
    expect(hook!.noiseStats.mean).toBeGreaterThan(0.1)
    expect(hook!.noiseStats.mean).toBeLessThan(0.95)
    // 8bit へ戻すと等高線状の横線が復活する。型そのものを見る
    expect(hook!.cloudHdrTarget).toBe(true)

    // **放射輝度に CPU 側の値が無い。**`AtmosphereLight` の `direct` と
    // `indirect` は on/off で色ではないので、照度を焼いて読み戻している。
    // 実測 1.7055 で、GLSL 経路の 1.751 と 2.6% 違い
    expect(hook!.sunRadiance[0]).toBeGreaterThan(0)
    // 白 (1,1,1) で固定されていないこと。`smoke.spec.ts` と同じ主張
    expect(hook!.sunRadiance[0]).not.toBeCloseTo(hook!.sunRadiance[2]!, 3)
    expect(hook!.skyRadiance[2]).toBeGreaterThan(0)

    expect(hook!.atmosphereReady).toBe(true)
    expect(hook!.environmentReady).toBe(true)
    expect(hook!.aircraftShadowReady).toBe(true)
    // `ShaderMaterial` は node 経路で黙って描かれない。円形スプライトを
    // TSL 版に差し替えてあるので 0 でなければならない
    expect(hook!.webglVersion, 'WebGPU なので生のコンテキストは無い').toBe(0)
  })

  test('`?gpu` を渡さない既定が WebGPU の node 経路で立つ', async ({ page }) => {
    // WebGPU の無いブラウザで止まることは `webgpu-required.spec.ts` の担当
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    await page.goto('/dogfight/?capture=1&frame=0')
    await page.waitForSelector('body[data-capture-ready="1"]')
    const hook = await page.evaluate(
      () => (window as unknown as { __dogfight?: TestHook }).__dogfight,
    )
    // 自己診断は `?gpu=1|2` のときだけ。既定では走らない
    expect(hook?.gpuProbe).toBeNull()

    // **宣言ではなく実物を見る。**以前は既定の宣言（`DEFAULT_BACKEND`）だけが
    // `'node'` に書き換わり、読む側が無いまま既定は GLSL で緑が続いた
    // （2026-09-14）。段 S1 で GLSL 経路と宣言そのものを捨てたので、立った
    // バックエンドの名前を直に見る
    expect(hook?.backend).toBe('node-webgpu')
  })

  /**
   * **空を背にした半透明の物が、GLSL 経路と同じくらい写る**（段 29 の前提の修正）。
   *
   * `AerialPerspectiveNode` は `depth >= 1` の画素の rgb を空で上書きする。深度を
   * 書かない半透明の物は、空を背にすると丸ごと消えていた。node を既定にした
   * 2026-09-16 から 2026-09-28 まで、`aircraft-vortex-long` の飛行機雲は GLSL
   * 13,958 画素に対して node 0 画素、撃墜の爆発も 0 画素。
   *
   * **基準画像の逆テストでは捕まらなかった。**あれは「消すと絵のどこかが
   * 変わる」しか見ない。ここは量を突き合わせる。段 S1 で GLSL 経路を捨て、
   * 相手を GLSL の最後の画素数の記録（爆発 3,697・飛行機雲 26,941。手元と CI で
   * 同じ値だった）へ替えた
   */
  test('空を背にした半透明の物が GLSL の記録と同じくらい写る', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    test.setTimeout(600_000)
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 200))
    })

    type Query = Parameters<typeof captureParams>[0]
    const shoot = async (p: Page, query: Query, off: string | null) => {
      const params = captureParams(query)
      params.set('gpu', '3')
      if (off !== null) params.set(off, '0')
      // **ブルームは切って比べる。**太陽の方を向いた構図では、ブルームが太陽を
      // 拾って画面を白く覆い、飛行機雲が埋もれる（`aircraft-vortex-long`、
      // 段 22 から残る別の件）。ここで見るのは空の上書きだけ
      params.set('bloom', '0')
      await p.goto(`/dogfight/?${params.toString()}`)
      await p.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
      return PNG.sync.read(await p.locator('#viewport').screenshot())
    }
    const changed = (a: PNG, b: PNG) => {
      let n = 0
      for (let px = 0; px < a.width * a.height; px++) {
        for (let c = 0; c < 3; c++) {
          if (Math.abs(a.data[px * 4 + c]! - b.data[px * 4 + c]!) > 1) {
            n++
            break
          }
        }
      }
      return n
    }

    const vortex = SCENES.find((sc: { name: string }) => sc.name === 'aircraft-vortex-long')!
    const cases = [
      // 撃墜から 0.23 秒。自機は爆発を隠すので消す（`tools/explosion-judge.mjs`）。
      // **爆発は経路で絵が違う。**段 29b から node 経路はノイズの火の玉の板を置き、
      // 煤の縁と膨らむ煙の分だけ大きく写る（段 S1a の実測 12,368 対 3,697 画素、
      // 3.35 倍、ADR 0015）。上限は二重に描くような崩れを捕まえる分だけ残す
      { label: '爆発', query: { script: 'gun-pass', frame: 135, hour: 16, coverage: 0, aircraft: false }, off: 'explosions', max: 6, recorded: ref.translucent.explosion },
      { label: '飛行機雲', query: vortex, off: 'trails', max: 2, recorded: ref.translucent.vortex },
    ]
    for (const { label, query, off, max, recorded } of cases) {
      const node = changed(await shoot(page, query, null), await shoot(page, query, off))
      // eslint-disable-next-line no-console
      console.log(`[半透明] ${label}: 記録 ${recorded} 画素・node ${node} 画素`)
      expect(node / recorded, `${label}: node ${node} 画素 / GLSL の記録 ${recorded} 画素`).toBeGreaterThan(0.5)
      expect(node / recorded, `${label}: node ${node} 画素 / GLSL の記録 ${recorded} 画素`).toBeLessThan(max)
    }
    // **描画の準備の失敗も見張る。**varying が上限 16 を越えると命令がまとめて
    // 無効になり、フレームが描かれない（`overSky` の最初の版で踏んだ）
    expect(errors).toEqual([])
  })

  /**
   * **水平線より下の爆発が、海面の霞に埋もれない**（段 29c）。
   *
   * 爆発は深度を書かないので、霞は下にある海面の深度（数 km 先）で掛かる。296 m 先の
   * 煙の下半分が海の色に塗りつぶされ、水平線でまっすぐ切れていた（ADR 0008 が
   * 「目線より下では潰れる」と予測していたもの）。海面を消すと下半分が現れる。
   * 同じ爆発を海面の有無で撮り、写る画素数を突き合わせる
   */
  test('水平線より下の爆発が海面の霞に埋もれない', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    test.setTimeout(600_000)
    const shoot = async (extra: Record<string, string>) => {
      const params = captureParams({ script: 'gun-pass', frame: 140, hour: 16, coverage: 0, aircraft: false })
      params.set('gpu', '3')
      params.set('bloom', '0')
      for (const [k, v] of Object.entries(extra)) params.set(k, v)
      await page.goto(`/dogfight/?${params.toString()}`)
      await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
      return PNG.sync.read(await page.locator('#viewport').screenshot())
    }
    const changed = (a: PNG, b: PNG) => {
      let n = 0
      for (let px = 0; px < a.width * a.height; px++) {
        for (let c = 0; c < 3; c++) {
          if (Math.abs(a.data[px * 4 + c]! - b.data[px * 4 + c]!) > 8) {
            n++
            break
          }
        }
      }
      return n
    }
    const overSea = changed(await shoot({}), await shoot({ explosions: '0' }))
    const noSea = changed(await shoot({ water: '0' }), await shoot({ water: '0', explosions: '0' }))
    expect(noSea, `海面なしで ${noSea} 画素しか写らない。構図が崩れている`).toBeGreaterThan(3000)
    expect(overSea / noSea, `海面あり ${overSea} 画素 / なし ${noSea} 画素`).toBeGreaterThan(0.9)
  })

  /**
   * **爆発は手前の機体に隠れる**（段 29c）。
   *
   * 爆発は場面のパスの外で描くので、深度のテストが効かない。隠れる判定は材質が
   * 場面の深度を読んで持つ（`sceneOcclusion.ts`）。`mission-01` の 2,400 フレームは
   * 自機の後ろ上方で煙が広がり、自機の上端と煙が 827 画素重なる。
   *
   * 自機の輪郭は「自機あり − 自機なし」の差で作り、縁を 2 画素削る（縁は SMAA で
   * 背景と混ざるので、爆発が透けて見えて正しい）。その内側で、自機が無ければ爆発が
   * 写る画素のうち、自機があっても爆発で変わる画素の割合を見る。実測で判定あり
   * 2.1%（11 / 525）、判定を外すと 33.9%（178 / 525）。
   *
   * **最初の 2 版は何も守っていなかった。**自機の胴体の固定の枠には煙が掛かって
   * おらず、`gun-pass` では爆発と自機が画面の上で離れていた（`explosion-judge.mjs`
   * の注記の「自機のすぐ上に重なる」は古い）。どちらも判定を外しても通った
   */
  test('爆発は手前の機体に隠れる', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    test.setTimeout(600_000)
    const shoot = async (extra: Record<string, string>) => {
      const params = captureParams({ script: 'mission-01', frame: 2400, hour: 16, coverage: 0 })
      params.set('gpu', '3')
      params.set('bloom', '0')
      // **白い煙の尾は消して数える**（段 29f）。この爆発は自機の近くで、尾は本当に
      // 自機とカメラのあいだを横切る。GLSL 経路（本物の深度テスト）でも自機の後ろの
      // 4,661 画素のうち 84% が自機の上に写った。ここで見るのは火の玉と煙の隠れ方
      params.set('explosiontrails', '0')
      for (const [k, v] of Object.entries(extra)) params.set(k, v)
      await page.goto(`/dogfight/?${params.toString()}`)
      await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
      return PNG.sync.read(await page.locator('#viewport').screenshot())
    }
    const mask = (a: PNG, b: PNG) => {
      const out = new Uint8Array(a.width * a.height)
      for (let i = 0; i < out.length; i++) {
        out[i] = [0, 1, 2].some((c) => Math.abs(a.data[i * 4 + c]! - b.data[i * 4 + c]!) > 8) ? 1 : 0
      }
      return out
    }
    const both = await shoot({})
    const noBoom = await shoot({ explosions: '0' })
    const noCraft = await shoot({ explosions: '0', aircraft: '0' })
    const boomOnly = await shoot({ aircraft: '0' })
    const w = both.width
    const craft = mask(noBoom, noCraft)
    const boom = mask(boomOnly, noCraft)
    const shown = mask(both, noBoom)
    const inside = (i: number) => {
      const x = i % w
      const y = (i - x) / w
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) if (craft[(y + dy) * w + x + dx] !== 1) return false
      }
      return true
    }
    let behind = 0
    let over = 0
    for (let i = 2 * w; i < craft.length - 2 * w; i++) {
      if (craft[i] !== 1 || boom[i] !== 1 || !inside(i)) continue
      behind++
      if (shown[i] === 1) over++
    }
    expect(behind, `自機の後ろの爆発が ${behind} 画素しかない。構図が崩れている`).toBeGreaterThan(300)
    expect(over / behind, `自機の後ろの爆発 ${behind} 画素のうち ${over} 画素が自機の上に写った`).toBeLessThan(0.1)
  })

  /**
   * **太陽の方を向いても、ブルームが画面を覆わない**（段 30e-1）。
   *
   * 太陽の円盤は空の何千倍も明るい。閾値を越えた分をそのままぼかすと、162 画素の
   * 太陽から画面の 23%（214,162 画素）が白く飽和した（`aircraft-vortex-long`、段 22 から
   * 基準画像に焼き付いていた）。ブルームなしでは 250 以上の画素は 162 だけ
   */
  test('太陽を向いてもブルームが画面を覆わない', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    test.setTimeout(600_000)
    const vortex = SCENES.find((sc: { name: string }) => sc.name === 'aircraft-vortex-long')!
    const params = captureParams(vortex)
    params.set('gpu', '3')
    await page.goto(`/dogfight/?${params.toString()}`)
    await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
    const png = PNG.sync.read(await page.locator('#viewport').screenshot())
    let white = 0
    for (let px = 0; px < png.width * png.height; px++) {
      const i = px * 4
      if (png.data[i]! >= 250 && png.data[i + 1]! >= 250 && png.data[i + 2]! >= 250) white++
    }
    const share = white / (png.width * png.height)
    expect(share, `白く飽和した画素が ${white}（${(share * 100).toFixed(1)}%）`).toBeLessThan(0.01)
  })

  /**
   * **ベイパーコーンは音速の近くでだけ出る**（段 30f）。
   *
   * `low-pass` は高度 220 m を秒速 320 m（マッハ 0.94）から全開で加速する。`level` は
   * 巡航のマッハ 0.73 で、出てはいけない。どちらも `?vapor=0` との差で数える
   */
  test('ベイパーコーンは音速の近くでだけ出る', async ({ page }) => {
    test.skip(!hasWebGPU(), 'WebGPU の起動引数が要る')
    test.setTimeout(600_000)
    const shoot = async (script: string, extra: Record<string, string>) => {
      const params = captureParams({ script, frame: 240, hour: 16, coverage: 0 })
      params.set('gpu', '3')
      params.set('bloom', '0')
      for (const [k, v] of Object.entries(extra)) params.set(k, v)
      await page.goto(`/dogfight/?${params.toString()}`)
      await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300_000 })
      return PNG.sync.read(await page.locator('#viewport').screenshot())
    }
    const changed = (a: PNG, b: PNG) => {
      let n = 0
      for (let px = 0; px < a.width * a.height; px++) {
        if ([0, 1, 2].some((c) => Math.abs(a.data[px * 4 + c]! - b.data[px * 4 + c]!) > 4)) n++
      }
      return n
    }
    const fast = changed(await shoot('low-pass', {}), await shoot('low-pass', { vapor: '0' }))
    const cruise = changed(await shoot('level', {}), await shoot('level', { vapor: '0' }))
    expect(fast, `遷音速で ${fast} 画素しか変わらない`).toBeGreaterThan(2000)
    expect(cruise, `巡航で ${cruise} 画素が変わった`).toBe(0)
  })
})
