import { describe, it, expect } from 'vitest'
import { World } from '@sim/world'
import { Vec3 } from '@sim/vec3'
import { makeInput } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'

/**
 * 手ごたえを数値に落とす。
 *
 * **「難しい」「簡単」は測ってから調整する。**Phase 5 で機銃の撃墜が
 * 0.50 秒と速すぎたのを、時間に落として初めて切り分けられた
 * （`docs/weapons.md`）。Phase 6 でも「どんな入力でも無敵」の崖を
 * 平均命中数で捉えた。
 *
 * Phase 6.5 で見るのは 3 つ。**警告から着弾までの余裕**（反応する時間が
 * あるか）、**フレアが成功するタイミングの幅**（狙って撒く必要があるか）、
 * **フレアの有無で生存がどれだけ変わるか**（意味があるか）。
 */

const ALT = 3000
const trim = trimCondition(250, airDensity(ALT))

function engagement(range: number, missiles?: number): World {
  return new World({
    seed: 20260823,
    aircraft: {
      position: new Vec3(0, ALT, 0),
      velocity: new Vec3(0, 0, -250),
      throttle: trim.throttle,
    },
    enemies: [
      {
        offset: new Vec3(0, 0, range),
        speed: 250,
        ...(missiles !== undefined ? { missiles } : {}),
      },
    ],
  })
}

/** 警告が出た秒と、被弾した秒 */
function timeline(range: number): { warnAt: number; hitAt: number } {
  const w = engagement(range)
  let warnAt = -1
  for (let i = 0; i < 30 * 120; i++) {
    const t = i / 120
    w.step(makeInput({ throttle: trim.throttle }))
    if (warnAt < 0 && w.combat.threat.active) warnAt = t
    if (w.combat.taken > 0) return { warnAt, hitAt: t }
  }
  return { warnAt, hitAt: Infinity }
}

/** flareAt 秒で 1 回撒いて、1 発目を避けられたか */
function avoids(range: number, flareAt: number | null, until: number): boolean {
  const w = engagement(range, 1)
  for (let i = 0; i < until * 120; i++) {
    const t = i / 120
    const deploy = flareAt !== null && t >= flareAt && t < flareAt + 2 / 120
    w.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
    if (w.combat.taken > 0) return false
  }
  return true
}

/**
 * 警告を見てから撒く戦い方の結果。落ちるまでの秒と、残った耐久。
 *
 * **秒だけでは足りない。**落ちなかったときに `Infinity` しか返らないと、
 * 「無傷で逃げ切った」と「削られて生き残った」が同じ値になる。
 *
 * @param reactAt 着弾まで何秒を切ったら撒くか。小さいほど遅い反応
 */
function survival(
  reactAt: number | null,
  seconds = 60,
): { died: number; integrity: number } {
  const w = engagement(1800)
  for (let i = 0; i < seconds * 120; i++) {
    const threat = w.combat.threat
    const deploy = reactAt !== null && threat.active && threat.timeToImpact < reactAt
    w.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
    if (w.player.integrity <= 0) return { died: i / 120, integrity: 0 }
  }
  return { died: Infinity, integrity: w.player.integrity }
}

/**
 * 警告から着弾までの余裕。
 *
 * **反応する時間があるか。**5 秒あれば、警告を見て方位を読んで撒くまでが
 * 間に合う。1 秒しかなければ運になる。
 */
describe('警告から着弾までの余裕', () => {
  it.each([
    { range: 1500, margin: 5.0 },
    { range: 2500, margin: 6.9 },
    { range: 4000, margin: 10.2 },
  ])('$range m で $margin 秒', ({ range, margin }) => {
    const { warnAt, hitAt } = timeline(range)
    expect(warnAt).toBeGreaterThanOrEqual(0)
    expect(hitAt - warnAt).toBeCloseTo(margin, 0)
  })

  /** **警告はほぼ即座に出る。**撃たれてから気づくまでの遅れがない */
  it('発射からすぐ出る', () => {
    const { warnAt } = timeline(2500)
    expect(warnAt).toBeLessThan(0.5)
  })
})

/**
 * フレアが成功するタイミングの幅。
 *
 * **狭すぎると運、広すぎると作業になる。**真後ろからの構図では着弾の
 * 5 秒前から直前まで成功する。遠いほど「早すぎる」が失敗になる。
 */
