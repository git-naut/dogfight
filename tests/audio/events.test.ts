import { describe, it, expect } from 'vitest'
import {
  diffCounters,
  limitExplosions,
  isFiring,
  gunHeld,
  GUN_HOLD_SECONDS,
  MAX_EXPLOSIONS_PER_FRAME,
  type AudioCounters,
} from '../../src/audio/events'

/**
 * 音のきっかけ。
 *
 * **主題はやり直しでカウンタが 0 へ戻る場合。**素直に引くと大きな負の数に
 * なる。
 */

function counters(
  roundsFired: number,
  explosionCount: number,
  missilesFired: number,
): AudioCounters {
  return { roundsFired, explosionCount, missilesFired }
}

describe('カウンタの差', () => {
  it('進んだぶんを返す', () => {
    const e = diffCounters(counters(10, 2, 1), counters(14, 3, 1))
    expect(e).toEqual({ shots: 4, explosions: 1, launches: 0 })
  })

  it('何も起きていなければ 0', () => {
    expect(diffCounters(counters(10, 2, 1), counters(10, 2, 1))).toEqual({
      shots: 0,
      explosions: 0,
      launches: 0,
    })
  })

  /** **R でやり直すと `World` が作り直されてカウンタが 0 へ戻る** */
  it('やり直しで 0 へ戻っても負を返さない', () => {
    const e = diffCounters(counters(500, 8, 6), counters(0, 0, 0))
    expect(e).toEqual({ shots: 0, explosions: 0, launches: 0 })
  })

  /** 1 つでも戻っていたらそのフレームは鳴らさない */
  it('一部だけ戻った場合も鳴らさない', () => {
    const e = diffCounters(counters(500, 8, 6), counters(520, 0, 6))
    expect(e).toEqual({ shots: 0, explosions: 0, launches: 0 })
  })

  it('ミサイルの発射を拾う', () => {
    expect(diffCounters(counters(0, 0, 2), counters(0, 0, 3)).launches).toBe(1)
  })
})

describe('爆発の上限', () => {
  it('上限までは素通し', () => {
    const e = { shots: 0, explosions: MAX_EXPLOSIONS_PER_FRAME, launches: 0 }
    expect(limitExplosions(e)).toEqual(e)
  })

  /** **同時に重なると振幅が足し合わさってクリップする** */
  it('超えたぶんは切る', () => {
    const e = limitExplosions({ shots: 3, explosions: 7, launches: 1 })
    expect(e.explosions).toBe(MAX_EXPLOSIONS_PER_FRAME)
    // 他の項目は触らない
    expect(e.shots).toBe(3)
    expect(e.launches).toBe(1)
  })
})

describe('機銃', () => {
  /** **1 発ずつ鳴らさない。**秒 100 発で音源を 100 個作ることになる */
  it('撃っていれば真', () => {
    expect(isFiring({ shots: 1, explosions: 0, launches: 0 })).toBe(true)
    expect(isFiring({ shots: 12, explosions: 0, launches: 0 })).toBe(true)
  })

  it('撃っていなければ偽', () => {
    expect(isFiring({ shots: 0, explosions: 3, launches: 1 })).toBe(false)
  })
})

describe('機銃を撃っている扱い（段 B11c の直し）', () => {
  it('最後に弾が出てから 50 ms のあいだは撃っている扱い', () => {
    expect(GUN_HOLD_SECONDS).toBe(0.05)
    expect(gunHeld(1, 1)).toBe(true)
    expect(gunHeld(1, 1.049)).toBe(true)
    expect(gunHeld(1, 1.05)).toBe(false)
    expect(gunHeld(-Infinity, 0)).toBe(false)
  })

  /**
   * 144 Hz の画面で撃ち続ける。sim は毎秒 120 ステップ・機銃は毎秒 100 発なので、フレームごとの弾の数は
   * 0 か 1。弾の数だけで判定すると撃ち止めが何度も起きるが、50 ms 保てば撃ち止めは最後の 1 回だけ
   */
  it('144 Hz で撃ち続けても撃ち止めは最後の 1 回', () => {
    const frame = 1 / 144
    const step = 1 / 120
    let simTime = 0
    let rounds = 0
    let fired = 0
    let lastShotAt = -Infinity
    let firing = false
    let stopsByShots = 0
    let stopsHeld = 0
    let previousByShots = false
    // 3 秒ぶん回す（2 秒で撃ち止める）
    for (let i = 0; i < 432; i++) {
      const now = i * frame
      // 2 秒撃って止める
      const before = rounds
      while (simTime + step <= now) {
        simTime += step
        if (simTime <= 2) {
          fired += 100 * step
          rounds = Math.floor(fired)
        }
      }
      const shots = rounds - before
      const byShots = isFiring({ shots, explosions: 0, launches: 0 })
      if (previousByShots && !byShots) stopsByShots++
      previousByShots = byShots
      if (byShots) lastShotAt = now
      const held = gunHeld(lastShotAt, now)
      if (firing && !held) stopsHeld++
      firing = held
    }
    expect(stopsByShots).toBeGreaterThan(10)
    expect(stopsHeld).toBe(1)
  })
})
