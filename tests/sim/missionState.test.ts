import { describe, expect, it } from 'vitest'
import { Mission, isCleared, isSettled, type MissionView } from '@sim/mission'

/**
 * ミッションの勝敗の判定。
 *
 * `World` を通さずに `Mission` だけを見る。判定に要るのは 4 つの値だけなので
 * （`MissionView`）、世界を組まずに全部の遷移を書ける。
 */

const LIMIT = 600

function view(partial: Partial<MissionView> = {}): MissionView {
  return {
    frame: 1,
    enemiesAlive: 5,
    playerLosses: 0,
    playerCrashed: false,
    ...partial,
  }
}

describe('ミッションの決着', () => {
  it('始めは進行中', () => {
    const m = new Mission({ limitFrames: LIMIT })
    expect(m.outcome).toBe('running')
    expect(m.endedFrame).toBe(-1)
    expect(isSettled(m.outcome)).toBe(false)
  })

  it('敵が全滅したら成功', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: 120, enemiesAlive: 0 }))
    expect(m.outcome).toBe('cleared')
    expect(m.endedFrame).toBe(120)
    expect(isCleared(m.outcome)).toBe(true)
  })

  it('制限時間を使い切ったら時間切れ', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: LIMIT }))
    expect(m.outcome).toBe('timeout')
    expect(m.endedFrame).toBe(LIMIT)
  })

  it('敵に落とされたら失敗', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: 60, playerLosses: 1 }))
    expect(m.outcome).toBe('shotDown')
  })

  /**
   * **地形への衝突を取りこぼさない。**`Combat` は敵の機銃とミサイルしか
   * 見ていないので、山にぶつかっても `losses` は増えない（`combat.ts`）。
   * `crashed` を別に見ないと失敗として拾えない。
   */
  it('自分で落ちたら失敗。losses は増えていない', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: 60, playerLosses: 0, playerCrashed: true }))
    expect(m.outcome).toBe('crashed')
  })

  it('制限時間の境界。1 フレーム手前では切れない', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: LIMIT - 1 }))
    expect(m.outcome).toBe('running')
    m.update(view({ frame: LIMIT }))
    expect(m.outcome).toBe('timeout')
  })

  it('決着したら二度と変わらない', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: 100, enemiesAlive: 0 }))
    expect(m.outcome).toBe('cleared')

    // 成功のあとに時間切れや墜落で上書きされない
    m.update(view({ frame: LIMIT + 100, playerCrashed: true }))
    expect(m.outcome).toBe('cleared')
    expect(m.endedFrame).toBe(100)
  })

  it('失敗のあとに敵が全滅しても成功にならない', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: 60, playerCrashed: true }))
    expect(m.outcome).toBe('crashed')
    m.update(view({ frame: 61, enemiesAlive: 0 }))
    expect(m.outcome).toBe('crashed')
  })

  /**
   * **相打ちは成功にする。**最後の 1 機を落とした瞬間に自分も落ちる場合、
   * 撃墜のほうが先に成立している。`update` が成功を先に見るのはこのため。
   */
  it('相打ちは成功', () => {
    const m = new Mission({ limitFrames: LIMIT })
    m.update(view({ frame: 200, enemiesAlive: 0, playerCrashed: true, playerLosses: 1 }))
    expect(m.outcome).toBe('cleared')
  })

  describe('残り時間', () => {
    it('進行中はフレームぶん減る', () => {
      const m = new Mission({ limitFrames: LIMIT })
      expect(m.remainingFrames(0)).toBe(LIMIT)
      expect(m.remainingFrames(200)).toBe(LIMIT - 200)
    })

    it('0 より下へは行かない', () => {
      const m = new Mission({ limitFrames: LIMIT })
      expect(m.remainingFrames(LIMIT + 500)).toBe(0)
    })

    it('決着したらそこで止まる', () => {
      const m = new Mission({ limitFrames: LIMIT })
      m.update(view({ frame: 150, enemiesAlive: 0 }))
      // 決着後にフレームが進んでも残り時間は動かない
      expect(m.remainingFrames(150)).toBe(LIMIT - 150)
      expect(m.remainingFrames(500)).toBe(LIMIT - 150)
    })
  })
})
