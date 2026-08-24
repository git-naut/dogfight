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
/**
 * 何を測ったか。
 *
 * **これがないと表の読み方を間違える。**実機の計測で 3 度、`script` を
 * 渡し忘れて既定の `level` を測っていた（既定値は `capture.ts` の
 * `params.get('script') ?? 'level'`）。表には三角形の総数が出るので
 * 「敵機なし」の行が基準と同じ数のままなのを見れば分かるが、絵の中に
 * 台本の名前が無いと、あとから画像だけを見て確かめられない。
 *
 * 画面の大きさも入れる。GPU 時間は画素数にほぼ比例するので、**窓の
 * 大きさが違う 2 回の計測は比べられない。**
 */
export interface BenchContext {
  script: string
  frame: number
  hour: number
  coverage: number
  preset: string
  noDegrade: boolean
  /** 実際に描いた画素数。レンダースケール込み */
  drawingBufferWidth: number
  drawingBufferHeight: number
  /** 台本が出した敵機と標的機の数。0 なら構図に入っていない */
  enemyCount: number
  targetCount: number
}

export function showBenchPanel(
  root: HTMLElement,
  rows: readonly BenchRow[],
  context: BenchContext,
): void {
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

  const caption = document.createElement('p')
  caption.textContent =
    `台本 ${context.script} / f${context.frame} / ${context.hour.toFixed(1)} 時 / ` +
    `雲量 ${context.coverage.toFixed(2)} / preset ${context.preset}` +
    `${context.noDegrade ? ' / 劣化なし' : ''} / ` +
    `${context.drawingBufferWidth} x ${context.drawingBufferHeight} 画素 / ` +
    `敵機 ${context.enemyCount} 機 / 標的 ${context.targetCount} 機`
  caption.style.cssText = 'margin:0 0 10px;color:#6fa;font-size:13px'
  panel.appendChild(caption)

  const table = document.createElement('table')
  table.style.cssText = 'border-collapse:collapse'

  const headers = [
    '設定',
    'GPU 最小',
    'GPU 中央',
    'CPU 最小',
    'CPU 最大',
    // **地形だけでなく実際に投入した総数。**以前は terrainTriangles を
    // 記録していて、機体や武装を切っても値が動かなかった。実機の計測で
    // 全条件が同じ数のまま並び、「切れているのか」を確かめられなかった
    '三角形（総数）',
    '基準との差',
    // 差がばらつきの内側かどうか。**+0.01 ms を差として読まないため**
    '判定',
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

  /**
   * ばらつきの目安 ms。
   *
   * 最小値と中央値の差を全条件で見て、その中央を取る。最小値を代表値に
   * するのは割り込みが時間を増やす方向にしか効かないからだが、**それでも
   * 最小値そのものが振れる。**この幅より小さい差は読まない。
   *
   * 前回の実機の計測で、武装を切った差が +0.01〜+0.13 ms で並んだ。
   * **すべて正の値**（切ったほうが遅い）だったので、差ではなくばらつき
   * だったと分かる。それを表の上で見分けられるようにする。
   */
  const spreads = rows
    .map((r) => (r.gpuMinMs !== null && r.gpuMedianMs !== null ? r.gpuMedianMs - r.gpuMinMs : null))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const noise = spreads.length > 0 ? spreads[spreads.length >> 1]! : 0

  /** 差がばらつきの内側か、符号が逆（切ったのに遅い）かを判定する */
  const verdict = (delta: number, isBase: boolean): string => {
    if (isBase) return '—'
    if (delta > 0) return `逆（+${delta.toFixed(2)}）`
    if (Math.abs(delta) < noise) return '誤差以下'
    return '有意'
  }
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
      verdict(delta, row === base),
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
    `最小値で読む。割り込みは時間を増やす方向にしか効かないので、最小値だけが環境の騒がしさを拾わない。` +
    `ばらつきの目安は ${noise.toFixed(2)} ms（最小と中央の差の中央値）。これより小さい差は読まない。` +
    `「逆」は切ったのに遅くなった行で、差ではなくばらつき。三角形が動いていない行は、そもそも切れていない`
  note.style.cssText = 'margin:10px 0 0;color:#89a;font-size:12px'

  panel.appendChild(table)
  panel.appendChild(note)
  root.appendChild(panel)
}
