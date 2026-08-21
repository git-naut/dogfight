import { describe, it, expect } from 'vitest'
import {
  AIRCRAFT_CAPSULES,
  boundingRadius,
  closestSegmentSegment,
  createHitResult,
  sweptHitsAircraft,
  sweptHitsCapsule,
  type Capsule,
} from '@sim/weapons/hitbox'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'

/**
 * 当たり判定。
 *
 * いちばん大事な性質は「点で判定してはいけない」こと。初速 1,030 m/s の
 * 20mm 弾は 1/120 秒で 8.6 m 進む。前後のステップの位置だけを見ると、
 * 半径 0.9 m の胴体は素通りする。**素通りすることも、掃引なら当たることも、
 * 両方テストに書く。**片方だけだと「掃引が要る」という主張の根拠が残らない。
 */

const v = (x: number, y: number, z: number): Vec3 => new Vec3(x, y, z)

/** 点とカプセルの距離。点判定のふるまいを示すために使う */
function pointDistanceToCapsule(p: Vec3, capsule: Capsule): number {
  const r = closestSegmentSegment(p, p, capsule.a, capsule.b)
  return Math.sqrt(r.distanceSq) - capsule.radius
}

describe('線分と線分の最短距離', () => {
  it('交差していれば 0', () => {
    const r = closestSegmentSegment(v(-1, 0, 0), v(1, 0, 0), v(0, -1, 0), v(0, 1, 0))
    expect(r.distanceSq).toBeCloseTo(0, 12)
    expect(r.s).toBeCloseTo(0.5, 9)
    expect(r.t).toBeCloseTo(0.5, 9)
  })

  it('ねじれの位置では最短距離が離れの大きさになる', () => {
    // X 軸に沿う線分と、Z=3 で Y 軸に沿う線分
    const r = closestSegmentSegment(v(-1, 0, 0), v(1, 0, 0), v(0, -1, 3), v(0, 1, 3))
    expect(Math.sqrt(r.distanceSq)).toBeCloseTo(3, 9)
  })

  it('平行なら向かい合った距離', () => {
    const r = closestSegmentSegment(v(0, 0, 0), v(10, 0, 0), v(0, 2, 0), v(10, 2, 0))
    expect(Math.sqrt(r.distanceSq)).toBeCloseTo(2, 9)
  })

  it('平行で重なりがなければ端どうしの距離', () => {
    const r = closestSegmentSegment(v(0, 0, 0), v(1, 0, 0), v(5, 0, 0), v(6, 0, 0))
    expect(Math.sqrt(r.distanceSq)).toBeCloseTo(4, 9)
    expect(r.s).toBeCloseTo(1, 9)
    expect(r.t).toBeCloseTo(0, 9)
  })

  it('伸ばせば交わるが線分では届かない場合、端で止まる', () => {
    const r = closestSegmentSegment(v(0, 0, 0), v(1, 0, 0), v(5, -1, 0), v(5, 1, 0))
    expect(Math.sqrt(r.distanceSq)).toBeCloseTo(4, 9)
    expect(r.s).toBeCloseTo(1, 9)
  })

  it('片方が点でも解ける', () => {
    const r = closestSegmentSegment(v(3, 4, 0), v(3, 4, 0), v(0, 0, 0), v(10, 0, 0))
    expect(Math.sqrt(r.distanceSq)).toBeCloseTo(4, 9)
    expect(r.t).toBeCloseTo(0.3, 9)
  })

  it('両方が点なら点どうしの距離', () => {
    const r = closestSegmentSegment(v(0, 0, 0), v(0, 0, 0), v(3, 4, 0), v(3, 4, 0))
    expect(Math.sqrt(r.distanceSq)).toBeCloseTo(5, 9)
  })

  it('引数の順を入れ替えても距離は同じ', () => {
    const a = closestSegmentSegment(v(-2, 1, 0), v(4, 1, 3), v(0, -3, 1), v(1, 5, -2))
    const forward = a.distanceSq
    const b = closestSegmentSegment(v(0, -3, 1), v(1, 5, -2), v(-2, 1, 0), v(4, 1, 3))
    expect(b.distanceSq).toBeCloseTo(forward, 12)
  })
})

