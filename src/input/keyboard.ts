import { neutralInput, type InputState } from '../sim/input'

/**
 * キーボードから操縦入力を作る。
 *
 * ピッチは「引いて上昇」。S と下矢印で機首上げ、W と上矢印で機首下げ。
 * 実機の操縦桿と同じ向きで、飛行ゲームの既定でもある。
 *
 * スロットルだけは押しっぱなしで増減する量なので、目標値をここで保持する。
 * sim 側の InputState はあくまで「そのフレームの目標」を運ぶだけにする。
 */

/** スロットルが 0 から 1 まで動くのにかかる秒数 */
const THROTTLE_TRAVEL_SECONDS = 2.5

export class KeyboardInput {
  private readonly pressed = new Set<string>()
  private readonly input = neutralInput()
  private throttleTarget = 0.6

  /** R が押されたら立つ。読み取り側が consumeReset() で降ろす */
  private resetRequested = false

  attach(target: Window = window): () => void {
    const onDown = (event: KeyboardEvent) => {
      // ブラウザのショートカットと衝突するキーだけ止める
      if (SCROLL_KEYS.has(event.code)) event.preventDefault()
      this.pressed.add(event.code)
      if (event.code === 'KeyR') this.resetRequested = true
    }
    const onUp = (event: KeyboardEvent) => this.pressed.delete(event.code)
    // フォーカスを失うとキーの離しを取りこぼす。押しっぱなし状態を残さない
    const onBlur = () => this.pressed.clear()

    target.addEventListener('keydown', onDown)
    target.addEventListener('keyup', onUp)
    target.addEventListener('blur', onBlur)

    return () => {
      target.removeEventListener('keydown', onDown)
      target.removeEventListener('keyup', onUp)
      target.removeEventListener('blur', onBlur)
    }
  }

  /** 前フレームからの経過秒を渡して、このフレームの入力を得る。 */
  poll(dt: number): InputState {
    const held = (code: string) => (this.pressed.has(code) ? 1 : 0)

    // 引いて上昇。S と下矢印が機首上げ
    this.input.pitch =
      held('KeyS') + held('ArrowDown') - held('KeyW') - held('ArrowUp')
    this.input.roll =
      held('KeyD') + held('ArrowRight') - held('KeyA') - held('ArrowLeft')
    this.input.yaw = held('KeyE') - held('KeyQ')

    const throttleDelta =
      (held('ShiftLeft') + held('ShiftRight') - held('ControlLeft') - held('ControlRight')) *
      (dt / THROTTLE_TRAVEL_SECONDS)
    this.throttleTarget = clamp01(this.throttleTarget + throttleDelta)
    this.input.throttle = this.throttleTarget

    this.input.fireGun = this.pressed.has('Space')
    this.input.fireMissile = this.pressed.has('KeyF')

    return this.input
  }

  /** リセット要求を取り出して降ろす。 */
  consumeReset(): boolean {
    const requested = this.resetRequested
    this.resetRequested = false
    return requested
  }

  setThrottle(value: number): void {
    this.throttleTarget = clamp01(value)
  }
}

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
])

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
