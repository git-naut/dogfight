/**
 * ミサイル警告音の高さと揺れ（Phase 10 の段 B10、ADR 0035）。**純関数と定数だけ。**
 *
 * 録画（lesson 5 の 700.9〜721.9 秒、HUD が赤い 3 区間）の音を周波数ごとに分けた。約 2,300・3,060・
 * 3,830・4,600 Hz に途切れない線があり、約 766 Hz の 3〜6 倍の倍音とみた。線の強さは区間の中で
 * ほぼ一定（−46.3〜−48.1 dB）で、断続音ではなく持続音だった。どの線のすぐ下にも弧の形が並び、
 * 高さが一瞬下がって戻る揺れとみた。揺れの周期は、相関がいちばん高い窓で 150 ms。
 *
 * 字幕は「ミサイルが接近すると音の間隔が短くなる」。録画の音はナレーションと重なり、間隔が縮むかは
 * 数値で確かめられなかった。着弾が近づくほど揺れの周期を縮める（ユーザーの決定、最短 60 ms は推測）
 */

/** 持続音の基本の高さ Hz（録画の倍音 2,300・3,060・3,830・4,600 Hz を 3〜6 で割った値） */
export const WARNING_TONE_HZ = 766

/** 揺れで下げる深さ セント（録画の弧は 4,600 Hz の線の下 約 150 Hz、約 3.3%） */
export const WARNING_WARBLE_CENTS = 57

/** 遠いときの揺れの周期 秒（録画） */
export const WARBLE_PERIOD_FAR = 0.15
/** 着弾の直前の揺れの周期 秒（推測、ユーザーの選択） */
export const WARBLE_PERIOD_NEAR = 0.06
/** これより着弾が遠ければ遠いときの周期 秒 */
export const WARBLE_FAR_SECONDS = 6
/** これより着弾が近ければ直前の周期 秒 */
export const WARBLE_NEAR_SECONDS = 1

/**
 * 着弾までの秒から揺れの周期 秒を出す。6 秒以上で 150 ms、1 秒以内で 60 ms、間は一様に縮める。
 * 着弾までの秒が出ない（無限大や NaN）ときは遠いときの周期
 */
export function warblePeriod(timeToImpact: number): number {
  if (!Number.isFinite(timeToImpact) || timeToImpact >= WARBLE_FAR_SECONDS) return WARBLE_PERIOD_FAR
  if (timeToImpact <= WARBLE_NEAR_SECONDS) return WARBLE_PERIOD_NEAR
  const t = (timeToImpact - WARBLE_NEAR_SECONDS) / (WARBLE_FAR_SECONDS - WARBLE_NEAR_SECONDS)
  return WARBLE_PERIOD_NEAR + (WARBLE_PERIOD_FAR - WARBLE_PERIOD_NEAR) * t
}