describe('カプセルの寸法がモデルの実測の内側にある', () => {
  // f18.ac を当プロジェクトの座標へ写した実測
  const MODEL = {
    x: [-5.786, 5.786],
    y: [-1.786, 2.701],
    z: [-7.999, 9.799],
  }

  it('どのカプセルも外形からはみ出さない', () => {
    for (const [i, c] of AIRCRAFT_CAPSULES.entries()) {
      for (const p of [c.a, c.b]) {
        expect(p.x - c.radius, `${i} 番の X 下`).toBeGreaterThanOrEqual(MODEL.x[0]!)
        expect(p.x + c.radius, `${i} 番の X 上`).toBeLessThanOrEqual(MODEL.x[1]!)
        expect(p.y - c.radius, `${i} 番の Y 下`).toBeGreaterThanOrEqual(MODEL.y[0]!)
        expect(p.y + c.radius, `${i} 番の Y 上`).toBeLessThanOrEqual(MODEL.y[1]!)
        expect(p.z - c.radius, `${i} 番の Z 下`).toBeGreaterThanOrEqual(MODEL.z[0]!)
        expect(p.z + c.radius, `${i} 番の Z 上`).toBeLessThanOrEqual(MODEL.z[1]!)
      }
    }
  })

  it('胴体が機首から胴体の尾側の端まで、ちょうど届く', () => {
    const body = AIRCRAFT_CAPSULES[0]!
    // 端点は実測値から半径を引いて置いてあるので、丸めた先が実測に一致する
    expect(body.a.z - body.radius).toBeCloseTo(-7.999, 9)
    expect(body.b.z + body.radius).toBeCloseTo(6.48, 9)
  })

  it('主翼が翼幅の 95% 以上を覆う', () => {
    const wing = AIRCRAFT_CAPSULES[1]!
    const covered = (wing.b.x - wing.a.x + wing.radius * 2) / 11.571
    expect(covered).toBeGreaterThan(0.95)
    expect(covered).toBeLessThanOrEqual(1)
  })

  it('外接半径は機首までの距離で決まる。8 m 前後', () => {
    // 原点は機首から 8.0 m 後ろにあるので、そちらが最も遠い
    expect(boundingRadius()).toBeCloseTo(8.0, 1)
  })

  it('3 本ある。胴体・主翼・水平尾翼', () => {
    expect(AIRCRAFT_CAPSULES).toHaveLength(3)
  })
})

describe('点で判定すると弾が素通りする', () => {
  const body = AIRCRAFT_CAPSULES[0]!

  /** 1 ステップで進む距離 m。初速 1,030 m/s の 20mm 弾 */
  const STEP = 1030 * FIXED_DT

  it('1 ステップで 8.58 m 進む', () => {
    expect(STEP).toBeCloseTo(8.583, 3)
  })

  it('胴体をまたぐ 1 ステップで、両端はどちらも外にある', () => {
    // 胴体の軸（Y 0.24、Z 0 付近）を +X 方向に貫く軌跡
    const from = v(-STEP / 2, 0.24, 0)
    const to = v(STEP / 2, 0.24, 0)
    expect(pointDistanceToCapsule(from, body)).toBeGreaterThan(0)
    expect(pointDistanceToCapsule(to, body)).toBeGreaterThan(0)
    // 端は軸から 4.29 m。半径 0.9 の外
    expect(pointDistanceToCapsule(from, body)).toBeCloseTo(4.29 - 0.9, 1)
  })

  it('同じ 1 ステップを掃引で見ると当たる', () => {
    const from = v(-STEP / 2, 0.24, 0)
    const to = v(STEP / 2, 0.24, 0)
    expect(sweptHitsCapsule(from, to, body)).toBe(true)
  })

  it('機体ごとの判定でも同じ。点なら外れ、掃引なら当たる', () => {
    const position = v(0, 0, 0)
    const orientation = new Quat()
    const from = v(-STEP / 2, 0.24, 0)
    const to = v(STEP / 2, 0.24, 0)

    // 点の判定を「動かない線分」で代用する
    const atFrom = sweptHitsAircraft(from, from, position, orientation)
    const atTo = sweptHitsAircraft(to, to, position, orientation)
    expect(atFrom.hit, '前ステップの位置').toBe(false)
    expect(atTo.hit, '現ステップの位置').toBe(false)

    const swept = sweptHitsAircraft(from, to, position, orientation)
    expect(swept.hit, '掃引').toBe(true)
  })

  it('外れる軌跡は掃引でも外れる。太らせすぎていない', () => {
    const position = v(0, 0, 0)
    const orientation = new Quat()
    // 翼端より 2 m 外、主翼の前後位置を通る
    const from = v(-STEP / 2, 0.2, -20)
    const to = v(STEP / 2, 0.2, -20)
    expect(sweptHitsAircraft(from, to, position, orientation).hit).toBe(false)
  })
})

