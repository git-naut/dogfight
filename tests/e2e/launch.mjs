// スクリーンショットを撮るときのブラウザ設定。
//
// **ここが正本。**`playwright.config.ts` と `tools/exact.mjs` の両方が読む。
// 写しを持たせると、片方だけ直したときに画素がずれる。引数が 1 つ違うだけで
// ラスタライザが変わり、「動いた」の理由が追えなくなる。
//
// 素の JavaScript で書く。`tools/exact.mjs` は node が変換なしで実行する
// ため。型は `launch.d.mts` で与える。

/**
 * GPU を使わず Chromium 内蔵のソフトウェアレンダラ SwiftShader に固定する。
 * 遅い代わりに、どのマシンでも同じピクセルが出る。
 */
export const SWIFTSHADER_ARGS = [
  '--use-gl=swiftshader',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
]

/**
 * WebGPU を Dawn の SwiftShader Vulkan バックエンドで動かす引数。
 *
 * フラグなしだと `navigator.gpu` はあるが `requestAdapter()` が null を返す。
 * **`about:blank` では `navigator.gpu` そのものが undefined になる。**保安
 * コンテキストではないため。localhost 由来のページで測ること。これで 1 度
 * 「WebGPU は使えない」と誤読した。
 */
export const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-vulkan-surface',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
]

/** 撮る窓の大きさ。変えると基準画像が全部撮り直しになる */
export const VIEWPORT = { width: 1280, height: 720 }

/** 基準画像のファイル名に付く接尾辞を組み立てる */
export function snapshotSuffix(project) {
  return `-${project}-linux.png`
}

/**
 * project 名から Chromium の起動引数を選ぶ。
 *
 * **ここが正本。**`playwright.config.ts` と `tools/exact.mjs` の両方が読む。
 * 以前は `exact.mjs` が `--project` を受け取りながら、起動は常に
 * `SWIFTSHADER_ARGS` に固定していた。`--project chromium-webgpu` を渡すと
 * **WebGPU で撮った基準画像を、WebGPU が立たないブラウザの絵と比べる。**
 * 退避路で GLSL に落ちるので絵は出てしまい、HUD の 13 枚が「2 回撮ると
 * 画素が動く」という嘘の結論になった（2026-09-14）。
 *
 * 未知の名前は落とす。既定へ倒すと、綴りを間違えた瞬間に別の設定で走る。
 */
export function launchArgsFor(project) {
  switch (project) {
    // 主 project と node 経路の突き合わせ。WebGPU を立てる
    case 'chromium-webgpu':
    case 'chromium-node':
      return [...WEBGPU_ARGS]
    // 旧経路と、WebGPU が無いときの退避路。WebGPU を立てない
    case 'chromium-swiftshader':
    case 'chromium-node-gl':
      return [...SWIFTSHADER_ARGS]
    default:
      throw new Error(`起動引数を知らない project: ${project}`)
  }
}

/**
 * 既定の project 名。`playwright.config.ts` の projects[0].name と揃える。
 *
 * **2026-09-14 に `chromium-webgpu` へ切り替えた。**既定の描画経路が node に
 * なったので、基準画像 42 枚もこの名前で撮る。旧経路は `WEBGL=1` で回すと
 * `chromium-swiftshader` の 42 枚と突き合わせられる
 */
export const DEFAULT_PROJECT = 'chromium-webgpu'
