import { expect, test, type Page } from '@playwright/test'
import { captureParams, type CaptureQuery } from './scenes.mjs'

/**
 * E2E の共有ハーネス。
 *
 * **spec ファイルに置かない。**`*.spec.ts` を import するとその中のテストが
 * 二重に登録される。`testMatch` に当たらない名前にして、両方の spec から
 * 読む。
 */

/**
 * src/render/capture.ts の TestHook の写し。
 *
 * 本家に項目を足したらここも足す。写しなので黙ってずれる。実際に 5 項目
 * ずれていたのを Phase 3.5 で揃えた。
 */
export interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  /** 描画バックエンドの名前。`webgl` / `node-webgl` / `node-webgpu` */
  backend: string
  webglVersion: number
  atmosphereReady: boolean
  sunElevation: number
  sunRadiance: [number, number, number]
  skyRadiance: [number, number, number]
  noiseMs: number
  noiseStats: { min: number; max: number; mean: number }
  gpuFrameMs: number
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
  /** node 経路の自己診断。`?gpu=1|2` のときだけ埋まる */
  gpuProbe: {
    requested: number
    backend: string
    fellBack: boolean
    sharedCore: boolean
    meshes: number
    shaderMaterials: number
    drawCalls: number
    triangles: number
    programs: number
    noiseSlice: number[]
    weatherSlice: number[]
    hashProbe: number[]
    shadowHistogram: number[] | null
    shadowTiles: number[] | null
    march: {
      samples: { total: number; max: number; hit: number }
      exhausted: number
      tiles: number[]
      resolve: number[]
    } | null
    heightProbe: number[] | null
    sprite: { soft: number[]; core: number[] } | null
    tone: number[] | null
    overlay: { composite: number[]; marker: number[]; sampled: number[] } | null
    overlaySource: string | null
    timestampSamples: number
    timestampDropped: number
    gpuFrameMs: number | null
    surface: {
      patch: number[]
      terrain: number[]
      terrainBranches: number[]
      terrainMatched: number[]
      water: number[][]
      waterBranches: number[][]
    } | null
    pipeline: {
      frameCalls: number
      drawCalls: number
      buildMs: number
      compileSceneMs: number
      compileCloudsMs: number
      warmupMs: number
      startupMs: number
      lutMs: number
      firstFrameMs: number
      secondFrameMs: number
      steadyMs: number
      cloudFrameCallsAtRun: number
      cloudDrawCallsAtRun: number
      cloudRenderCount: number
      tiles: number[]
      lightingChanged: number
      lightingChangedMax: number
      lightingTiles: number[]
      shadowChanged: number
      shadowChangedMax: number
      shadowFrameCalls: number
      noShadowFrameCalls: number
      lightingProbeChanged: number
      lightingProbeMax: number
      lightingProbeTilesBefore: number[]
      lightingProbeTilesAfter: number[]
      directFacingSun: [number, number, number]
      directAwayFromSun: [number, number, number]
      indirectFacingSun: [number, number, number]
      terrainPatches: number
      terrainTriangles: number
      smaaFrameCalls: number
      plainFrameCalls: number
      smaaChanged: number
      smaaChangedMax: number
      marchSourceLength: number
      requiltSameSource: boolean
      requiltOtherDiffers: boolean
    } | null
    nodeShadow: {
      filter: string
      casters: number
      aircraftDrawCalls: number
      drawCallsWithout: number
      drawCallsWith: number
      frameCallsWithout: number
      frameCallsWith: number
      frameCallsSecond: number
      frameCallsEnabledNoCaster: number
      changed: number
      changedMax: number
    } | null
    volumeMs: number
    atmosphere: boolean
    lutMs: number
    lutScale: number
    buildMs: number
    sunElevationDeg: number
    initMs: number
    firstFrameMs: number
    renderMs: number
    frames: number
  } | null
  /** 形状ノイズの中央スライスの生バイト。`?noiseprobe=1` のときだけ埋まる */
  noiseSlice: number[] | null
  /** 気象マップの左下 16x16 の生バイト。`?noiseprobe=1` のときだけ埋まる */
  weatherSlice: number[] | null
  /** 雲影マップ 256² の分布。16 ビン */
  shadowHistogram: number[] | null
  /** 雲影マップを 4x4 に区切った区画ごとの平均透過率。16 個 */
  shadowTiles: number[] | null
  /** 固定の入力で焼いた雲のマーチ。`?marchprobe=1` のときだけ埋まる */
  spriteProbe: { soft: number[]; core: number[] } | null
  toneProbe: number[] | null
  overlayProbe: { composite: number[]; marker: number[] } | null
  surfaceProbe: {
    terrain: number[]
    terrainBranches: number[]
    water: number[][]
    waterBranches: number[][]
  } | null
  marchProbe: {
    samples: { total: number; max: number; hit: number }
    exhausted: number
    tiles: number[]
    resolve: number[]
    resolveChanged: number
  } | null
  /** その分布を焼いた入力。TSL 版へ渡し直すために出す */
  shadowInputs: {
    cloudTime: number
    coverage: number
    sunX: number
    sunY: number
    sunZ: number
    centerX: number
    centerZ: number
  } | null
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

