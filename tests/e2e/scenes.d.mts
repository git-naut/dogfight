/**
 * `tests/e2e/scenes.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。`tools/exact.mjs` を node が変換なしで
 * 実行する必要があるため。型だけここで与える（`tools/ac3d.mjs` と同じ作法）。
 */

/**
 * 描画を切り分けるトグルの名前。
 *
 * `src/render/capture.ts` の `show*` と対になる。**切れないものは差分で
 * 測れない。**演出を足すときはここにも 1 つ足す。
 */
export type ToggleKey =
  | 'terrain'
  | 'water'
  | 'environment'
  | 'aircraftShadow'
  | 'targets'
  | 'enemies'
  | 'damageSmoke'
  | 'flares'
  | 'tracers'
  | 'aircraft'
  | 'trails'
  | 'missiles'
  | 'smoke'
  | 'explosions'

/** トグルの内部名と URL のパラメータ名の対 */
export declare const TOGGLES: readonly (readonly [ToggleKey, string])[]

type ToggleQuery = { readonly [K in ToggleKey]?: boolean }

export interface CaptureQuery extends ToggleQuery {
  /** 雲影マップの分布を読み戻すか。`?shadowprobe=1` */
  shadowProbe?: boolean
  readonly script?: string
  readonly frame?: number
  readonly hour?: number
  readonly preset?: string
  /**
   * 雲量 0..1。
   *
   * **省略すると 0（快晴）になる。**本番の既定は 0.3 だが、E2E では雲を
   * 主題にするテストだけが払えばよい費用。雲のマーチは 1 枚あたり実測
   * 3.9 秒（雲なし 4.5 秒に対して雲あり 8.4 秒）で、160 回のキャプチャに
   * 掛かると待ち時間を倍にする。
   *
   * 雲そのものを見張るのは `雲` の describe と、`SCENES` のうち
   * `coverage` に 0 以外を明示した 15 枚。
   */
  readonly coverage?: number
  /** HUD を出すか。キャプチャの既定はオフ */
  readonly hud?: boolean
}

/** 基準画像 1 枚ぶんの構図。`name` がそのまま PNG のファイル名になる */
export interface SceneSpec extends CaptureQuery {
  readonly name: string
  readonly script: string
  readonly frame: number
  /**
   * このカットが見張っていると主張する描画要素。
   *
   * **主張であって事実ではない。**`MUTATE=1` の逆テストが 1 つずつ切って、
   * 基準画像が実際に落ちるかを確かめる。落ちなければ主張が嘘なので、
   * 宣言から外して理由を `docs/lessons.md` に書く。
   */
  readonly watches?: readonly ToggleKey[]
}

/**
 * キャプチャ URL のクエリを組み立てる。
 *
 * `smoke.spec.ts` の `capture()` と `tools/exact.mjs` の両方がこれを呼ぶ。
 * 片方だけが別の既定値を使うと、画素比較の道具が嘘の結論を出す。
 */
export declare function captureParams(query?: CaptureQuery): URLSearchParams

/** 基準画像を撮る構図。増やすときはここだけに足す */
export declare const SCENES: readonly SceneSpec[]
