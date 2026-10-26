/**
 * WebGPU が要ることの確かめ。
 *
 * 段 S1 で GLSL 退避路（`WebGLRenderer`）を捨て、WebGPU を必須にした。
 * WebGPU の無いブラウザでは場面を立てず、利用者に理由を出して止める。
 * 止めた表示は `main.ts` の `main().catch` が出す（`#boot` を赤字にし、
 * `body[data-init-error="1"]` を立てる）。
 */

/** WebGPU が取れない理由 */
export type WebGPUMissing = 'no-api' | 'no-adapter' | 'not-webgpu-backend'

/**
 * WebGPU が無いので場面を立てられない。
 *
 * **専用の型で投げる。**呼ぶ側が文言で判定すると、文言を直した瞬間に
 * 判定が黙って外れる（段 20b）。`reason` で分ける
 */
export class WebGPUUnavailable extends Error {
  override readonly name = 'WebGPUUnavailable'
  constructor(readonly reason: WebGPUMissing) {
    super(webgpuMissingMessage(reason))
  }
}

/**
 * 利用者に出す文言。開発者向けの言葉（ADR の番号や経路の名前）は入れない
 */
export function webgpuMissingMessage(reason: WebGPUMissing): string {
  const lead =
    'このゲームは WebGPU で描きます。WebGPU に対応したブラウザ（Chrome や Edge の新しい版など）で開いてください。'
  switch (reason) {
    case 'no-api':
      // `navigator.gpu` が無いのは、ブラウザが対応していないか、保安コンテキスト
      // （https か localhost）でない場合
      return `${lead}\nこのブラウザには WebGPU の機能がありません。https のページで開いているかも確かめてください。`
    case 'no-adapter':
      // 対応していても、GPU や設定によってはアダプタが取れない
      return `${lead}\nWebGPU は使えますが、この端末の GPU を使う許可が得られませんでした。`
    case 'not-webgpu-backend':
      return `${lead}\nWebGPU の初期化が WebGL へ落ちました。`
  }
}

/**
 * WebGPU のアダプタが取れるかを訊く。取れなければ理由を返す。
 *
 * **キャンバスを掴む前に訊く。**`WebGPURenderer` は WebGPU が無いと黙って
 * WebGL2 へ落ちてキャンバスのコンテキストを取る。取ったあとで捨てても
 * 無駄な初期化が 1 回走る。
 *
 * `navigator.gpu` が無いのは保安コンテキストでない場合か、対応していない
 * ブラウザ。`requestAdapter()` が null を返すのは起動引数が足りない場合
 * （`--enable-unsafe-webgpu` など）や、GPU が拒まれた場合。
 */
export async function findWebGPUMissing(): Promise<WebGPUMissing | null> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (gpu === undefined) return 'no-api'
  try {
    return (await gpu.requestAdapter()) !== null ? null : 'no-adapter'
  } catch {
    return 'no-adapter'
  }
}
