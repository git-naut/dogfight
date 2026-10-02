import { describe, expect, it } from 'vitest'
import { ScoreLog } from '@sim/score'

describe('撃墜の記録と点数', () => {
  it('撃墜ごとに点数を足し、最後の撃墜を返す', () => {
    const log = new ScoreLog()
    expect(log.total).toBe(0)
    expect(log.latest(0)).toBeNull()
    log.record(100, 'F-16', 1000)
    log.record(200, 'DRONE', 200)
    expect(log.total).toBe(1200)
    expect(log.latest(210)).toEqual({ frame: 200, designation: 'DRONE', points: 200 })
  })

  it('加点の表示は撃墜から 3 秒（360 フレーム）で消える', () => {
    // **撃墜の瞬間だけ出す**（参考画像の `TARGET TU-160 +1200`）。表示層では作れない
    // ので、起きたフレームを sim が持つ（計画書の段 29）。**期待値は定数から作らない。**
    // `KILL_SHOW_SECONDS` から計算すると、定数を壊しても一緒に動いて落ちない
    const log = new ScoreLog()
    log.record(100, 'F-16', 1000)
    const end = 100 + 360
    expect(log.latest(end - 1)).not.toBeNull()
    expect(log.latest(end)).toBeNull()
    expect(log.latest(99), '起きる前のフレームには出さない').toBeNull()
  })

  it('リセットで 0 に戻る', () => {
    const log = new ScoreLog()
    log.record(100, 'F-16', 1000)
    log.reset()
    expect(log.total).toBe(0)
    expect(log.latest(110)).toBeNull()
  })
})