export const DEG = Math.PI / 180

export function readHook(page: Page): Promise<TestHook | undefined> {
  return page.evaluate(() => (window as unknown as { __dogfight?: TestHook }).__dogfight)
}

// `CaptureQuery` と URL の組み立ては `tests/e2e/scenes.mjs` が正本。
// `tools/exact.mjs` も同じものを読む。写しを持つと、片方だけが別の既定値を
// 使ったときに画素比較の道具が嘘の結論を出す（雲量の既定で実際にずれていた）。

/**
 * この project が node 経路で回っているか。
 *
 * **段 20b で既定が node になった。**`chromium-swiftshader` だけが旧経路
 * （GLSL）で、それ以外は node。段 20a-3 では `chromium-node` だけが node
 * だったので、判定の向きが逆になっている。
 *
 * **経路を指す `?path=` を足すのはここ 1 か所だけ。**各テストが URL を
 * 組み立てる形にすると、足し忘れた検査が既定の経路のまま通って
 * 「両経路で緑」の意味が消える（段 20a-3 で決めた作法）
 */
export function onNodePath(): boolean {
  return test.info().project.name !== 'chromium-swiftshader'
}

/**
 * シムのフレームが n 枚進むまで待つ。
 *
 * **壁時計で待たない。**`waitForTimeout(600)` は GLSL 経路の 1 フレーム
 * 50 ms を前提にした値で、node 経路は 800 ms 前後かかるので 1 枚も進まない
 * ことがある。**進まないと「何も起きていない」という主張が空振りで通る。**
 * 実測で `開いている間は撃てない` の前半（設定を開いている間は撃てない）が
 * その形になっていた（段 20a-3）。
 *
 * `hook.frame` は 120 Hz のシムのフレーム番号。60 枚で 0.5 秒ぶん
 */
/**
 * 値で待つときの上限。
 *
 * **node 経路はフレームの費用が 1.96 倍。**上限は GLSL 経路で決めた値なので、
 * そのままだと値に届く前に打ち切る。実測で `speed > 50` が 60 秒で 39.86 の
 * まま落ち、`missionOutcome === 'shotDown'` が 120 秒で届かなかった
 * （どちらも単独では通る。段 20a-3）。
 *
 * **値で待つ形は保つ。**壁時計で待つ形へ戻すと、遅い経路で「何も起きて
 * いない」の主張が空振りで通る（`advanceFrames` の注記）。伸ばすのは上限だけ。
 *
 * 3 倍は `test.slow()` と同じ倍率。固まりの検出は e2e.yml の段の上限が担う
 */
export function waitBudgetMs(base: number): number {
  return onNodePath() ? base * 3 : base
}

export async function advanceFrames(page: Page, frames: number): Promise<void> {
  const from = await page.evaluate(
    () => (window as unknown as { __dogfight?: { frame: number } }).__dogfight?.frame ?? 0,
  )
  await page.waitForFunction(
    ([start, n]) =>
      ((window as unknown as { __dogfight?: { frame: number } }).__dogfight?.frame ?? 0) >=
      start! + n!,
    [from, frames],
    { timeout: 120_000 },
  )
}

export async function capture(page: Page, query: CaptureQuery = {}): Promise<TestHook> {
  const params = captureParams(query)
  // 既定は node。旧経路の project だけ名指しする
  if (!onNodePath()) params.set('path', 'webgl')

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
export async function openLive(page: Page, query = ''): Promise<void> {
  // **タイトルは出さない。**`#title` は `inset: 0` で全面を覆うので、ライブの
  // 検査対象（HUD、リザルト、デバッグ計器）がその下に隠れる。`toBeVisible()`
  // は被覆を見ないので通ってしまい、検査が意味を失う。
  // タイトル自体は「タイトル画面」の describe で検査する
  // **シェーダの事前コンパイルも省く。**4 段ぶんは SwiftShader で 6.6 秒
  // かかり、並列に走らせると起動待ちが 120 秒を超えて落ちた（実測。E2E
  // 全体も 11.8 分から 17.2 分へ延びた）。事前コンパイル自体は専用の
  // describe が見ている
  const sep = query === '' ? '?' : '&'
  const path = onNodePath() ? '' : '&path=webgl'
  await page.goto(`/dogfight/${query}${sep}title=0&precompile=0${path}`)
  await page.waitForFunction(
    () => {
      const hook = (window as unknown as { __dogfight?: { frame: number } }).__dogfight
      return hook !== undefined && hook.frame > 0
    },
    undefined,
    { timeout: 120_000 },
  )
}
