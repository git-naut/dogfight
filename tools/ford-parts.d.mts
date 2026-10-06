/**
 * `tools/ford-parts.mjs` の型（Phase 9 の段 2）。本体は node が変換なしで実行できるよう
 * 素の JavaScript で書いてある（`npm run assets` から呼ばれる）
 */

export type Vec3 = [number, number, number]

/** 実物の全長 m */
export declare const LENGTH_OVERALL: number
/** 原本の全長 */
export declare const SOURCE_LENGTH: number
/** 原本からこの作品の m への倍率 */
export declare const SCALE: number
/** 実物の喫水 m */
export declare const DRAFT: number
/** 原本の座標で原点にする点 */
export declare const SOURCE_ORIGIN: { x: number; y: number; z: number }
/** 原本の飛行甲板の上面の Y */
export declare const SOURCE_DECK_TOP: number
/** この作品の座標での甲板の高さ m（水面から） */
export declare const DECK_HEIGHT: number
/** 原本の座標をこの作品の座標へ写す */
export declare function toWorld(p: readonly number[]): Vec3
/** `toWorld` と同じ変換の行優先 4×4 行列 */
export declare function worldMatrix(): number[][]
