/**
 * `tests/e2e/scenes.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。`tools/exact.mjs` を node が変換なしで
 * 実行する必要があるため。型だけここで与える（`tools/ac3d.mjs` と同じ作法）。
 */

export interface CaptureQuery {
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
  /** 標的機を描くか。切ると差分で標的の寄与を測れる */
  readonly targets?: boolean
  /** 敵機を描くか。切ると差分で敵の寄与を測れる */
  readonly enemies?: boolean
  /**
   * 自機を出すか。既定は出す。
   *
   * 追従カメラは自機の後方にあるので、被写体が自機より前にあると隠れる。
   * 空母の甲板がそうだった
   */
  readonly aircraft?: boolean
  /** ダメージの煙を描くか。切ると差分で寄与を測れる */
  readonly damageSmoke?: boolean
  /** フレアを描くか。切ると差分で寄与を測れる */
  readonly flares?: boolean
  /** HUD を出すか。キャプチャの既定はオフ */
  readonly hud?: boolean
  /** 曳光弾を描くか。切ると差分で寄与を測れる */
  readonly tracers?: boolean
  /** ミサイルの煙を描くか。切ると差分で寄与を測れる */
  readonly smoke?: boolean
  /** 爆発を描くか。切ると差分で寄与を測れる */
  readonly explosions?: boolean
}

/** 基準画像 1 枚ぶんの構図。`name` がそのまま PNG のファイル名になる */
export interface SceneSpec extends CaptureQuery {
  readonly name: string
  readonly script: string
  readonly frame: number
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
