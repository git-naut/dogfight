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
import { KeyboardInput } from './input/keyboard'
import { MouseLook } from './input/mouseLook'
import { createDebugPanel } from './hud/debugPanel'

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')
const hudRoot = document.querySelector<HTMLElement>('#hud')
if (!canvas || !hudRoot) throw new Error('#viewport か #hud が見つからない')

const capture = readCaptureConfig(window.location.search)
const view = createScene(canvas)
const sample = createAircraftSample()

const hook = installTestHook({
  frame: 0,
  captureReady: false,
  seed: DEFAULT_SEED,
  droppedSteps: 0,
  webglVersion: view.renderer.capabilities.isWebGL2 ? 2 : 1,
  speed: 0,
  altitude: 0,
  angleOfAttack: 0,
  bank: 0,
  crashed: false,
  script: capture.script,
})

function applySize() {
  const width = window.innerWidth
  const height = window.innerHeight
  // capture モードでは端末の DPR に依存させない。環境差の主要因になる
  const pixelRatio = capture.enabled ? 1 : Math.min(window.devicePixelRatio, 2)
  view.resize(width, height, pixelRatio)
}

applySize()
window.addEventListener('resize', applySize)

function publish(frame: number) {
  hook.frame = frame
  hook.speed = sample.speed
  hook.altitude = sample.altitude
  hook.angleOfAttack = sample.angleOfAttack
  hook.bank = sample.bank
  hook.crashed = sample.crashed
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
  view.sync(sample, 0, { yaw: 0, pitch: 0 }, true)
  view.render()

  publish(world.frame)
  hook.captureReady = true
  document.body.dataset['captureReady'] = '1'
} else {
  const keyboard = new KeyboardInput()
  const mouse = new MouseLook()
  keyboard.attach(window)
  mouse.attach(canvas)

  const debug = isDebugEnabled(window.location.search)
    ? createDebugPanel(hudRoot)
    : null

  const driver = new FixedStepDriver()
  let world = spawnWorld()
  let lastTime = performance.now()
  let smoothedFps = 60

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
    }

    const input = keyboard.poll(delta)
    const alpha = driver.advance(delta, () => world.step(input))

    world.samplePlayer(alpha, sample)
    view.sync(sample, delta, mouse.update(delta))
    view.render()

    if (delta > 0) {
      smoothedFps += (1 / delta - smoothedFps) * 0.08
    }
    publish(world.frame)
    hook.droppedSteps = driver.droppedSteps
    debug?.update(sample, world.frame, smoothedFps)

    requestAnimationFrame(frame)
  }

  // 初期姿勢でカメラを定位置に置いてから回し始める
  world.samplePlayer(1, sample)
  view.sync(sample, FIXED_DT, mouse.offset, true)
  requestAnimationFrame(frame)
}
