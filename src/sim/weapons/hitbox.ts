import { Vec3 } from '../vec3'
import type { Quat } from '../quat'

/**
 * 当たり判定の形。
 *
 * 機体を球 1 個で近似すると粗すぎる。全長 17.8 m に対して翼幅 11.6 m あるので、
 * 外接球は半径 9 m になって、翼端の外を通った弾まで当たる。カプセル 3 本で
 * 輪郭に寄せる。
 *
 * **弾は点で判定してはいけない。**初速 1,030 m/s の弾は 1/120 秒で 8.6 m 進む。
 * 前後のステップで位置だけ見ると、半径 1 m の胴体は素通りする。前ステップの
 * 位置から現在位置までの線分と、カプセルの軸線分の最短距離を取る。
 *
 * 寸法はモデルの実測から決めた（`assets/upstream/f18/f18.ac` を当プロジェクトの
 * 座標へ写して部位ごとに境界を取った値）。
 *
 * | 部位 | X 右 | Y 上 | Z 前後 |
 * | 全体 | −5.786..5.786 | −1.786..2.701 | −7.999..9.799 |
 * | 胴体 Fuselage_* | −0.55..0.54 | −0.62..1.09 | −8.00..6.48 |
 * | 主翼 Body_* | −5.52..5.52 | −0.63..0.58 | −4.35..6.98 |
 * | 水平尾翼 Elevator* | −3.43..3.42 | −0.14..0.01 | 4.56..7.39 |
 * | 垂直尾翼 Derive* | −1.73..1.71 | 0.45..2.70 | 2.88..5.41 |
 * | 翼端ミサイル Sidewinder* | −5.79..5.79 | −0.30..0.65 | −0.21..3.05 |
 *
 * 原点は機首から 8.0 m 後ろにある。
 *
 * **覆っていないものがある。**垂直尾翼の Y 1.1 m より上と、翼端ランチャの
 * X ±5.3 より外。どちらも薄くて小さいので、当たらなくても遊びに響かない。
 * 覆うために球を太らせると、外を通った弾が当たるほうの誤りが増える。
 */

/**
 * 機体の外形の実測 m。
 *
 * `assets/upstream/f18/f18.ac` を当プロジェクトの座標へ写して測った値。
 * 当たり判定だけでなく、HUD のロックボックスの大きさにも使う（見かけの
 * 大きさは翼幅で決まる）。
 */
export const AIRCRAFT_SIZE = {
  /** 翼幅。翼端ランチャを含む */
  span: 11.571,
  /** 全長 */
  length: 17.797,
  /** 全高 */
  height: 4.488,
} as const

/** 軸の線分と半径で表す当たり判定。座標は機体座標系 */
export interface Capsule {
  readonly a: Vec3
  readonly b: Vec3
  readonly radius: number
}

/**
 * モデルの実測値（当プロジェクト座標）。カプセルの端点はここから算術で導く。
 *
 * 直書きすると、寸法を測り直したときに端点だけ古いまま残る。実測値を 1 か所に
 * 置いて足し引きで組めば、ずれようがない。実際に胴体の端を 1 mm はみ出させて
 * テストに捕まった。
 */
const MEASURED = {
  /** 機首 */
  noseZ: -7.999,
  /** 胴体（Fuselage_*）の尾側の端 */
  fuselageTailZ: 6.48,
  /** 胴体の断面。幅 1.09 x 高 1.71 m、中心は Y 0.235 */
  fuselageCenterY: 0.235,
  /** 主翼（Body_*）の半翼幅 */
  wingHalfSpan: 5.52,
  /** 主翼の中弦の前後位置。エルロン Z 2.67..3.14 と翼端ランチャ −0.21..3.05 から */
  wingChordZ: 1.4,
  /** 主翼の高さ */
  wingY: 0.2,
  /** 水平尾翼（Elevator*）の半幅と前後の中央 */
  tailHalfSpan: 3.43,
  tailZ: 5.98,
} as const

/**
 * 断面を覆う半径 m。
 *
 * 胴体は幅 1.09 x 高 1.71 m なので、円で覆うには高さの半分 0.855 が要る。
 * 幅に対しては余るが、円でしか近似できない。翼と尾翼は薄いので細くする。
 */
const FUSELAGE_RADIUS = 0.9
const WING_RADIUS = 0.55
const TAIL_RADIUS = 0.55

/**
 * F/A-18C の当たり判定。3 本のカプセル。
 *
 * カプセルは軸の線分を半径ぶん太らせた形なので、端は半球で丸くなる。だから
 * 軸の端点は実際の端から半径ぶん内側へ置く。そうすると丸めた先が実寸に届く。
 */
export const AIRCRAFT_CAPSULES: readonly Capsule[] = [
  {
    a: new Vec3(0, MEASURED.fuselageCenterY, MEASURED.noseZ + FUSELAGE_RADIUS),
    b: new Vec3(0, MEASURED.fuselageCenterY, MEASURED.fuselageTailZ - FUSELAGE_RADIUS),
    radius: FUSELAGE_RADIUS,
  },
  {
    a: new Vec3(-(MEASURED.wingHalfSpan - WING_RADIUS), MEASURED.wingY, MEASURED.wingChordZ),
    b: new Vec3(MEASURED.wingHalfSpan - WING_RADIUS, MEASURED.wingY, MEASURED.wingChordZ),
    radius: WING_RADIUS,
  },
  {
    a: new Vec3(-(MEASURED.tailHalfSpan - TAIL_RADIUS), 0, MEASURED.tailZ),
    b: new Vec3(MEASURED.tailHalfSpan - TAIL_RADIUS, 0, MEASURED.tailZ),
    radius: TAIL_RADIUS,
  },
]

