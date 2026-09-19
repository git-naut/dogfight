import { Vec3 } from '../vec3'
import type { Quat } from '../quat'

/**
 * 当たり判定の形。
 *
 * 機体を球 1 個で近似すると粗すぎる。全長 18.3 m に対して翼幅 13.2 m あるので、
 * 外接球は半径 10 m になって、翼端の外を通った弾まで当たる。カプセル 3 本で
 * 輪郭に寄せる。
 *
 * **弾は点で判定してはいけない。**初速 1,030 m/s の弾は 1/120 秒で 8.6 m 進む。
 * 前後のステップで位置だけ見ると、半径 1 m の胴体は素通りする。前ステップの
 * 位置から現在位置までの線分と、カプセルの軸線分の最短距離を取る。
 *
 * 寸法は `public/aircraft/f18e.glb` の実測。**部位ごとの名前が無い**ので、
 * Z で 1 m ずつ切った断面から取った（C 型は `Fuselage_*` のようなノード名で
 * 分かれていた）。
 *
 * | 部位 | X 右 | Y 上 | Z 前後 |
 * | 全体 | −6.596..6.594 | −1.659..3.249 | −10.311..7.999 |
 * | 胴体（兵装を外した断面） | 幅 2.62 | −0.35..1.73 | −10.31..7.02 |
 * | 主翼の板 | −6.594..6.594 | 0.30..0.69 | −0.06..2.98 |
 * | 水平尾翼（スタビレータ） | −3.542..3.542 | 0.32..0.55 | 3.96..8.00 |
 * | 垂直尾翼（ラダー） | −1.59..1.61 | 0.90..2.64 | 4.43..5.47 |
 *
 * 原点は機首から 10.3 m 後ろにある。
 *
 * **覆っていないものがある。**垂直尾翼の Y 1.45 m より上と、胴体の幅
 * 2.62 m のうち中心から 0.9 m より外（双発ナセルと LEX）。前者は薄く、
 * 後者を覆うと全長 17 m の太い円柱になる。覆うために球を太らせると、
 * 外を通った弾が当たるほうの誤りが増える。
 */

/**
 * 機体の外形の実測 m。
 *
 * `public/aircraft/f18e.glb` の bbox。当たり判定だけでなく、HUD の
 * ロックボックスの大きさにも使う（見かけの大きさは翼幅で決まる）。
 */
export const AIRCRAFT_SIZE = {
  /** 翼幅。翼端ランチャを含む */
  span: 13.19,
  /** 全長 */
  length: 18.31,
  /** 全高 */
  height: 4.908,
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
  noseZ: -10.311,
  /** 胴体の尾側の端。Z 7.02 より後ろは幅 0.10 の突起だけ */
  fuselageTailZ: 7.02,
  /** 胴体の断面。幅 2.62 x 高 1.72 m、中心は Y 0.55 */
  fuselageCenterY: 0.55,
  /** 主翼の半翼幅。**翼端ランチャまで含む**（そこも被弾する） */
  wingHalfSpan: 6.594,
  /** 主翼の中弦の前後位置。板は Z −0.06..2.94 */
  wingChordZ: 1.44,
  /** 主翼の高さ。板は Y 0.30..0.69 */
  wingY: 0.5,
  /** 水平尾翼（スタビレータ）の半幅と前後の中央 */
  tailHalfSpan: 3.542,
  tailZ: 5.98,
  /** 水平尾翼の高さ。板は Y 0.32..0.55 */
  tailY: 0.43,
} as const

/**
 * 断面を覆う半径 m。
 *
 * 胴体は幅 2.62 x 高 1.72 m。円で覆うには高さの半分 0.86 を採る。
 * **幅には足りない。**双発ナセルと前縁付け根の延長（LEX）まで覆うと、
 * 機体の中心線から 1.3 m の円柱が全長 17 m にわたって伸びることになり、
 * 実機より太い当たり判定になる。翼と尾翼は薄いので細くする。
 *
 * C 型の胴体は幅 1.09 x 高 1.71 m で、高さで決めた同じ 0.9 が幅に対して
 * 余っていた。**E 型では余りが不足へ変わる**が、値は据え置く。
 */
const FUSELAGE_RADIUS = 0.9
const WING_RADIUS = 0.55
const TAIL_RADIUS = 0.55

/**
 * F/A-18E の当たり判定。3 本のカプセル。
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
    a: new Vec3(-(MEASURED.tailHalfSpan - TAIL_RADIUS), MEASURED.tailY, MEASURED.tailZ),
    b: new Vec3(MEASURED.tailHalfSpan - TAIL_RADIUS, MEASURED.tailY, MEASURED.tailZ),
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
