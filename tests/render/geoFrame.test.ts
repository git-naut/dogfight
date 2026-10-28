import { describe, it, expect } from 'vitest'
import { dateForHour, DEFAULT_HOUR } from '@render/geoFrame'

/**
 * 基準の日時の決まり（`geoFrame.ts`）。
 *
 * 段 S2b-2 まで、このファイルは `atmosphere.test.ts` で、局所座標と ECEF の
 * 橋渡し（`createLocalFrame`、7 本）も縛っていた。takram の大気が ECEF に固定
 * されていたためで、takram を外して ECEF を使う所が無くなったので消した。
 * 太陽の向きの座標の割り当ては `solar.test.ts`（takram の記録と 0.02 度）が縛る
 */

describe('時刻の指定', () => {
  it('同じ時刻からは同じ Date が出る（決定論）', () => {
    expect(dateForHour(16).getTime()).toBe(dateForHour(16).getTime())
  })

  it('1 時間ずらすと 1 時間ぶん進む', () => {
    const diff = dateForHour(17).getTime() - dateForHour(16).getTime()
    expect(diff).toBe(3_600_000)
  })

  it('既定は午後', () => {
    expect(DEFAULT_HOUR).toBeGreaterThan(12)
    expect(DEFAULT_HOUR).toBeLessThan(19)
  })

  it('実時間に依存しない', () => {
    // 実装が Date.now() を使っていたら、間を空けた 2 回で値がずれる
    const first = dateForHour(DEFAULT_HOUR).getTime()
    const busy = Array.from({ length: 100_000 }, (_, i) => i).reduce((a, b) => a + b, 0)
    expect(busy).toBeGreaterThan(0)
    expect(dateForHour(DEFAULT_HOUR).getTime()).toBe(first)
  })
})
