import { FixedStepDriver, FIXED_DT } from './sim/loop'
import { World, createWorldFromScript } from './sim/world'
import { createAircraftSample } from './sim/aircraft'
import { getScript } from './sim/scripts'
import { spawnFromSpec } from './sim/replay'
import { createScene } from './render/scene'
import { CAPTURE_CONVERGE_FRAMES } from './render/clouds/cloudsPass'
import {
  readCaptureConfig,
  isDebugEnabled,
  installTestHook,
  DEFAULT_SEED,
} from './render/capture'
import { PerformanceGovernor, type PresetName } from './render/quality'
import { KeyboardInput } from './input/keyboard'
import { MouseLook } from './input/mouseLook'
import { createDebugPanel } from './hud/debugPanel'
import { showBenchPanel } from './hud/benchPanel'
import { runBenchSweep } from './render/bench'

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')
const hudRoot = document.querySelector<HTMLElement>('#hud')
if (!canvas || !hudRoot) throw new Error('#viewport か #hud が見つからない')

/**
 * 起動中の表示。
 *
 * 大気の LUT が 4.1 MB あり、そのあと 3D ノイズを焼くので初回は数秒かかる。
 * 何も出さないと真っ黒の画面が続き、読み込み中なのか初期化に失敗したのか
 * 区別がつかない。実際に「ブラックアウトした」という報告が出た。
 */
const boot = document.querySelector<HTMLElement>('#boot')
const bootText = document.querySelector<HTMLElement>('#boot-text')
const setBoot = (text: string) => {
  if (bootText) bootText.textContent = text
}
const finishBoot = () => {
  if (!boot) return
  boot.classList.add('is-done')
  // DOM から外すところまでやる。フェード中の不透明度が撮影結果に混ざると、
  // 「同じフレームからは同じピクセル」という前提が崩れる。実際に決定論の
  // E2E が CI で落ちた。キャプチャモードは実時間を使わないので待たない
  if (capture.enabled) boot.remove()
  else window.setTimeout(() => boot.remove(), 500)
}

const capture = readCaptureConfig(window.location.search)

// 大気の LUT は tools/copy-atmosphere-assets.mjs が public/atmosphere/ へ置く。
// GitHub Pages ではサイトが /dogfight/ 配下に出るので BASE_URL を挟む
const TEXTURES_URL = `${import.meta.env.BASE_URL}atmosphere/`
// 機体は tools/ac3d-to-glb.mjs が public/aircraft/ へ置く
const AIRCRAFT_URL = `${import.meta.env.BASE_URL}aircraft/f18.glb`

const hook = installTestHook({
  frame: 0,
  captureReady: false,
  seed: DEFAULT_SEED,
  droppedSteps: 0,
  webglVersion: 0,
  atmosphereReady: false,
  sunElevation: 0,
  sunRadiance: [0, 0, 0],
  skyRadiance: [0, 0, 0],
  noiseMs: 0,
  noiseStats: { min: 0, max: 0, mean: 0 },
  gpuFrameMs: 0,
  gpuCloudMs: 0,
  gpuTimerSupported: false,
  cloudHdrTarget: false,
  benchMs: 0,
  benchSweep: [],
  cloudSamples: { mean: 0, max: 0, p99: 0 },
  terrainMs: 0,
  terrainStats: { min: 0, max: 0, mean: 0 },
  terrainPatches: 0,
  terrainTriangles: 0,
  aircraftTriangles: 0,
  preset: capture.preset,
  hour: capture.hour,
  speed: 0,
  altitude: 0,
  agl: 0,
  groundHeight: 0,
  elevator: 0,
  aileron: 0,
  rudder: 0,
  aircraftSurfaces: 0,
  environmentReady: false,
  aircraftShadowReady: false,
  drawCalls: 0,
  drawnTriangles: 0,
  angleOfAttack: 0,
  bank: 0,
  crashed: false,
  script: capture.script,
})

const sample = createAircraftSample()

