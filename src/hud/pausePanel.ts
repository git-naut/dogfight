/**
 * ポーズ画面。
 *
 * **`#hud` の中には入れない。**あちらは `pointer-events: none` で操作できず、
 * `aria-hidden="true"` でスクリーンリーダからも消える（`resultPanel.ts` と
 * 同じ理由）。
 *
 * 出しているあいだ `FixedStepDriver` を回さない。復帰のとき `reset()` を
 * 呼んで蓄積を捨てる。捨てないと、止まっていた秒数ぶんのステップをまとめて
 * 進めようとして、そこで大きく飛ぶ。
 */

export interface PausePanel {
  show(): void
  hide(): void
  readonly visible: boolean
  dispose(): void
}

export interface PauseOptions {
  /** 再開が押された */
  onResume: () => void
  /** 設定が押された */
  onSettings: () => void
}

export function createPausePanel(host: HTMLElement, options: PauseOptions): PausePanel {
  const panel = document.createElement('div')
  panel.className = 'pause-panel'
  /**
   * 焦点をここに置く。
   *
   * **ボタンに置かない。**`Space` がそれを押してしまう。設定画面で同じ
   * ことを踏んだ（`settingsPanel.ts`）
   */
  panel.tabIndex = -1

  const heading = document.createElement('h2')
  heading.className = 'pause-heading'
  heading.id = 'pause-heading'
  heading.textContent = 'PAUSED'
  panel.append(heading)

  const buttons = document.createElement('div')
  buttons.className = 'pause-buttons'

  const resume = document.createElement('button')
  resume.className = 'pause-resume'
  resume.type = 'button'
  resume.textContent = '再開'
  buttons.append(resume)

  const settings = document.createElement('button')
  settings.className = 'pause-settings'
  settings.type = 'button'
  settings.textContent = '設定'
  buttons.append(settings)

  panel.append(buttons)

  const hint = document.createElement('p')
  hint.className = 'pause-hint'
  hint.textContent = 'Escape で再開'
  panel.append(hint)

  host.append(panel)

  let shown = false

  const onResume = (): void => options.onResume()
  const onSettings = (): void => options.onSettings()
  resume.addEventListener('click', onResume)
  settings.addEventListener('click', onSettings)

  return {
    get visible(): boolean {
      return shown
    },

    show(): void {
      host.classList.remove('is-hidden')
      host.removeAttribute('hidden')
      shown = true
      panel.focus()
    },

    hide(): void {
      host.classList.add('is-hidden')
      host.setAttribute('hidden', '')
      shown = false
    },

    dispose(): void {
      resume.removeEventListener('click', onResume)
      settings.removeEventListener('click', onSettings)
      panel.remove()
    },
  }
}
