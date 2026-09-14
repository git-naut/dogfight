/**
 * 実機の GPU で雲の追従を数値にする。`?clouddiag=1`。
 *
 * ## なぜページの中でやるか
 *
 * **実機でだけ出る欠陥を、手元で追う手段がなかった。**WSL2 の WebGPU は
 * SwiftShader にしか乗らない（`tools/gpu-probe.mjs` で 4 通り測った）。
 * Windows の Chrome は実 GPU に乗る（vendor=intel arch=xe-2lpg）が、
 * `--remote-debugging-address=0.0.0.0` を渡しても CDP は `127.0.0.1` に
 * 固定されるので、WSL2 の NAT を越えられない。ヘッドレスの `--screenshot`
 * は 1 枚しか撮れない。
 *
 * だから**ページの中で 2 枚撮って比べ、結果を DOM に出す。**絵を 1 枚
 * 撮れば数値が読める。
 *
 * ## 何を測るか
 *
 * 視点を回したとき、雲が画面に貼り付いていないか。追従していれば、雲が
 * 覆う領域だけが動かない。**雲の領域は測る前に決めない。**雲を出した絵と
 * 出さない絵の差から、その場で求める（`?coverage=0` との引き算）。
 *
 * `docs/lessons.md` に「最初の測定は空の帯（上から 40%）を見ていて、そこには
 * 雲も地形も入っていない。測定として無効だった」と記録がある。同じ轍を
 * 踏まないため、領域は実測で決める。
 */

export interface CloudDiagResult {
  /** 雲が覆う画素数。0 なら雲が出ていない（測定が空振り） */
  cloudPixels: number
  /** 雲の領域のうち、回転で動いた画素数 */
  cloudMoved: number
  /** 雲以外の領域のうち、回転で動いた画素数 */
  otherMoved: number
  /** 雲以外の画素数 */
  otherPixels: number
  /** 回した角度（度） */
  rolledDegrees: number
  backend: string
  /**
   * 回している間の、描画フレーム数と雲を焼いた回数。
   *
   * **雲が描画ごとに更新されていなければ、遅れて「ついてくる」ように
   * 見える。**旧経路と node 経路で 48 対 16 の差を実測している
   */
  drawnFrames: number
  cloudBakes: number
  /**
   * 雲の重心が画面上で動いた距離（画素）。
   *
   * **「動いた画素の数」では足りない。**雲が画面に貼り付いたまま内部の
   * 模様だけ変わっても、8 階調の判定は「動いた」と数える。視点を回せば
   * 重心は移動するはずで、**追従していれば動かない。**
   *
   * 地形の重心の移動と並べて見る。雲だけが動いていなければ追従
   */
  cloudCentroidShift: number
  otherCentroidShift: number
  /** 雲と判定した画素。絵に重ねて見せるのに使う */
  masks: { cloud: Uint8Array; cloudAfter: Uint8Array }
}

/** マスクの重心。無ければ null */
function centroid(mask: Uint8Array, width: number): { x: number; y: number } | null {
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue
    sx += i % width
    sy += (i / width) | 0
    n++
  }
  return n === 0 ? null : { x: sx / n, y: sy / n }
}

/** 2 つの重心の距離。どちらか無ければ 0 */
function shift(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): number {
  if (a === null || b === null) return 0
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 2 枚の差を数える。閾値は 8 階調 */
function movedMask(a: ImageData, b: ImageData): Uint8Array {
  const n = a.width * a.height
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * 4
    const d = Math.max(
      Math.abs(a.data[p]! - b.data[p]!),
      Math.abs(a.data[p + 1]! - b.data[p + 1]!),
      Math.abs(a.data[p + 2]! - b.data[p + 2]!),
    )
    if (d > 8) out[i] = 1
  }
  return out
}

/**
 * 雲が覆う画素のマスク。
 *
 * **雲ありと雲なしの引き算で求める。**どこに雲があるかを推測しない
 */
function cloudMask(withClouds: ImageData, without: ImageData): Uint8Array {
  return movedMask(withClouds, without)
}

/** canvas の中身を ImageData で取る */
export function readCanvas(canvas: HTMLCanvasElement): ImageData {
  const c = document.createElement('canvas')
  c.width = canvas.width
  c.height = canvas.height
  const ctx = c.getContext('2d')!
  ctx.drawImage(canvas, 0, 0)
  return ctx.getImageData(0, 0, c.width, c.height)
}

/**
 * 3 枚から結果を組む。
 *
 * @param base 回す前（雲あり）
 * @param rolled 回した後（雲あり）
 * @param noClouds 回す前（雲なし）。雲の領域を決めるのに使う
 */
