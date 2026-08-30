/**
 * 音のきっかけを取り出す。
 *
 * **sim に手を入れない。**`Combat` は撃った弾と爆発の総数を単調増加の
 * カウンタで持っている（`roundsFired` / `explosionCount` / `missilesFired`）。
 * 前のフレームとの差を見れば、何が起きたかが分かる。sim にコールバックを
 * 生やすと `layering.test.ts` の規約（DOM に触らない）を破る道ができる。
 *
 * **DOM も Web Audio も触らない。**node でテストできる形にしておく。
 * 実際に音を出すのは `audio.ts`。
 */

/** 見ているカウンタ。すべて単調増加 */
export interface AudioCounters {
  /** 自機が撃った弾の総数 */
  readonly roundsFired: number
  /** 起きた爆発の総数 */
  readonly explosionCount: number
  /** 自機が撃ったミサイルの総数 */
  readonly missilesFired: number
}

/** このフレームで起きたこと */
export interface AudioEvents {
  /** 撃った弾数。0 なら撃っていない */
  readonly shots: number
  /** 起きた爆発の数 */
  readonly explosions: number
  /** 撃ったミサイルの数 */
  readonly launches: number
}

const NOTHING: AudioEvents = { shots: 0, explosions: 0, launches: 0 }

/**
 * 差を取る。
 *
 * **負の差は 0 にする。**`R` でやり直すと `World` が作り直されてカウンタが
 * 0 へ戻る。素直に引くと大きな負の数になり、それを回数として扱うと
 * ループが回らないか、符号を見ていない箇所で異常な値になる。
 *
 * やり直しを「音のきっかけ」として扱わないのは、鳴らす対象が無いため。
 * 撃ってもいない弾の音を出すことになる。
 */
export function diffCounters(prev: AudioCounters, next: AudioCounters): AudioEvents {
  const shots = next.roundsFired - prev.roundsFired
  const explosions = next.explosionCount - prev.explosionCount
  const launches = next.missilesFired - prev.missilesFired
  if (shots < 0 || explosions < 0 || launches < 0) return NOTHING
  return { shots, explosions, launches }
}

/**
 * 1 フレームで鳴らす爆発の上限。
 *
 * **同時に何発も重なると音が割れる。**編隊に当たった直後は 1 フレームで
 * 複数の爆発が立つ。実測では 8 機戦の開始 15 秒で 4 発が同時に飛来した
 * （`docs/mission.md`）。ゲイン 1 の音源が 4 つ重なれば振幅は 4 倍で、
 * そのまま出すとクリップする。
 */
export const MAX_EXPLOSIONS_PER_FRAME = 2

/** 上限を掛ける。鳴らす数を減らすだけで、カウンタは進めたまま */
export function limitExplosions(events: AudioEvents): AudioEvents {
  if (events.explosions <= MAX_EXPLOSIONS_PER_FRAME) return events
  return { ...events, explosions: MAX_EXPLOSIONS_PER_FRAME }
}

/**
 * 機銃の音を連続で扱うか。
 *
 * **1 発ずつ鳴らさない。**M61A1 は毎分 6,000 発（`docs/weapons.md`）で、
 * 秒 100 発。1 発ごとに音源を作ると 1 秒に 100 個で、聞こえ方も実物と
 * 違う。実際には個々の発射音が分離せず連続した唸りになる。
 *
 * 撃っているあいだ 1 本の音を鳴らし、止まったら止める。
 */
export function isFiring(events: AudioEvents): boolean {
  return events.shots > 0
}
