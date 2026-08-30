import { CONTROL_HELP } from '../input/keyboard'

/**
 * タイトル画面。
 *
 * **開始まで出す。**`#result` と同じ作法で `#hud` の兄弟に置く（あちらは
 * `pointer-events: none` で操作できず、`aria-hidden="true"` でスクリーン
 * リーダからも消える）。
 *
 * **音の初期化の受け皿にする。**ブラウザの autoplay 制限があるので
 * `AudioContext` はユーザ操作に紐づける必要がある。開始ボタンが自然な位置
 * （段 9 で使う）。
 *
 * シミュレーションは止めない。**ポーズは段 13 の範囲。**ここでは重ねて出し、
 * 押したら消すだけにする。
 */

export interface TitlePanel {
  /** 出す */
  show(): void
  /** 消す */
  hide(): void
  readonly visible: boolean
  dispose(): void
}

export interface TitleOptions {
  /** 開始が押されたとき。音の初期化をここに繋ぐ */
  onStart: () => void
  /** 設定が押されたとき */
  onSettings: () => void
}

export function createTitlePanel(
  host: HTMLElement,
  options: TitleOptions,
): TitlePanel {
  const panel = document.createElement('div')
  panel.className = 'title-panel'

  const heading = document.createElement('h1')
  heading.className = 'title-heading'
  heading.id = 'title-heading'
  heading.textContent = 'DOGFIGHT'
  panel.append(heading)

  const subtitle = document.createElement('p')
  subtitle.className = 'title-subtitle'
  subtitle.textContent = '敵 5 機を制限時間内に撃墜せよ'
  panel.append(subtitle)

  // 操作説明。**キー割り当ての正本は `keyboard.ts`。**ここに書き写さない
  const controls = document.createElement('dl')
  controls.className = 'title-controls'
  for (const entry of CONTROL_HELP) {
    const dt = document.createElement('dt')
    dt.textContent = entry.keys
    const dd = document.createElement('dd')
    dd.textContent = entry.action
    controls.append(dt, dd)
  }
  panel.append(controls)

  const buttons = document.createElement('div')
  buttons.className = 'title-buttons'

  const start = document.createElement('button')
  start.className = 'title-start'
  start.type = 'button'
  start.textContent = 'START'
  buttons.append(start)

  const settings = document.createElement('button')
  settings.className = 'title-settings'
  settings.type = 'button'
  settings.textContent = '設定'
  buttons.append(settings)

  panel.append(buttons)
  host.append(panel)

  let shown = false

  const onClick = (): void => {
    options.onStart()
  }
  const onSettings = (): void => {
    options.onSettings()
  }
  start.addEventListener('click', onClick)
  settings.addEventListener('click', onSettings)

  return {
    get visible(): boolean {
      return shown
    },

    show(): void {
      host.classList.remove('is-hidden')
      host.removeAttribute('hidden')
      shown = true
      // キーボードだけでも始められるようにする
      start.focus()
    },

    hide(): void {
      host.classList.add('is-hidden')
      host.setAttribute('hidden', '')
      shown = false
    },

    dispose(): void {
      start.removeEventListener('click', onClick)
      settings.removeEventListener('click', onSettings)
      panel.remove()
    },
  }
}
