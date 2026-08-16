import { FixedStepDriver } from './sim/loop'
import { World, neutralInput } from './sim/world'
import { createScene } from './render/scene'
import { readCaptureConfig, installTestHook, DEFAULT_SEED } from './render/capture'

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')
if (!canvas) throw new Error('#viewport が見つからない')

const capture = readCaptureConfig(window.location.search)
const seed = capture.enabled ? capture.seed : DEFAULT_SEED

const world = new World({ seed })
const view = createScene(canvas)
const driver = new FixedStepDriver()
const input = neutralInput()

const hook = installTestHook({
  frame: 0,
  captureReady: false,
  seed,
  droppedSteps: 0,
  webglVersion: view.renderer.capabilities.isWebGL2 ? 2 : 1,
})

function applySize() {
  const width = window.innerWidth
  const height = window.innerHeight
  // capture モードでは端末の DPR に依存させない。環境差の主要因になる。
  const pixelRatio = capture.enabled ? 1 : Math.min(window.devicePixelRatio, 2)
  view.resize(width, height, pixelRatio)
}

applySize()
window.addEventListener('resize', applySize)

if (capture.enabled) {
  // 実時間を一切使わず、指定フレーム数だけ進めて 1 枚描く。
  for (let i = 0; i < capture.frame; i++) {
    world.step(input)
  }
  view.sync(world.frame, 0)
  view.render()
  hook.frame = world.frame
  hook.captureReady = true
  document.body.dataset['captureReady'] = '1'
} else {
  let lastTime = performance.now()

  const frame = (now: number) => {
    const delta = (now - lastTime) / 1000
    lastTime = now

    const alpha = driver.advance(delta, () => world.step(input))

    view.sync(world.frame, alpha)
    view.render()

    hook.frame = world.frame
    hook.droppedSteps = driver.droppedSteps

    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}