describe('フレアが成功する幅', () => {
  it('1,500 m では着弾の 5 秒前から直前まで成功する', () => {
    // 着弾は 5.2 秒
    for (const t of [0.5, 2.0, 4.0, 5.0]) {
      expect(avoids(1500, t, 9), `${t} 秒`).toBe(true)
    }
  })

  /**
   * **遠いと早すぎる投下は間に合わない。**フレアは 4 秒で燃え尽きるので、
   * 着弾より前に消えると意味がない。
   */
  it('4,000 m では早すぎると失敗する', () => {
    // 着弾は 10.4 秒。5 秒より前に撒くと燃え尽きる
    expect(avoids(4000, 1.0, 14)).toBe(false)
    expect(avoids(4000, 3.0, 14)).toBe(false)
    expect(avoids(4000, 6.0, 14)).toBe(true)
    expect(avoids(4000, 9.0, 14)).toBe(true)
  })

  it('撒かなければ必ず当たる', () => {
    for (const range of [1500, 2500, 4000]) {
      expect(avoids(range, null, 15), `${range} m`).toBe(false)
    }
  })
})

/**
 * フレアの有無で生存がどれだけ変わるか。
 *
 * **意味があるか。**実測で 5.8 秒から 35.9 秒（6 倍）。ミサイル 2 発を
 * 両方避けたあと、敵が機銃の間合いへ詰めて削り切る。
 *
 * **決着は機銃でつく。**ミサイルは「避けられなければ即死」で、避ければ
 * 戦いが続く。それが駆け引きになる。
 *
 * この 2 つの数は当たり判定にも飛行モデルにも効く。F/A-18E へ差し替えた
 * とき、**飛行モデルだけ先に替えて当たり判定を C 型のまま残したら、敵が
 * 追い越して 60 秒でも決着しなくなった**（`docs/lessons.md`）。
 */
describe('フレアの有無', () => {
  it('撒かなければ 6 秒で落ちる', () => {
    expect(survival(null).died).toBeLessThan(8)
  })

  it('警告を見て撒けば 36 秒戦える', () => {
    const { died, integrity } = survival(2.0)
    expect(died).toBeGreaterThan(30)
    expect(died).toBeLessThan(50)
    // **削り切って終わること。**60 秒を使い切って耐久が残るなら、機銃が
    // 決着をつけていない
    expect(integrity).toBe(0)
  })

  /**
   * **反応の速さでは差が出ない。**着弾の 0.2 秒前でも 5 秒前でも同じ。
   *
   * 真後ろからの構図ではフレアが確実に効くので、撒きさえすれば助かる。
   * **難しさは「撒くかどうか」ではなく「どの方向から来ているか」にある**
   * （横 90 度では効かない。`docs/weapons.md`）。
   */
  it.each([0.2, 1.0, 3.0, 5.0])('反応が %s 秒前でも結果は同じ', (reactAt) => {
    // 秒で比べると、落ちなかった回どうしが `Infinity` で一致して素通りする。
    // 残った耐久まで揃うことを見る
    expect(survival(reactAt)).toEqual(survival(2.0))
  })

  /**
   * ミサイルを避けたあとは機銃で決まる。
   *
   * 実測で 11.2 秒に敵のミサイル 2 発が尽き、そこから機銃の間合いへ詰めて
   * 35.9 秒に削り切る。578 発撃って耐久 60 ぶんが当たる。
   */
  it('ミサイルを避けたあとは機銃の勝負になる', () => {
    const w = engagement(1800)
    let missilesGone = -1
    for (let i = 0; i < 45 * 120; i++) {
      const threat = w.combat.threat
      const deploy = threat.active && threat.timeToImpact < 2.0
      w.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
      if (
        missilesGone < 0 &&
        w.enemies[0]!.missilesLeft === 0 &&
        w.combat.incomingMissilesInFlight === 0
      ) {
        missilesGone = i / 120
      }
      if (w.player.integrity <= 0) break
    }
    // ミサイルは尽きている。当たっていない
    expect(missilesGone).toBeGreaterThan(0)
    expect(missilesGone).toBeLessThan(20)
    // 落ちた原因は機銃
    expect(w.enemies[0]!.roundsFired).toBeGreaterThan(400)
  })
})
