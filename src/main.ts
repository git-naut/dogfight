import { FixedStepDriver, FIXED_DT } from './sim/loop'
import { World, createWorldFromScript } from './sim/world'
import { createAircraftSample } from './sim/aircraft'
import { getScript } from './sim/scripts'
import { spawnFromSpec } from './sim/replay'
import { createScene } from './render/scene'
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

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')
const hudRoot = document.querySelector<HTMLElement>('#hud')
if (!canvas || !hudRoot) throw new Error('#viewport か #hud が見つからない')

const capture = readCaptureConfig(window.location.search)

// 大気の LUT は tools/copy-atmosphere-assets.mjs が public/atmosphere/ へ置く。
// GitHub Pages ではサイトが /dogfight/ 配下に出るので BASE_URL を挟む
const TEXTURES_URL = `${import.meta.env.BASE_URL}atmosphere/`

const hook = installTestHook({
  frame: 0,
  captureReady: false,
  seed: DEFAULT_SEED,
  droppedSteps: 0,
  webglVersion: 0,
  atmosphereReady: false,
  sunElevation: 0,
  noiseMs: 0,
  noiseStats: { min: 0, max: 0, mean: 0 },
  gpuFrameMs: 0,
  gpuCloudMs: 0,
  gpuTimerSupported: false,
  cloudHdrTarget: false,
  benchMs: 0,
  cloudSamples: { mean: 0, max: 0, p99: 0 },
  preset: capture.preset,
  hour: capture.hour,
  speed: 0,
  altitude: 0,
  angleOfAttack: 0,
  bank: 0,
  crashed: false,
  script: capture.script,
})

const sample = createAircraftSample()

async function main(): Promise<void> {
  const view = await createScene(canvas!, {
    preset: capture.preset,
    hour: capture.hour,
    texturesUrl: TEXTURES_URL,
    coverage: capture.coverage,
    cloudOverride: {
      ...(capture.cloudScale !== null ? { resolutionScale: capture.cloudScale } : {}),
      ...(capture.cloudSteps !== null ? { maxSteps: capture.cloudSteps } : {}),
      ...(capture.cloudLight !== null ? { lightSteps: capture.cloudLight } : {}),
    },
    ...(capture.exposure !== null ? { exposure: capture.exposure } : {}),
    cloudProbe: capture.probe,
    ...(capture.exitOverride !== null ? { cloudExitOverride: capture.exitOverride } : {}),
  })

  hook.webglVersion = view.renderer.capabilities.isWebGL2 ? 2 : 1
  hook.atmosphereReady = true
  hook.sunElevation = view.sunElevation
  hook.noiseMs = view.noiseMs
  hook.noiseStats = view.noiseStats
  hook.gpuTimerSupported = view.gpuTimerSupported
  hook.cloudHdrTarget = view.cloudHdrTarget

  const applySize = () => {
    // capture モードでは端末の DPR に依存させない。環境差の主要因になる
    const dpr = capture.enabled ? 1 : window.devicePixelRatio
    view.resize(window.innerWidth, window.innerHeight, dpr)
  }
  applySize()
  window.addEventListener('resize', applySize)

  const publish = (frame: number) => {
    hook.frame = frame
    hook.speed = sample.speed
    hook.altitude = sample.altitude
    hook.angleOfAttack = sample.angleOfAttack
    hook.bank = sample.bank
    hook.crashed = sample.crashed
    hook.sunElevation = view.sunElevation
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
    view.sync(sample, world.frame, 0, { yaw: 0, pitch: 0 }, true)
    view.render()

    if (capture.probe) hook.cloudSamples = view.readCloudProbe()

    if (capture.bench > 0) {
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
      gpuCloudMs: view.gpuCloudMs,
      gpuTimerSupported: view.gpuTimerSupported,
      cpuSimMs,
      cpuSyncMs,
      cpuRenderMs,
      drawingBufferWidth: view.renderer.domElement.width,
      drawingBufferHeight: view.renderer.domElement.height,
      devicePixelRatio: window.devicePixelRatio,
    })

    requestAnimationFrame(frame)
  }

  // 初期姿勢でカメラを定位置に置いてから回し始める
  world.samplePlayer(1, sample)
  view.sync(sample, world.frame, FIXED_DT, mouse.offset, true)
  requestAnimationFrame(frame)
}

main().catch((error: unknown) => {
  console.error('[dogfight] 初期化に失敗した', error)
  document.body.dataset['initError'] = '1'
})
