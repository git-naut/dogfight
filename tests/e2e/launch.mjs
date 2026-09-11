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
 * 既定の project 名。`playwright.config.ts` の projects[0].name と揃える。
 *
 * **段 20b で `chromium-swiftshader` から `chromium-webgpu` へ移した。**
 * 既定の経路が node になったので、基準画像もそちらの project が持つ。
 * 旧 42 枚は `*-chromium-swiftshader-linux.png` として残る
 */
export const DEFAULT_PROJECT = 'chromium-webgpu'

/**
 * project ごとの起動引数。
 *
 * **project 名と起動引数の対応はここ 1 か所で決める。**
 *
 * | project | 引数 | 何を見るか |
 * |---|---|---|
 * | `chromium-webgpu` | WebGPU | 既定。node 経路の絵（基準画像 42 枚） |
 * | `chromium-node-gl` | SwiftShader | **WebGPU が無いときの退避路** |
 * | `chromium-swiftshader` | SwiftShader | 旧経路（`?path=webgl`。`WEBGL=1`） |
 *
 * `chromium-node-gl` に WebGPU の引数を渡さないのが要点。渡すと
 * 「WebGPU が無い」状況を作れず、退避路の検査が空振りする
 */
export function argsForProject(project) {
  return project === 'chromium-webgpu' ? WEBGPU_ARGS : SWIFTSHADER_ARGS
}
