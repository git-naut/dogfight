/**
 * リザルトの数値。
 *
 * **DOM を触らない。**組み立てだけをここでやれば node でテストできる。
 * `readout.ts` が数値の整形だけを持つのと同じ分け方。
 */

/** リザルトの材料。sim から読んだ生の値 */
export interface ResultSource {
  /** 決着。`mission.ts` の `MissionOutcome` の文字列 */
  readonly outcome: string
  /** 決着したフレーム */
  readonly endedFrame: number
  /** 台本の敵の総数 */
  readonly enemyTotal: number
  /** 生き残った敵 */
  readonly enemiesAlive: number
  /** 撃墜した数。**自滅は入らない**（`combat.ts` の `kills`） */
  readonly kills: number
  /** 撃った弾 */
  readonly roundsFired: number
  /** 当たった弾 */
  readonly hits: number
  /** 撃ったミサイル */
  readonly missilesFired: number
}

/** 画面に出す形にしたリザルト */
export interface ResultLines {
  /** 成功したか */
  readonly cleared: boolean
  /** 見出し */
  readonly title: string
  /** 決着の理由。成功なら空 */
  readonly reason: string
  /** 「撃墜 4 / 自滅 1」のような内訳 */
  readonly tally: string
  /** 経過時間 `m:ss` */
  readonly elapsed: string
  /** 命中率。撃っていなければ「—」 */
  readonly accuracy: string
  /** 消費した弾薬 */
  readonly spent: string
}

/**
 * 決着の理由を日本語にする。
 *
 * **`shotDown` と `crashed` を分ける。**敵に落とされたのか自分で落ちたのかで
 * 次に直すことが違う（`mission.ts` の注記）。
 */
function reasonOf(outcome: string): string {
  switch (outcome) {
    case 'timeout':
      return '時間切れ'
    case 'shotDown':
      return '撃墜された'
    case 'crashed':
      return '墜落した'
    default:
      return ''
  }
}

/**
 * 自滅した敵の数。
 *
 * **`kills` は自滅を数えない**（`Combatant.damage()` が true を返したときだけ
 * 増える）。落ちた総数から撃墜を引けば、山にぶつかったり失速したりした数が
 * 出る。負にはならないはずだが、念のため 0 で止める。
 */
export function selfDestructed(source: ResultSource): number {
  const downed = source.enemyTotal - source.enemiesAlive
  return Math.max(0, downed - source.kills)
}

/**
 * リザルトを組み立てる。
 *
 * @param formatClock 経過時間の整形。`readout.ts` のものを渡す
 */
export function buildResult(
  source: ResultSource,
  formatClock: (frames: number) => string,
): ResultLines {
  const cleared = source.outcome === 'cleared'
  const lost = selfDestructed(source)
  const accuracy =
    source.roundsFired > 0
      ? `${((source.hits / source.roundsFired) * 100).toFixed(1)}%`
      : '—'

  return {
    cleared,
    title: cleared ? 'MISSION COMPLETE' : 'MISSION FAILED',
    reason: reasonOf(source.outcome),
    // 自滅が 0 なら書かない。0 を並べても読む人の役に立たない
    tally: lost > 0 ? `撃墜 ${source.kills} / 自滅 ${lost}` : `撃墜 ${source.kills}`,
    elapsed: formatClock(source.endedFrame),
    accuracy,
    spent: `機銃 ${source.roundsFired} 発 / ミサイル ${source.missilesFired} 発`,
  }
}