/** 最短距離を求めた結果。器を使い回す */
export interface ClosestResult {
  /** 最短距離の二乗 */
  distanceSq: number
  /** 1 本目の線分上の位置 0..1 */
  s: number
  /** 2 本目の線分上の位置 0..1 */
  t: number
}

export function createClosestResult(): ClosestResult {
  return { distanceSq: 0, s: 0, t: 0 }
}

const EPS = 1e-12

// 一時変数。使い回してゴミを出さない
const d1 = new Vec3()
const d2 = new Vec3()
const r = new Vec3()
const c1 = new Vec3()
const c2 = new Vec3()
const localFrom = new Vec3()
const localTo = new Vec3()
const scratch = new Vec3()

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 線分と線分の最短距離の二乗。
 *
 * Ericson の Real-Time Collision Detection の `ClosestPtSegmentSegment` と
 * 同じ手順。まず無限直線どうしの最近点を解き、範囲外へ出たら端でクランプして
 * もう一方を解き直す。平行なとき（分母が 0）は片方の端を 0 に固定する。
 *
 * `s` と `t` はそれぞれの線分上の位置 0..1。弾の側の `s` は「ステップの
 * どこで当たったか」なので、爆発や着弾の位置を出すのに使える。
 */
export function closestSegmentSegment(
  p1: Vec3,
  q1: Vec3,
  p2: Vec3,
  q2: Vec3,
  out: ClosestResult = createClosestResult(),
): ClosestResult {
  d1.subVectors(q1, p1)
  d2.subVectors(q2, p2)
  r.subVectors(p1, p2)

  const a = d1.dot(d1)
  const e = d2.dot(d2)
  const f = d2.dot(r)

  let s = 0
  let t = 0

  if (a <= EPS && e <= EPS) {
    // どちらも点
    out.distanceSq = r.dot(r)
    out.s = 0
    out.t = 0
    return out
  }

  if (a <= EPS) {
    // 1 本目が点
    s = 0
    t = clamp01(f / e)
  } else {
    const c = d1.dot(r)
    if (e <= EPS) {
      // 2 本目が点
      t = 0
      s = clamp01(-c / a)
    } else {
      const b = d1.dot(d2)
      const denom = a * e - b * b
      // 平行なら分母が 0。s を 0 に固定して t 側だけ解く
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }

  c1.copy(p1).addScaledVector(d1, s)
  c2.copy(p2).addScaledVector(d2, t)
  out.distanceSq = scratch.subVectors(c1, c2).lengthSq()
  out.s = s
  out.t = t
  return out
}

/**
 * 掃引した点（線分）がカプセルに当たるか。
 *
 * @param extraRadius 飛んでいるものの半径。弾は 0 に近く、ミサイルの弾頭は
 *   殺傷半径ぶん持たせる
 */
export function sweptHitsCapsule(
  from: Vec3,
  to: Vec3,
  capsule: Capsule,
  extraRadius = 0,
  out: ClosestResult = createClosestResult(),
): boolean {
  closestSegmentSegment(from, to, capsule.a, capsule.b, out)
  const reach = capsule.radius + extraRadius
  return out.distanceSq <= reach * reach
}

/** 当たった結果。どのカプセルに、ステップのどこで当たったか */
export interface HitResult {
  hit: boolean
  /** 当たったカプセルの添字。当たっていなければ -1 */
  capsule: number
  /** 弾の線分上の位置 0..1。小さいほうが早く当たった */
  s: number
  /** 当たった点の世界座標 */
  readonly point: Vec3
}

export function createHitResult(): HitResult {
  return { hit: false, capsule: -1, s: 1, point: new Vec3() }
}

const closest = createClosestResult()

/**
 * 掃引した点が機体に当たるか。
 *
 * **判定は機体座標系で行う。**カプセルの端点を毎回世界へ回すより、弾の線分を
 * 機体座標へ 1 回落とすほうが安い（2 点対 6 点）。カプセルの定義も動かない。
 *
 * 複数のカプセルに当たったときは、弾の線分上でいちばん早い当たりを返す。
 *
 * @param from 前ステップの弾の位置（世界）
 * @param to 現ステップの弾の位置（世界）
 * @param position 機体の位置（世界）
 * @param orientation 機体の姿勢
 * @param extraRadius 飛んでいるものの半径
 */
export function sweptHitsAircraft(
  from: Vec3,
  to: Vec3,
  position: Vec3,
  orientation: Quat,
  extraRadius = 0,
  capsules: readonly Capsule[] = AIRCRAFT_CAPSULES,
  out: HitResult = createHitResult(),
): HitResult {
  orientation.rotateInverse(scratch.subVectors(from, position), localFrom)
  orientation.rotateInverse(scratch.subVectors(to, position), localTo)

  out.hit = false
  out.capsule = -1
  out.s = 1

  for (let i = 0; i < capsules.length; i++) {
    const capsule = capsules[i]!
    closestSegmentSegment(localFrom, localTo, capsule.a, capsule.b, closest)
    const reach = capsule.radius + extraRadius
    if (closest.distanceSq > reach * reach) continue
    if (out.hit && closest.s >= out.s) continue
    out.hit = true
    out.capsule = i
    out.s = closest.s
  }

  if (out.hit) {
    // 当たった位置を世界へ戻す。弾の線分を s で割るだけでよい
    out.point.copy(from).lerp(to, out.s)
  }
  return out
}

/** 当たり判定の外接半径 m。粗い早期打ち切りに使う */
export function boundingRadius(capsules: readonly Capsule[] = AIRCRAFT_CAPSULES): number {
  let worst = 0
  for (const capsule of capsules) {
    worst = Math.max(worst, capsule.a.length() + capsule.radius)
    worst = Math.max(worst, capsule.b.length() + capsule.radius)
  }
  return worst
}