describe('機体の姿勢に追従する', () => {
  const STEP = 1030 * FIXED_DT

  it('回すと当たり判定も回る', () => {
    const position = v(0, 0, 0)
    // 水平尾翼の位置（機体座標で Z=+5.98、X ±2.88）を狙う軌跡
    const from = v(-STEP / 2, 0, 5.98)
    const to = v(STEP / 2, 0, 5.98)

    const level = new Quat()
    expect(sweptHitsAircraft(from, to, position, level).hit).toBe(true)

    // 機体を 90 度ヨーさせると、同じ世界の軌跡は尾翼を通らない
    const yawed = new Quat().setFromAxisAngle(v(0, 1, 0), Math.PI / 2)
    const after = sweptHitsAircraft(from, to, position, yawed)
    expect(after.capsule).not.toBe(2)
  })

  it('位置をずらすと当たらなくなる', () => {
    const orientation = new Quat()
    const from = v(-STEP / 2, 0.24, 0)
    const to = v(STEP / 2, 0.24, 0)
    expect(sweptHitsAircraft(from, to, v(0, 0, 0), orientation).hit).toBe(true)
    expect(sweptHitsAircraft(from, to, v(0, 500, 0), orientation).hit).toBe(false)
  })
})

describe('当たった位置', () => {
  it('弾の線分を s で割った点が返る', () => {
    const out = createHitResult()
    const from = v(-30, 0.24, 0)
    const to = v(30, 0.24, 0)
    sweptHitsAircraft(from, to, v(0, 0, 0), new Quat(), 0, AIRCRAFT_CAPSULES, out)
    expect(out.hit).toBe(true)
    // 胴体の軸は X=0 にあるので、s は 0.5 付近
    expect(out.s).toBeCloseTo(0.5, 2)
    expect(out.point.x).toBeCloseTo(0, 1)
    expect(out.point.y).toBeCloseTo(0.24, 6)
  })

  it('複数のカプセルに当たったら早いほうを返す', () => {
    const out = createHitResult()
    // 機首の前から尾部へ抜ける軌跡。胴体 → 主翼 → 尾翼の順に当たる
    const from = v(0, 0.24, -30)
    const to = v(0, 0.24, 30)
    sweptHitsAircraft(from, to, v(0, 0, 0), new Quat(), 0, AIRCRAFT_CAPSULES, out)
    expect(out.hit).toBe(true)
    // いちばん前にあるのは胴体（添字 0）
    expect(out.capsule).toBe(0)
    expect(out.point.z).toBeLessThan(-7)
  })

  it('当たらなければ s は 1 のまま', () => {
    const out = createHitResult()
    sweptHitsAircraft(v(0, 900, 0), v(1, 900, 0), v(0, 0, 0), new Quat(), 0, AIRCRAFT_CAPSULES, out)
    expect(out.hit).toBe(false)
    expect(out.capsule).toBe(-1)
  })
})

describe('飛んでいるものの半径', () => {
  it('半径を持たせると当たる範囲が広がる。ミサイルの近接信管に使う', () => {
    const position = v(0, 0, 0)
    const orientation = new Quat()
    // 翼端の 3 m 外を通る
    const from = v(9, 0.2, 1.4)
    const to = v(9, 0.2, 1.5)
    expect(sweptHitsAircraft(from, to, position, orientation, 0).hit).toBe(false)
    // 殺傷半径 8 m を持たせれば届く
    expect(sweptHitsAircraft(from, to, position, orientation, 8).hit).toBe(true)
  })
})
