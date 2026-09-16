/**
 * `tests/e2e/launch.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。`tools/exact.mjs` を node が変換なしで
 * 実行する必要があるため。
 */

/** SwiftShader に固定する Chromium の起動引数 */
export declare const SWIFTSHADER_ARGS: readonly string[]

/** WebGPU を Dawn の SwiftShader Vulkan で動かす起動引数 */
export declare const WEBGPU_ARGS: readonly string[]

/** 撮る窓の大きさ */
export declare const VIEWPORT: { readonly width: number; readonly height: number }

/** project 名から Chromium の起動引数を選ぶ。未知の名前は投げる */
export declare function launchArgsFor(project: string): string[]

/** 基準画像のファイル名に付く接尾辞を組み立てる */
export declare function snapshotSuffix(project: string): string

/** 既定の project 名 */
export declare const DEFAULT_PROJECT: string
