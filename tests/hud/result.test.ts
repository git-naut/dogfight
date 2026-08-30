import { describe, expect, it } from 'vitest'
import { buildResult, selfDestructed, type ResultSource } from '@hud/result'
import { formatClock } from '@hud/readout'

/**
 * リザルトの組み立て。
 *
 * `buildResult` は DOM を触らないので node で回せる。整形の関数は引数で
 * 受け取るので、実物（`readout.ts` の `formatClock`）をそのまま渡して検査する。
 */

function source(partial: Partial<ResultSource> = {}): ResultSource {
  return {
    outcome: 'cleared',
    endedFrame: 120 * 90,
    enemyTotal: 5,
    enemiesAlive: 0,
    kills: 5,
    roundsFired: 600,
    hits: 66,
    missilesFired: 3,
    ...partial,
  }
}

describe('リザルト', () => {
  it('成功したら見出しが変わり、理由は空', () => {
    const r = buildResult(source(), formatClock)
    expect(r.cleared).toBe(true)
    expect(r.title).toBe('MISSION COMPLETE')
    expect(r.reason).toBe('')
  })

  it('失敗の理由を書き分ける', () => {
    expect(buildResult(source({ outcome: 'timeout' }), formatClock).reason).toBe(
      '時間切れ',
    )
    expect(buildResult(source({ outcome: 'shotDown' }), formatClock).reason).toBe(
      '撃墜された',
    )
    expect(buildResult(source({ outcome: 'crashed' }), formatClock).reason).toBe(
      '墜落した',
    )
  })

  /**
   * **`shotDown` と `crashed` を分ける。**敵に落とされたのか自分で落ちたのかで
   * 次に直すことが違う。`Combat.losses` は地形への衝突を数えないので、
   * `mission.ts` が両方を見て区別している。
   */
  it('失敗はすべて cleared が false', () => {
    for (const outcome of ['timeout', 'shotDown', 'crashed']) {
      const r = buildResult(source({ outcome }), formatClock)
      expect(r.cleared, outcome).toBe(false)
      expect(r.title, outcome).toBe('MISSION FAILED')
    }
  })

  describe('自滅の内訳', () => {
    /**
     * **`kills` は自滅を数えない。**`Combatant.damage()` が true を返した
     * ときだけ増えるので、敵が山にぶつかると落ちても増えない。落ちた総数から
     * 引いて出す。
     */
    it('落ちた総数から撃墜を引く', () => {
      expect(selfDestructed(source({ enemiesAlive: 0, kills: 4 }))).toBe(1)
      expect(selfDestructed(source({ enemiesAlive: 2, kills: 2 }))).toBe(1)
      expect(selfDestructed(source({ enemiesAlive: 0, kills: 5 }))).toBe(0)
    })

    it('負にはならない', () => {
      // 起きないはずだが、数え方が食い違っても壊れない
      expect(selfDestructed(source({ enemiesAlive: 3, kills: 5 }))).toBe(0)
    })

    it('自滅が 0 なら内訳を書かない', () => {
      const r = buildResult(source({ kills: 5, enemiesAlive: 0 }), formatClock)
      expect(r.tally).toBe('撃墜 5')
    })

    it('自滅がいれば並べる', () => {
      const r = buildResult(source({ kills: 4, enemiesAlive: 0 }), formatClock)
      expect(r.tally).toBe('撃墜 4 / 自滅 1')
    })
  })

  describe('命中率', () => {
    it('百分率で 1 桁', () => {
      const r = buildResult(source({ roundsFired: 600, hits: 66 }), formatClock)
      expect(r.accuracy).toBe('11.0%')
    })

    /** **0 除算を避ける。**1 発も撃たずに終わることはある */
    it('撃っていなければダッシュ', () => {
      const r = buildResult(source({ roundsFired: 0, hits: 0 }), formatClock)
      expect(r.accuracy).toBe('—')
    })
  })

  it('経過時間は決着したフレームから出す', () => {
    const r = buildResult(source({ endedFrame: 120 * 95 }), formatClock)
    expect(r.elapsed).toBe('1:35')
  })

  it('消費した弾薬を並べる', () => {
    const r = buildResult(
      source({ roundsFired: 1234, missilesFired: 6 }),
      formatClock,
    )
    expect(r.spent).toBe('機銃 1234 発 / ミサイル 6 発')
  })
})