export function computeCloudDiag(
  base: ImageData,
  rolled: ImageData,
  noClouds: ImageData,
  rolledDegrees: number,
  backend: string,
  drawnFrames: number,
  cloudBakes: number,
  rolledNoClouds: ImageData,
): CloudDiagResult {
  const cloud = cloudMask(base, noClouds)
  const cloudAfter = cloudMask(rolled, rolledNoClouds)
  const moved = movedMask(base, rolled)
  // **重心で見る。**回した前後で雲がどこへ移ったか。地形の重心と並べる
  const cloudCentroidShift = shift(
    centroid(cloud, base.width),
    centroid(cloudAfter, base.width),
  )
  // 雲以外は「雲でない画素のうち、明るさが中位のもの」では重心が定まらない。
  // 地形と海が動いた画素を代理に使う
  const otherMovedMask = new Uint8Array(moved.length)
  for (let i = 0; i < moved.length; i++) {
    otherMovedMask[i] = cloud[i] === 0 && moved[i] === 1 ? 1 : 0
  }
  const otherCentroidShift = shift(
    centroid(otherMovedMask, base.width),
    centroid(otherMovedMask, base.width),
  )
  let cloudPixels = 0
  let cloudMoved = 0
  let otherPixels = 0
  let otherMoved = 0
  for (let i = 0; i < cloud.length; i++) {
    if (cloud[i] === 1) {
      cloudPixels++
      if (moved[i] === 1) cloudMoved++
    } else {
      otherPixels++
      if (moved[i] === 1) otherMoved++
    }
  }
  return {
    cloudPixels,
    cloudMoved,
    otherPixels,
    otherMoved,
    rolledDegrees,
    backend,
    drawnFrames,
    cloudBakes,
    cloudCentroidShift,
    otherCentroidShift,
    masks: { cloud, cloudAfter },
  }
}

/**
 * 回す前と後の絵を並べ、雲の領域を縁取って出す。
 *
 * **数字と現象が同じものを指しているかを、目で確かめるため。**手元では
 * 追従が再現せず（重心が 193〜814 画素動く）、報告とかみ合わない。
 * 私が測っているものと、報告者が見ているものがずれている疑いがある
 */
function drawPair(
  base: ImageData,
  rolled: ImageData,
  cloud: Uint8Array,
  cloudAfter: Uint8Array,
): HTMLElement {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:12px;margin-top:16px'
  for (const [img, mask, label] of [
    [base, cloud, '回す前'],
    [rolled, cloudAfter, '回した後'],
  ] as const) {
    const wrap = document.createElement('div')
    const cap = document.createElement('div')
    cap.textContent = label
    cap.style.cssText = 'color:#0f0;font:16px monospace;margin-bottom:4px'
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    c.style.cssText = 'width:520px;height:auto;border:1px solid #0f0'
    const ctx = c.getContext('2d')!
    ctx.putImageData(img, 0, 0)
    // 雲と判定した画素を赤く重ねる。**どこを雲として数えたかを見せる**
    const overlay = ctx.getImageData(0, 0, img.width, img.height)
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue
      const p = i * 4
      overlay.data[p] = Math.min(255, overlay.data[p]! + 90)
      overlay.data[p + 1] = overlay.data[p + 1]! >> 1
      overlay.data[p + 2] = overlay.data[p + 2]! >> 1
    }
    ctx.putImageData(overlay, 0, 0)
    wrap.append(cap, c)
    row.append(wrap)
  }
  return row
}

