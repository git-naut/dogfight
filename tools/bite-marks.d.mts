/**
 * `tools/bite-marks.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。`tools/mutate.mjs` を node が変換なしで
 * 実行する必要があるため（`tools/ac3d.mjs` と同じ作法）。
 */

/** 変異の型。6 つに絞る */
export type BiteKind =
  | '定数の摂動'
  | '比較の反転'
  | '条件の固定'
  | '文の削除'
  | '表の行の削除'
  | '符号の反転'

export interface BiteMark {
  /** 一意な名前。`--only` で指す */
  readonly id: string
  readonly kind: BiteKind
  /** リポジトリ相対のパス */
  readonly file: string
  /** 置き換える文字列。**対象ファイルにちょうど 1 回だけ現れること** */
  readonly find: string
  /** 置き換え後。空文字なら削除 */
  readonly replace: string
  /** 落ちるはずのテスト。リポジトリ相対のパス */
  readonly expect: string
  /**
   * 対応する教訓。`docs/lessons.md` に現れる文字列。
   *
   * 過去に実際に壊れた形を機械にしたものに付ける。
   */
  readonly lesson?: string
  /**
   * 教訓由来ではない歯型の理由。
   *
   * 壊れた実績はないが、そこが守られているかを確かめたいもの。
   * `lesson` か `why` のどちらかが要る。
   */
  readonly why?: string
}

export declare const BITE_MARKS: readonly BiteMark[]
