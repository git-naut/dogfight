/**
 * 撃墜の結果の帯の文字（段 B3、段 C1 で録画に合わせ直した）。**純関数。**
 */

/**
 * 帯の長さ（フレーム）。撃墜のときは HIT のあと、すき間なしに DESTROYED。落ちない当たりは HIT だけ。
 *
 * 録画を 1 コマずつ 4 か所読んだ（コマ 11917・14065・20091・12504、2026-10-19）。HIT は 7〜13 コマ
 * （0.23〜0.43 秒）で、そのまま DESTROYED が 29〜30 コマ（0.97〜1.00 秒）。HIT は 10 コマ（0.33 秒）、
 * DESTROYED は 30 コマ（1.0 秒）にした。段 B3 では「2 コマ消える」「DESTROYED 1.23 秒」としていたが、
 * 爆発の白い閃光で帯が見えないコマを消えたと読み、HIT と DESTROYED をまとめた長さを DESTROYED と
 * 読んでいた（ADR 0024 の追記）
 */
export const BANNER_HIT_FRAMES = 40
export const BANNER_DESTROYED_FRAMES = 120

/**
 * いまのフレームに出す撃墜の帯の文字。撃墜は HIT のあと DESTROYED、落ちない当たりは HIT だけ。
 * 出していなければ空
 *
 * @param lastHit 最後に当たったフレーム。まだ無ければ −1
 * @param lastKill 最後に撃墜したフレーム。まだ無ければ −1
 * @param frame `World.frame`。命中と撃墜と同じ数え方
 */
export function killBannerText(lastHit: number, lastKill: number, frame: number): string {
  const killAge = lastKill >= 0 ? frame - lastKill : -1
  if (killAge >= 0 && killAge < BANNER_HIT_FRAMES + BANNER_DESTROYED_FRAMES) {
    return killAge < BANNER_HIT_FRAMES ? 'HIT' : 'DESTROYED'
  }
  const hitAge = lastHit >= 0 ? frame - lastHit : -1
  return hitAge >= 0 && hitAge < BANNER_HIT_FRAMES ? 'HIT' : ''
}
