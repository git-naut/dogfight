import { describe, it, expect } from 'vitest'
import {
  CLOUD_BOTTOM,
  CLOUD_TOP,
  baseStepSize,
  beerTransmittance,
  cloudTime,
  densityGradient,
  dualPhase,
  heightFraction,
  henyeyGreenstein,
  intersectSlab,
  powder,
  smoothstep,
} from '@render/clouds/geometry'
import { FIXED_DT } from '@sim/loop'

/**
 * レイマーチの土台になる計算を数値で押さえる。
 *
 * シェーダ側の間違いは絵を見ても原因が分かりにくい。境界条件をここで
 * 確定させておけば、GLSL に写したあとで疑う範囲が狭まる。
 */

describe('スラブとの交差', () => {
  it('雲底より下から見上げると雲底で始まり雲頂で終わる', () => {
    // 高度 0 から真上へ
    const range = intersectSlab(0, 1, 100_000)
    expect(range.hit).toBe(true)
    expect(range.start).toBeCloseTo(CLOUD_BOTTOM, 6)
    expect(range.end).toBeCloseTo(CLOUD_TOP, 6)
  })

  it('雲頂より上から見下ろすと雲頂で始まり雲底で終わる', () => {
    // 高度 10,000 m から真下へ
    const range = intersectSlab(10_000, -1, 100_000)
    expect(range.hit).toBe(true)
    expect(range.start).toBeCloseTo(10_000 - CLOUD_TOP, 6)
    expect(range.end).toBeCloseTo(10_000 - CLOUD_BOTTOM, 6)
  })

  it('スラブの内側にいるなら原点から始まる', () => {
    const range = intersectSlab(3000, 1, 100_000)
    expect(range.hit).toBe(true)
    expect(range.start).toBe(0)
    expect(range.end).toBeCloseTo(CLOUD_TOP - 3000, 6)
  })

  it('内側から下を向いても原点から始まる', () => {
    const range = intersectSlab(3000, -1, 100_000)
    expect(range.hit).toBe(true)
    expect(range.start).toBe(0)
    expect(range.end).toBeCloseTo(3000 - CLOUD_BOTTOM, 6)
  })

  it('雲の下から下を向くと交差しない', () => {
    expect(intersectSlab(500, -1, 100_000).hit).toBe(false)
  })

  it('雲の上から上を向くと交差しない', () => {
    expect(intersectSlab(9000, 1, 100_000).hit).toBe(false)
  })

  it('内側で水平に飛ぶと全区間がマーチ対象になる', () => {
    const range = intersectSlab(3000, 0, 40_000)
    expect(range.hit).toBe(true)
    expect(range.start).toBe(0)
    expect(range.end).toBe(40_000)
  })

  it('外側で水平に飛ぶと交差しない', () => {
    expect(intersectSlab(500, 0, 40_000).hit).toBe(false)
    expect(intersectSlab(9000, 0, 40_000).hit).toBe(false)
  })

  it('地形に遮られると手前で打ち切られる', () => {
    // 雲頂の上から見下ろすが、2,000 m 先に地形がある
    const range = intersectSlab(10_000, -1, 6000)
    expect(range.hit).toBe(true)
    expect(range.start).toBeCloseTo(5500, 6)
    expect(range.end).toBe(6000)
  })

  it('地形が雲より手前なら交差しない', () => {
    const range = intersectSlab(10_000, -1, 1000)
    expect(range.hit).toBe(false)
  })

  it('最大距離がゼロ以下なら交差しない', () => {
    expect(intersectSlab(0, 1, 0).hit).toBe(false)
    expect(intersectSlab(0, 1, -5).hit).toBe(false)
  })

  it('斜めに入るほど区間が長くなる', () => {
    const steep = intersectSlab(0, 1, 100_000)
    const shallow = intersectSlab(0, Math.sin(20 * (Math.PI / 180)), 100_000)
    expect(shallow.end - shallow.start).toBeGreaterThan(steep.end - steep.start)
  })

  it('区間は常に start < end で有限', () => {
    for (let altitude = -500; altitude <= 12_000; altitude += 250) {
      for (let dy = -1; dy <= 1; dy += 0.1) {
        const range = intersectSlab(altitude, dy, 50_000)
        if (!range.hit) continue
        expect(range.start).toBeLessThan(range.end)
        expect(Number.isFinite(range.start)).toBe(true)
        expect(Number.isFinite(range.end)).toBe(true)
        expect(range.start).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('高度方向の密度', () => {
  it('雲底で 0、雲頂で 1 に正規化される', () => {
    expect(heightFraction(CLOUD_BOTTOM)).toBe(0)
    expect(heightFraction(CLOUD_TOP)).toBe(1)
    expect(heightFraction((CLOUD_BOTTOM + CLOUD_TOP) / 2)).toBeCloseTo(0.5, 12)
  })

  it('スラブの外では 0 か 1 に張り付く', () => {
    expect(heightFraction(0)).toBe(0)
    expect(heightFraction(50_000)).toBe(1)
  })

  it('勾配が雲底と雲頂で消える', () => {
    expect(densityGradient(0)).toBeCloseTo(0, 6)
    expect(densityGradient(1)).toBeCloseTo(0, 6)
  })

  it('勾配が中ほどで最大になる', () => {
    const middle = densityGradient(0.3)
    expect(middle).toBeGreaterThan(densityGradient(0.02))
    expect(middle).toBeGreaterThan(densityGradient(0.95))
    expect(middle).toBeGreaterThan(0.8)
  })

  it('勾配が 0 から 1 の範囲に収まる', () => {
    for (let f = 0; f <= 1; f += 0.01) {
      const g = densityGradient(f)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
    }
  })
})

describe('歩幅', () => {
  it('区間をステップ数で割った値になる', () => {
    const range = intersectSlab(0, 1, 100_000)
    expect(baseStepSize(range, 96)).toBeCloseTo((CLOUD_TOP - CLOUD_BOTTOM) / 96, 9)
  })

  it('交差していなければ 0', () => {
    expect(baseStepSize({ hit: false, start: 0, end: 0 }, 96)).toBe(0)
  })

  it('ステップ数が増えると歩幅が細かくなる', () => {
    const range = intersectSlab(0, 1, 100_000)
    expect(baseStepSize(range, 160)).toBeLessThan(baseStepSize(range, 32))
  })
})

describe('散乱と減衰', () => {
  it('透過率が光学的厚みとともに指数的に落ちる', () => {
    expect(beerTransmittance(0, 100, 0.05)).toBe(1)
    const half = beerTransmittance(1, 100, 0.05)
    const twice = beerTransmittance(1, 200, 0.05)
    expect(twice).toBeCloseTo(half * half, 9)
  })

  it('透過率が 0 から 1 に収まる', () => {
    for (let d = 0; d <= 5; d += 0.1) {
      const t = beerTransmittance(d, 500, 0.05)
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(1)
    }
  })

  it('Henyey-Greenstein が等方のとき一様になる', () => {
    const uniform = 1 / (4 * Math.PI)
    for (const cos of [-1, -0.5, 0, 0.5, 1]) {
      expect(henyeyGreenstein(cos, 0)).toBeCloseTo(uniform, 12)
    }
  })

  it('g が正なら前方散乱が強い', () => {
    const forward = henyeyGreenstein(1, 0.8)
    const backward = henyeyGreenstein(-1, 0.8)
    expect(forward).toBeGreaterThan(backward * 10)
  })

  it('g が負なら後方散乱が強い', () => {
    expect(henyeyGreenstein(-1, -0.5)).toBeGreaterThan(henyeyGreenstein(1, -0.5))
  })

  it('二重位相は逆光でも順光でもゼロにならない', () => {
    // 単一の前方散乱だと後方がほぼ消える。二重にする理由がここ
    const single = henyeyGreenstein(-1, 0.8)
    const dual = dualPhase(-1)
    expect(dual).toBeGreaterThan(single * 3)
    expect(dualPhase(1)).toBeGreaterThan(dualPhase(0))
  })

  it('二重位相が全方向で正の有限値', () => {
    for (let cos = -1; cos <= 1; cos += 0.05) {
      const p = dualPhase(cos)
      expect(p).toBeGreaterThan(0)
      expect(Number.isFinite(p)).toBe(true)
    }
  })

  it('powder 項が密度ゼロで 0、厚いところで 1 に近づく', () => {
    expect(powder(0, 100)).toBe(0)
    expect(powder(1, 1000)).toBeGreaterThan(0.99)
    expect(powder(0.01, 10)).toBeLessThan(0.2)
  })
})

describe('smoothstep', () => {
  it('端で 0 と 1 になる', () => {
    expect(smoothstep(0, 1, 0)).toBe(0)
    expect(smoothstep(0, 1, 1)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12)
  })

  it('範囲外で張り付く', () => {
    expect(smoothstep(0, 1, -5)).toBe(0)
    expect(smoothstep(0, 1, 5)).toBe(1)
  })

  it('edge0 > edge1 で反転する（減衰に使う）', () => {
    expect(smoothstep(1, 0.35, 1)).toBe(0)
    expect(smoothstep(1, 0.35, 0.35)).toBe(1)
  })

  it('edge が同値でも NaN を出さない', () => {
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0)
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1)
  })
})

describe('雲の時刻', () => {
  it('フレーム番号から決まる（実時間に依存しない）', () => {
    expect(cloudTime(0, FIXED_DT)).toBe(0)
    expect(cloudTime(120, FIXED_DT)).toBeCloseTo(1, 12)
    expect(cloudTime(120, FIXED_DT)).toBe(cloudTime(120, FIXED_DT))
  })

  it('長時間でも誤差が蓄積しない', () => {
    const steps = 120 * 3600 // 1 時間
    expect(cloudTime(steps, FIXED_DT)).toBe(steps * FIXED_DT)
  })
})
