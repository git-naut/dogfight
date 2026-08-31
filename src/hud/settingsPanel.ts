import { PRESET_ORDER, type PresetName } from '../render/quality'
import { CONTROL_MODES, type ControlMode } from '../sim/assist'
import {
  MIN_SENSITIVITY,
  MAX_SENSITIVITY,
  type Settings,
} from './settings'

/**
 * 設定画面。
 *
 * **5 項目だけ。**品質、音量、マウス感度、時刻、操作の型。
 * `CLAUDE.md` の「プリセットに載らない設定項目を作らない」に従い、描画は
 * 4 段のプリセットを選ぶだけにする。影のカスケード段数や雲の方式を個別に
 * 出すと、プリセット表が意味を失う。
 *
 * **値の保持はここではない。**`settings.ts` が持つ。ここは DOM を書いて、
 * 変わったら `onChange` を呼ぶだけ（`result.ts` と `resultPanel.ts` の
 * 分け方と同じ）。
 */

export interface SettingsPanel {
  show(): void
  hide(): void
  readonly visible: boolean
  /** 外から値を変えたときに表示を合わせる（自動降格など） */
  sync(settings: Settings): void
  dispose(): void
}

export interface SettingsOptions {
  /** どれか 1 つが変わるたびに呼ぶ。即座に効かせる */
  onChange: (settings: Settings) => void
  /** 閉じるが押された */
  onClose: () => void
}

/** 品質プリセットの表示名 */
const PRESET_LABELS: Record<PresetName, string> = {
  low: '低',
  medium: '中',
  high: '高',
  ultra: '最高',
}

/** 操作の型の表示名 */
const MODE_LABELS: Record<ControlMode, string> = {
  expert: 'エキスパート',
  standard: 'スタンダード',
}

/** ラベルと中身を 1 行に並べる */
function row(label: string, control: HTMLElement, readout?: HTMLElement): HTMLElement {
  const div = document.createElement('div')
  div.className = 'settings-row'
  const l = document.createElement('label')
  l.textContent = label
  div.append(l, control)
  if (readout) div.append(readout)
  // クリックで対応する入力へ飛ばす
  const id = `settings-${control.getAttribute('data-key') ?? ''}`
  control.id = id
  l.htmlFor = id
  return div
}

export function createSettingsPanel(
  host: HTMLElement,
  initial: Settings,
  options: SettingsOptions,
): SettingsPanel {
  let current: Settings = initial
  let shown = false

  const panel = document.createElement('div')
  panel.className = 'settings-panel'
  /**
   * 開いたときの焦点をここに置く。
   *
   * **最初の項目に置かない。**`select` に焦点があると `Space` が画質の
   * ドロップダウンを開き、そのあと `Escape` はドロップダウンを閉じるほうに
   * 消費されて設定が閉じない。実測で確認した（Escape 2 回が要る）。
   * ボタンに置くと `Space` がそれを押す。どこにも吸われない箱に置く
   */
  panel.tabIndex = -1

  const heading = document.createElement('h2')
  heading.className = 'settings-heading'
  heading.id = 'settings-heading'
  heading.textContent = '設定'
  panel.append(heading)

  /** 変更を 1 か所から流す。表示の更新も同時にやる */
  const emit = (next: Settings): void => {
    current = next
    updateReadouts()
    options.onChange(next)
  }

  // 品質プリセット
  const presetSelect = document.createElement('select')
  presetSelect.setAttribute('data-key', 'preset')
  for (const name of PRESET_ORDER) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = PRESET_LABELS[name]
    presetSelect.append(opt)
  }
  presetSelect.addEventListener('change', () => {
    emit({ ...current, preset: presetSelect.value as PresetName })
  })
  panel.append(row('画質', presetSelect))

  // 音量
  const volume = document.createElement('input')
  volume.type = 'range'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.05'
  volume.setAttribute('data-key', 'volume')
  const volumeOut = document.createElement('output')
  volumeOut.className = 'settings-readout'
  volume.addEventListener('input', () => {
    emit({ ...current, volume: Number(volume.value) })
  })
  panel.append(row('音量', volume, volumeOut))

  // マウス感度
  const sensitivity = document.createElement('input')
  sensitivity.type = 'range'
  sensitivity.min = String(MIN_SENSITIVITY)
  sensitivity.max = String(MAX_SENSITIVITY)
  sensitivity.step = '0.05'
  sensitivity.setAttribute('data-key', 'mouseSensitivity')
  const sensitivityOut = document.createElement('output')
  sensitivityOut.className = 'settings-readout'
  sensitivity.addEventListener('input', () => {
    emit({ ...current, mouseSensitivity: Number(sensitivity.value) })
  })
  panel.append(row('視点感度', sensitivity, sensitivityOut))

  // 時刻
  const hour = document.createElement('input')
  hour.type = 'range'
  hour.min = '0'
  hour.max = '24'
  hour.step = '1'
  hour.setAttribute('data-key', 'hour')
  const hourOut = document.createElement('output')
  hourOut.className = 'settings-readout'
  // **`change` で拾う。**`setHour` は環境反射を焼き直すので、つまみを
  // 動かすたびに呼ぶと引っかかる。離した瞬間に 1 回だけ効かせる
  hour.addEventListener('input', () => {
    hourOut.textContent = `${hour.value}時`
  })
  hour.addEventListener('change', () => {
    emit({ ...current, hour: Number(hour.value) })
  })
  panel.append(row('時刻', hour, hourOut))

  // 操作の型
  const mode = document.createElement('select')
  mode.setAttribute('data-key', 'controlMode')
  for (const name of CONTROL_MODES) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = MODE_LABELS[name]
    mode.append(opt)
  }
  mode.addEventListener('change', () => {
    emit({ ...current, controlMode: mode.value as ControlMode })
  })
  panel.append(row('操作', mode))

  const close = document.createElement('button')
  close.className = 'settings-close'
  close.type = 'button'
  close.textContent = '閉じる'
  const onClose = (): void => options.onClose()
  close.addEventListener('click', onClose)
  panel.append(close)

  host.append(panel)

  /**
   * Escape で閉じる。
   *
   * **`KeyboardInput` には足さない。**あちらは操縦のキーを持つ場所で、
   * `Escape` は段 13 のポーズに割り当てる予定がある。開いている間だけ
   * ここが拾えば、割り当ての重複にならない
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    // `event.code` で見る。理由は `main.ts` の `onEscape` と同じ
    if (!shown || event.code !== 'Escape') return
    event.preventDefault()
    options.onClose()
  }
  document.addEventListener('keydown', onKeyDown)

  /** 値を DOM へ書き戻す */
  function updateReadouts(): void {
    presetSelect.value = current.preset
    volume.value = String(current.volume)
    volumeOut.textContent = `${Math.round(current.volume * 100)}%`
    sensitivity.value = String(current.mouseSensitivity)
    sensitivityOut.textContent = `${current.mouseSensitivity.toFixed(2)}倍`
    hour.value = String(current.hour)
    hourOut.textContent = `${current.hour}時`
    mode.value = current.controlMode
  }
  updateReadouts()

  return {
    get visible(): boolean {
      return shown
    },

    sync(settings: Settings): void {
      current = settings
      updateReadouts()
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
      close.removeEventListener('click', onClose)
      document.removeEventListener('keydown', onKeyDown)
      panel.remove()
    },
  }
}
