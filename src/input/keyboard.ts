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
  /** 操縦を受け付けるか。設定画面を開いている間は false */
  private enabled = true

  /**
   * 操縦の受け付けを切り替える。
   *
   * **設定画面が開いている間は止める。**つまみに焦点があるとき矢印キーは
   * 値を動かすためのもので、同時に機体をロールさせては困る。`R` も同じで、
   * 設定を触っているつもりがミッションをやり直すことになる。
   *
   * 止めるときは押しっぱなしを消す。残すとその状態のまま飛び続ける
   * （フォーカスを失ったときの `onBlur` と同じ理由）。
   *
   * **`preventDefault` も止まる。**有効なままだと矢印キーがつまみに届かず、
   * キーボードだけで設定を変えられなくなる
   */
  setEnabled(value: boolean): void {
    this.enabled = value
    if (!value) {
      this.pressed.clear()
      this.resetRequested = false
    }
  }

  attach(target: Window = window): () => void {
    const onDown = (event: KeyboardEvent) => {
      if (!this.enabled) return
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
    this.input.deployFlare = this.pressed.has('KeyC')

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

/** 操作の 1 行 */
export interface ControlHelpEntry {
  /** 画面に出す表記 */
  readonly keys: string
  /** 何が起きるか */
  readonly action: string
  /**
   * 対応する `KeyboardEvent.code`。
   *
   * **表示には使わない。**`poll()` が見ているコードと説明がずれていないことを
   * `tests/input/controlHelp.test.ts` が機械で突き合わせるために持つ。
   * キーボードで操作しないもの（視点の右ドラッグ）は空にする。
   */
  readonly codes: readonly string[]
}

/**
 * 操作の一覧。表示する側が使う。
 *
 * **キー割り当ての正本はこのファイル。**説明を別の場所に書くと、キーを
 * 変えたときに片方だけ古くなる。実際に `debugPanel.ts` の文字列から
 * `Space`（機銃）`KeyF`（ミサイル）`KeyC`（フレア）が抜けていた。
 */
export const CONTROL_HELP: readonly ControlHelpEntry[] = [
  {
    keys: 'S / W',
    action: 'ピッチ',
    codes: ['KeyS', 'KeyW', 'ArrowDown', 'ArrowUp'],
  },
  {
    keys: 'A / D',
    action: 'ロール',
    codes: ['KeyD', 'KeyA', 'ArrowRight', 'ArrowLeft'],
  },
  { keys: 'Q / E', action: 'ヨー', codes: ['KeyE', 'KeyQ'] },
  {
    keys: 'Shift / Ctrl',
    action: 'スロットル',
    codes: ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'],
  },
  { keys: 'Space', action: '機銃', codes: ['Space'] },
  { keys: 'F', action: 'ミサイル', codes: ['KeyF'] },
  { keys: 'C', action: 'フレア', codes: ['KeyC'] },
  { keys: '右ドラッグ', action: '視点', codes: [] },
  { keys: 'R', action: 'やり直す', codes: ['KeyR'] },
  // **判定はこのファイルにない。**`main.ts` がポーズを、`settingsPanel.ts` が
  // 設定を閉じるのに使う。それでも割り当ての正本はここに置く。
  // 置かなかったせいで、Phase 7 まで操作説明にポーズが出ていなかった
  { keys: 'Escape', action: 'ポーズ', codes: ['Escape'] },
]

/** 1 行に並べた操作説明。デバッグパネルのような狭い場所で使う */
export function controlHelpLine(): string {
  return CONTROL_HELP.map((c) => `${c.keys} ${c.action}`).join(' · ')
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
