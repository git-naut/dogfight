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

/** 既定の project 名。`playwright.config.ts` の projects[0].name と揃える */
export const DEFAULT_PROJECT = 'chromium-swiftshader'
