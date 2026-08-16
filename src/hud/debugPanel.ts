import type { AircraftSample } from '../sim/aircraft'
import { AIRCRAFT } from '../sim/flightModel'

/**
 * 飛行モデル調整用の計器。
 *
 * Phase 5 で作る HUD とは別物。速度も迎角も見えない状態で手触りを判断するのは
 * 無理があるので、数値を追える読み取り専用のオーバーレイを先に置く。
 * ?debug=1 のときだけ出す。
 */

const DEG = 180 / Math.PI

interface Row {
  label: string
  value: HTMLSpanElement
}

export interface DebugPanel {
  update(sample: AircraftSample, frame: number, fps: number): void
  dispose(): void
}

export function createDebugPanel(host: HTMLElement): DebugPanel {
  const root = document.createElement('div')
  root.className = 'debug-panel'

  const rows: Record<string, Row> = {}
  const order = [
    ['speed', '速度'],
    ['mach', 'マッハ'],
    ['altitude', '高度'],
    ['aoa', '迎角'],
    ['beta', '横滑り'],
    ['bank', 'バンク'],
    ['g', 'G'],
    ['throttle', 'スロットル'],
    ['frame', 'フレーム'],
    ['fps', 'FPS'],
  ] as const

  for (const [key, label] of order) {
    const row = document.createElement('div')
    row.className = 'debug-row'

    const name = document.createElement('span')
    name.className = 'debug-label'
    name.textContent = label

    const value = document.createElement('span')
    value.className = 'debug-value'
    value.textContent = '-'

    row.append(name, value)
    root.append(row)
    rows[key] = { label, value }
  }

  const status = document.createElement('div')
  status.className = 'debug-status'
  root.append(status)

  const help = document.createElement('div')
  help.className = 'debug-help'
  help.textContent =
    'S/W ピッチ · A/D ロール · Q/E ヨー · Shift/Ctrl スロットル · 右ドラッグ 視点 · R リセット'
  root.append(help)

  host.append(root)

  const set = (key: string, text: string) => {
    const row = rows[key]
    if (row) row.value.textContent = text
  }

  return {
    update(sample, frame, fps) {
      set('speed', `${sample.speed.toFixed(0)} m/s (${(sample.speed * 1.94384).toFixed(0)} kt)`)
      // 音速は高度で変わるが、目安として海面の 340 m/s で割る
      set('mach', (sample.speed / 340).toFixed(2))
      set('altitude', `${sample.altitude.toFixed(0)} m (${(sample.altitude * 3.28084).toFixed(0)} ft)`)
      set('aoa', `${(sample.angleOfAttack * DEG).toFixed(1)}°`)
      set('beta', `${(sample.sideslip * DEG).toFixed(1)}°`)
      set('bank', `${(sample.bank * DEG).toFixed(0)}°`)
      set('g', sample.loadFactor.toFixed(2))
      set('throttle', `${(sample.throttle * 100).toFixed(0)}%`)
      set('frame', String(frame))
      set('fps', fps.toFixed(0))

      const warnings: string[] = []
      if (sample.crashed) warnings.push('墜落')
      if (sample.stalled) warnings.push('失速')
      if (sample.loadFactor > AIRCRAFT.gLimit * 0.95) warnings.push('G 制限')
      if (sample.altitude < 150 && !sample.crashed) warnings.push('低高度')

      status.textContent = warnings.join(' / ')
      status.classList.toggle('is-active', warnings.length > 0)
    },

    dispose() {
      root.remove()
    },
  }
}
