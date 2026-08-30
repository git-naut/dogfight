import { formatClock } from './readout'
import { buildResult, type ResultSource } from './result'

/**
 * リザルト画面。
 *
 * **DOM で作る。**HUD の計器は canvas だが、これは文字とレイアウトが主なので
 * DOM のほうが素直（`debugPanel.ts` と `benchPanel.ts` が同じ判断）。
 * フォーカスもタブ順も拡大縮小もブラウザ任せにできる。
 *
 * **`#hud` の中には入れない。**あちらは `pointer-events: none` で操作できず、
 * `aria-hidden="true"` でスクリーンリーダからも消える。兄弟として `#result` を
 * 置く（`index.html`）。
 *
 * 数値の組み立ては `result.ts` が持つ。ここは DOM を書くだけ。
 */

export interface ResultPanel {
  /** 出す。決着したら呼ぶ */
  show(source: ResultSource): void
  /** 消す。やり直すときに呼ぶ */
  hide(): void
  /** 出ているか */
  readonly visible: boolean
  dispose(): void
}

/** 行を 1 つ作る */
function row(label: string, value: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'result-row'
  const l = document.createElement('span')
  l.textContent = label
  const v = document.createElement('span')
  v.textContent = value
  div.append(l, v)
  return div
}

export function createResultPanel(host: HTMLElement): ResultPanel {
  const panel = document.createElement('div')
  panel.className = 'result-panel'
  host.append(panel)

  let shown = false

  return {
    get visible(): boolean {
      return shown
    },

    show(source: ResultSource): void {
      const r = buildResult(source, formatClock)

      // 作り直す。前回の行が残らないようにする
      panel.replaceChildren()

      const title = document.createElement('h1')
      title.className = 'result-title'
      title.id = 'result-title'
      title.textContent = r.title
      panel.append(title)

      // 理由は失敗のときだけ。成功で空行を出さない
      if (r.reason !== '') {
        const reason = document.createElement('p')
        reason.className = 'result-reason'
        reason.textContent = r.reason
        panel.append(reason)
      }

      panel.append(
        row('戦果', r.tally),
        row('経過', r.elapsed),
        row('命中率', r.accuracy),
        row('消費', r.spent),
      )

      const hint = document.createElement('p')
      hint.className = 'result-hint'
      hint.textContent = 'R でやり直す'
      panel.append(hint)

      host.classList.toggle('is-failed', !r.cleared)
      host.classList.remove('is-hidden')
      host.removeAttribute('hidden')
      shown = true
    },

    hide(): void {
      host.classList.add('is-hidden')
      host.setAttribute('hidden', '')
      shown = false
    },

    dispose(): void {
      panel.remove()
    },
  }
}