async function main(): Promise<void> {
  setBoot('大気の散乱テーブルを読み込み中')
  const view = await createScene(canvas!, {
    preset: capture.preset,
    hour: capture.hour,
    texturesUrl: TEXTURES_URL,
    aircraftUrl: AIRCRAFT_URL,
    coverage: capture.coverage,
    qualityOverride: {
      ...(capture.cloudScale !== null ? { resolutionScale: capture.cloudScale } : {}),
      ...(capture.cloudSteps !== null ? { maxSteps: capture.cloudSteps } : {}),
      ...(capture.cloudLight !== null ? { lightSteps: capture.cloudLight } : {}),
      ...(capture.lodScale !== null ? { lodDistanceScale: capture.lodScale } : {}),
      ...(capture.terrainCells !== null ? { terrainPatchCells: capture.terrainCells } : {}),
    },
    ...(capture.exposure !== null ? { exposure: capture.exposure } : {}),
    cloudProbe: capture.probe,
    cloudTemporal: !capture.noTemporal,
    cloudCaptureMode: capture.enabled,
    showTerrain: capture.showTerrain,
    showWater: capture.showWater,
    showEnvironment: capture.showEnvironment,
    showAircraftShadow: capture.showAircraftShadow,
  })

  setBoot('描画の準備中')
  hook.webglVersion = view.renderer.capabilities.isWebGL2 ? 2 : 1
  hook.atmosphereReady = true
  hook.sunElevation = view.sunElevation
  hook.sunRadiance = view.sunRadiance.toArray()
  hook.skyRadiance = view.skyRadiance.toArray()
  hook.noiseMs = view.noiseMs
  hook.noiseStats = view.noiseStats
  hook.gpuTimerSupported = view.gpuTimerSupported
  hook.cloudHdrTarget = view.cloudHdrTarget
  hook.terrainMs = view.terrainMs
  hook.terrainStats = view.terrainStats
  hook.aircraftTriangles = view.aircraftTriangles
  hook.aircraftSurfaces = view.aircraftSurfaces
  hook.environmentReady = view.environmentReady
  hook.aircraftShadowReady = view.aircraftShadowReady
  hook.drawCalls = view.drawCalls
  hook.drawnTriangles = view.drawnTriangles

  const applySize = () => {
    // capture モードでは端末の DPR に依存させない。環境差の主要因になる
    // キャプチャは DPR 1 に固定する。基準画像を機械に依らせないため。
    // ただし計測モードは別で、実際に遊ぶ解像度で測らないと意味がない。
    // 実測で DPR 1.5 と 1.0 では画素数が 2.25 倍違い、そのぶん値がずれた
    const dpr = capture.enabled && !capture.sweep ? 1 : window.devicePixelRatio
    view.resize(window.innerWidth, window.innerHeight, dpr)
  }
  applySize()
  window.addEventListener('resize', applySize)

  const publish = (frame: number) => {
    hook.frame = frame
    hook.speed = sample.speed
    hook.altitude = sample.altitude
    hook.agl = sample.agl
    hook.groundHeight = sample.groundHeight
    hook.elevator = sample.elevator
    hook.aileron = sample.aileron
    hook.rudder = sample.rudder
    hook.terrainPatches = view.terrainPatches
    hook.terrainTriangles = view.terrainTriangles
    hook.aircraftTriangles = view.aircraftTriangles
  hook.aircraftSurfaces = view.aircraftSurfaces
  hook.environmentReady = view.environmentReady
  hook.aircraftShadowReady = view.aircraftShadowReady
  hook.drawCalls = view.drawCalls
  hook.drawnTriangles = view.drawnTriangles
    hook.angleOfAttack = sample.angleOfAttack
    hook.bank = sample.bank
    hook.crashed = sample.crashed
    hook.sunElevation = view.sunElevation
  hook.sunRadiance = view.sunRadiance.toArray()
  hook.skyRadiance = view.skyRadiance.toArray()
  hook.noiseMs = view.noiseMs
  hook.noiseStats = view.noiseStats
  hook.gpuTimerSupported = view.gpuTimerSupported
  }

  if (capture.enabled) {
    // 実時間を一切使わず、スクリプトを指定フレームまで再生して 1 枚描く
    const script = getScript(capture.script)
    const { world, player } = createWorldFromScript(script)
    hook.seed = script.seed
    hook.script = script.name

    for (let i = 0; i < capture.frame; i++) {
      world.step(player.at(i))
    }

    world.samplePlayer(1, sample)
    view.setTrailSource(world.player)
    view.sync(sample, world.frame, 0, { yaw: 0, pitch: 0 }, true)

    // 雲は時間方向に足し込むので、1 枚だけ描いても収束しない。
    // カメラを止めたまま必要な本数を描く。実時間は使わないので決定論は保たれる
    for (let i = 0; i < CAPTURE_CONVERGE_FRAMES; i++) view.render()

    if (capture.probe > 0) hook.cloudSamples = view.readCloudProbe()

    if (capture.sweep) {
      const rows = await runBenchSweep(view, capture.bench > 0 ? capture.bench : 40)
      hook.benchSweep = rows
      if (hudRoot) showBenchPanel(hudRoot, rows)
    } else if (capture.bench > 0) {
      const gl = view.renderer.getContext()
      const pixel = new Uint8Array(4)
      // gl.finish() では足りない。Chrome は描画コマンドを溜めるので、
      // 読み戻しで排出させないと投入時間しか測れない。実測で全解像度が
      // 1/4 解像度より速く出て気づいた
      const drain = () => {
        gl.finish()
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      }

      // 1 回目はシェーダのコンパイルとテクスチャの常駐化が混ざるので捨てる
      view.render()
      drain()

      const started = performance.now()
      for (let i = 0; i < capture.bench; i++) {
        view.render()
        drain()
      }
      hook.benchMs = (performance.now() - started) / capture.bench
    }

    publish(world.frame)
    hook.captureReady = true
    finishBoot()
    document.body.dataset['captureReady'] = '1'
    return
  }

  const keyboard = new KeyboardInput()
  const mouse = new MouseLook()
  keyboard.attach(window)
  mouse.attach(canvas!)

  const debug = isDebugEnabled(window.location.search)
    ? createDebugPanel(hudRoot!)
    : null

  const driver = new FixedStepDriver()
  const governor = new PerformanceGovernor()
  let preset: PresetName = capture.preset
  let world = spawnWorld()
  view.setTrailSource(world.player)
  let lastTime = performance.now()
  let smoothedFps = 60
  // 1 フレームだけ見ると外れ値に振られるので平滑化して読む
  let cpuSimMs = 0
  let cpuSyncMs = 0
  let cpuRenderMs = 0

  function spawnWorld(): World {
    // 既定のスポーンは level スクリプトと同じ条件にしておく
    const spawn = spawnFromSpec(getScript('level').spawn)
    keyboard.setThrottle(spawn.throttle)
    return new World({
      seed: DEFAULT_SEED,
      aircraft: {
        position: spawn.position,
        velocity: spawn.velocity,
        orientation: spawn.orientation,
        throttle: spawn.throttle,
      },
    })
  }

  const frame = (now: number) => {
    const delta = Math.min((now - lastTime) / 1000, 0.25)
    lastTime = now

    if (keyboard.consumeReset()) {
      world = spawnWorld()
      view.setTrailSource(world.player)
      driver.reset()
      mouse.reset()
      governor.reset()
    }

    const input = keyboard.poll(delta)
    const t0 = performance.now()
    const alpha = driver.advance(delta, () => world.step(input))

    const t1 = performance.now()
    world.samplePlayer(alpha, sample)
    view.sync(sample, world.frame, delta, mouse.update(delta))

    const t2 = performance.now()
    view.render()
    const t3 = performance.now()

    cpuSimMs += (t1 - t0 - cpuSimMs) * 0.1
    cpuSyncMs += (t2 - t1 - cpuSyncMs) * 0.1
    cpuRenderMs += (t3 - t2 - cpuRenderMs) * 0.1

    if (delta > 0) {
      smoothedFps += (1 / delta - smoothedFps) * 0.08
    }

    // 重いときは品質を1段落とす。実時間に依存するので capture では動かさない。
    // ?nodegrade=1 のときも止める。品質を固定しないと GPU 時間を比較できない
    const degraded = capture.noDegrade ? null : governor.update(delta, preset)
    if (degraded !== null) {
      preset = degraded
      view.setQuality(preset)
      applySize()
      hook.preset = preset
    }

    publish(world.frame)
    hook.droppedSteps = driver.droppedSteps
    debug?.update(sample, world.frame, smoothedFps, {
      sunElevation: view.sunElevation,
      preset,
      gpuFrameMs: view.gpuFrameMs,
      gpuFrameMaxMs: view.gpuFrameMaxMs,
      gpuCloudMs: view.gpuCloudMs,
      gpuCloudMaxMs: view.gpuCloudMaxMs,
      gpuTimerSupported: view.gpuTimerSupported,
      cpuSimMs,
      cpuSyncMs,
      cpuRenderMs,
      terrainPatches: view.terrainPatches,
      terrainTriangles: view.terrainTriangles,
      aircraftTriangles: view.aircraftTriangles,
      drawingBufferWidth: view.renderer.domElement.width,
      drawingBufferHeight: view.renderer.domElement.height,
      devicePixelRatio: window.devicePixelRatio,
    })

    requestAnimationFrame(frame)
  }

  // 初期姿勢でカメラを定位置に置いてから回し始める
  world.samplePlayer(1, sample)
  view.sync(sample, world.frame, FIXED_DT, mouse.offset, true)
  view.render()
  finishBoot()
  requestAnimationFrame(frame)
}

main().catch((error: unknown) => {
  console.error('[dogfight] 初期化に失敗した', error)
  document.body.dataset['initError'] = '1'
  boot?.classList.add('is-error')
  boot?.classList.remove('is-done')
  setBoot(
    `初期化に失敗しました\n${error instanceof Error ? error.message : String(error)}`,
  )
})