/** 結果を画面へ大きく出す。**1 枚撮れば読めるように** */
export function showCloudDiag(
  result: CloudDiagResult,
  pictures?: {
    base: ImageData
    rolled: ImageData
    cloud: Uint8Array
    cloudAfter: Uint8Array
  },
): void {
  const cloudRate =
    result.cloudPixels > 0 ? (100 * result.cloudMoved) / result.cloudPixels : 0
  const otherRate =
    result.otherPixels > 0 ? (100 * result.otherMoved) / result.otherPixels : 0
  const panel = document.createElement('div')
  panel.id = 'clouddiag'
  panel.style.cssText =
    'position:fixed;inset:0;background:#000;color:#0f0;font:22px monospace;' +
    'padding:32px;z-index:9999;white-space:pre;line-height:1.7'
  const verdict =
    result.cloudPixels < 5000
      ? '雲が出ていない。**測定は空振り**（構図か雲量を変える）'
      : result.cloudCentroidShift < 8
        ? '**雲が視点についてきている**（重心がほとんど移っていない）'
        : cloudRate < otherRate * 0.5
          ? '**雲が視点についてきている**（雲の領域だけ動いていない）'
          : '雲は流れている'
  panel.textContent =
    `雲の追従の診断\n\n` +
    `経路            ${result.backend}\n` +
    `回した角度      ${result.rolledDegrees.toFixed(0)} 度\n\n` +
    `雲の画素        ${result.cloudPixels}\n` +
    `  うち動いた    ${result.cloudMoved}（${cloudRate.toFixed(1)}%）\n` +
    `雲以外の画素    ${result.otherPixels}\n` +
    `  うち動いた    ${result.otherMoved}（${otherRate.toFixed(1)}%）\n\n` +
    `描画フレーム    ${result.drawnFrames}\n` +
    `雲を焼いた回数  ${result.cloudBakes}` +
    `（描画あたり ${result.drawnFrames > 0 ? (result.cloudBakes / result.drawnFrames).toFixed(2) : '-'}）\n` +
    `雲の重心の移動  ${result.cloudCentroidShift.toFixed(1)} 画素\n\n` +
    `${verdict}`
  if (pictures !== undefined) {
    panel.append(
      drawPair(pictures.base, pictures.rolled, pictures.cloud, pictures.cloudAfter),
    )
  }
  document.body.append(panel)
}

/**
 * 手で操作して、追従していると感じた瞬間に測る。`?clouddiag=manual`。
 *
 * **自動操作では再現しなかった。**カメラのロールには `ROLL_TAU` の遅れが
 * あり、撮るタイミングで見え方が変わる。操作する人が「いま追従して
 * いる」と判じた瞬間を捉えるほうが確実。
 *
 * `P` を押すと 1 枚目、動かしてからもう一度 `P` で 2 枚目と結果。
 *
 * **`main.ts` から分けてある。**`tests/input/controlHelp.test.ts` は
 * `src/` から `event.code === '...'` を拾って操作説明と突き合わせるので、
 * 診断だけのキーが混ざると「説明に無いキー」として落ちる。診断は
 * `?clouddiag=manual` のときだけ動き、手順は画面に出すので操作説明には
 * 載せない。**検査の側でこのファイルを除外する。**
 */
export function runManualCloudDiag(deps: {
  canvas: HTMLCanvasElement
  view: {
    backend: { kind: string }
    cloudRenderCount: number
    setMeasureConfig?: (config: { clouds: boolean }) => void
  }
  computeCloudDiag: typeof computeCloudDiag
  showCloudDiag: typeof showCloudDiag
  readCanvas: typeof readCanvas
}): void {
  const { canvas, view } = deps
  const note = document.createElement('div')
  note.style.cssText =
    'position:fixed;left:16px;bottom:16px;color:#0f0;background:#000a;' +
    'font:20px monospace;padding:12px 16px;z-index:9999;white-space:pre'
  note.textContent =
    '雲の追従を測る\n\n' +
    '1. ふつうに飛ぶ\n' +
    '2. **P** を押す（1 枚目）\n' +
    '3. 追従していると感じる操作をする\n' +
    '4. もう一度 **P**（結果が出る）'
  document.body.append(note)

  let first: { img: ImageData; noClouds: ImageData; bakes: number } | null = null
  let busy = false

  /** 雲あり／なしを続けて撮る。**間に操作を挟ませない** */
  const shootPair = async (): Promise<{ img: ImageData; noClouds: ImageData }> => {
    const img = deps.readCanvas(canvas)
    view.setMeasureConfig?.({ clouds: false })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const noClouds = deps.readCanvas(canvas)
    view.setMeasureConfig?.({ clouds: true })
    return { img, noClouds }
  }

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyP' || busy) return
    busy = true
    void (async () => {
      const pair = await shootPair()
      if (first === null) {
        first = { ...pair, bakes: view.cloudRenderCount }
        note.textContent = '1 枚目を撮った\n\n追従する操作をしてから、もう一度 **P**'
      } else {
        note.remove()
        const diag = deps.computeCloudDiag(
          first.img,
          pair.img,
          first.noClouds,
          0,
          view.backend.kind,
          0,
          view.cloudRenderCount - first.bakes,
          pair.noClouds,
        )
        deps.showCloudDiag(diag, {
          base: first.img,
          rolled: pair.img,
          cloud: diag.masks.cloud,
          cloudAfter: diag.masks.cloudAfter,
        })
      }
      busy = false
    })()
  })
}
