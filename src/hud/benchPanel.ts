import type { BenchRow } from '../render/bench'

/**
 * 計測結果を画面へ出す。
 *
 * `?bench` の結果はこれまで `window.__dogfight` にしか載っておらず、実機で
 * 読むには開発者ツールを開く必要があった。計測は実機でしかできないので、
 * 画面に出す。
 *
 * 桁を揃えるのに等幅フォントと空白詰めを使ってはいけない。日本語のラベルは
 * 全角なので、文字数で詰めると表示幅が合わない。実際に列がずれた。表にする。
 *
 * キャプチャモードでしか呼ばないので、スクリーンショット回帰には影響しない。
 */
export function showBenchPanel(root: HTMLElement, rows: readonly BenchRow[]): void {
  const panel = document.createElement('div')
  panel.className = 'bench-panel'
  panel.style.cssText = [
    'position:absolute',
    'left:16px',
    'top:16px',
    'padding:14px 18px',
    'background:rgba(8,16,24,0.86)',
    'color:#8ad4ff',
    'font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
    'border-radius:6px',
  ].join(';')

  const table = document.createElement('table')
  table.style.cssText = 'border-collapse:collapse'

  const headers = [
    '設定',
    'GPU 最小',
    'GPU 中央',
    'CPU 最小',
    'CPU 最大',
    '三角形',
    '基準との差',
  ]
  const head = document.createElement('tr')
  for (const [i, text] of headers.entries()) {
    const th = document.createElement('th')
    th.textContent = text
    th.style.cssText = `text-align:${i === 0 ? 'left' : 'right'};padding:2px 10px;color:#6fa`
    head.appendChild(th)
  }
  table.appendChild(head)

  const base = rows[0]
  // GPU クエリが使えるならそちらで差を出す。無ければ CPU 側で
  const key = (row: BenchRow): number => row.gpuMinMs ?? row.cpuMinMs
  for (const row of rows) {
    const delta = base ? key(row) - key(base) : 0
    const cells = [
      row.label,
      row.gpuMinMs === null ? '-' : `${row.gpuMinMs.toFixed(2)} ms`,
      row.gpuMedianMs === null ? '-' : `${row.gpuMedianMs.toFixed(2)} ms`,
      `${row.cpuMinMs.toFixed(2)} ms`,
      `${row.cpuMaxMs.toFixed(2)} ms`,
      `${(row.triangles / 1000).toFixed(0)}k`,
      `${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ms`,
    ]
    const tr = document.createElement('tr')
    for (const [i, text] of cells.entries()) {
      const td = document.createElement('td')
      td.textContent = text
      td.style.cssText = `text-align:${i === 0 ? 'left' : 'right'};padding:2px 10px`
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }

  const note = document.createElement('p')
  note.textContent =
    '最小値で読む。割り込みは時間を増やす方向にしか効かないので、最小値だけが環境の騒がしさを拾わない。GPU 側と CPU 側が食い違うときは、どちらも疑う'
  note.style.cssText = 'margin:10px 0 0;color:#89a;font-size:12px'

  panel.appendChild(table)
  panel.appendChild(note)
  root.appendChild(panel)
}
