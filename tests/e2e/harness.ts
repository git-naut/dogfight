import { expect, type Page } from '@playwright/test'
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

export async function capture(page: Page, query: CaptureQuery = {}): Promise<TestHook> {
  const params = captureParams(query)

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
