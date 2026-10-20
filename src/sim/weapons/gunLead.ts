/**
 * 機銃の未来位置（Phase 10 の段 D4、ADR 0032）。**純関数。**
 *
 * 録画（ACE COMBAT 7 の講座）の機銃の照準は、敵が近いと敵に重なる（lesson 4 のコマ 12734〜12758、
 * 15512〜15548）。ここでは「弾が届くときに敵がいる位置」（未来位置）と、そこへ弾を届ける向きを出す。
 *
 * 弾は機体の速度を引き継ぎ、抗力で遅くなり、重力で落ちる（`gun.ts`）。銃口から向き d へ撃った弾の位置を
 *
 *   M + Vo·t + d·s(t) − ½·g·t²·ŷ、s(t) = ln(1 + K·v₀·t) / K
 *
 * とみて、敵が等速で T + Vt·t へ動くとして、d·s(t) = T − M + (Vt − Vo)·t + ½·g·t²·ŷ を満たす t を
 * 距離から時間を出す式を繰り返して解き、最初の向きにする。この式は抗力に機体の速度のぶんと高度の空気の
 * 薄さを入れない近似で、撃った弾が 2〜3.7 m 外れた（`tests/sim/gunLead.test.ts`）。そこで弾と同じ式
 * （`stepBullet`）で 1 発を飛ばし、いちばん近づいたときの外れのぶん向きを直すことを `SHOTS` 回くり返す。
 *
 * 相手が旋回していると、等速とみた未来位置から 0.6 秒で 2 m ほど横へずれ、500 m 先で旋回率 0.05 rad/s の
 * 標的に 1 発しか当たらなかった。相手の加速度 A（前のステップからの速度の変化）を渡せば、相手の位置を
 * T + Vt·t + ½·A·t² とみる
 */
import { Vec3 } from '../vec3'
import { GRAVITY } from '../isa'
import { MUZZLE_SPEED, bulletTimeToRange, stepBullet } from './gun'
import { FIXED_DT } from '../loop'

/** 照準が敵に吸い付く距離 m（ユーザーの決定。録画の 2,028〜2,445 を ft とみると 620〜750 m） */
export const GUN_SNAP_RANGE = 800
/** 吸い付く相手の、機首からの角の上限 rad（**推測**。録画からは測れなかった） */
export const GUN_SNAP_ANGLE = (30 * Math.PI) / 180
/** 弾を未来位置へ曲げる、機首からの角の上限 rad（ユーザーの決定。値は推測） */
export const GUN_ASSIST_ANGLE = (5 * Math.PI) / 180
/** 式で時間を解き直す回数 */
const ITERATIONS = 4
/** 弾を飛ばして向きを直す回数 */
const SHOTS = 3
/** 弾を飛ばして確かめる最長の秒（800 m を超えて飛ばさない） */
const MAX_FLIGHT = 1.5

export interface GunLead {
  /** 弾が届くまでの秒 */
  time: number
  /** 未来位置（ワールド m）。弾が届くときに相手がいる位置 */
  readonly future: Vec3
  /** そこへ弾を届ける向き（単位ベクトル） */
  readonly aim: Vec3
}

export function createGunLead(): GunLead {
  return { time: 0, future: new Vec3(), aim: new Vec3() }
}

const ZERO = new Vec3()
const rel = new Vec3()
const pos = new Vec3()
const vel = new Vec3()
const where = new Vec3()
const miss = new Vec3()
const prevRel = new Vec3()
const curRel = new Vec3()
const seg = new Vec3()
const closest = new Vec3()

/**
 * 未来位置と向きを `out` に書く。
 *
 * @param muzzle 銃口の位置
 * @param own 自機の速度（弾が引き継ぐ）
 * @param target 相手の位置
 * @param targetVelocity 相手の速度
 */
export function solveGunLead(
  muzzle: Vec3,
  own: Vec3,
  target: Vec3,
  targetVelocity: Vec3,
  out: GunLead,
  targetAcceleration: Vec3 = ZERO,
): GunLead {
  rel.subVectors(target, muzzle)
  let t = bulletTimeToRange(rel.length(), MUZZLE_SPEED)
  for (let i = 0; i < ITERATIONS; i++) {
    rel.subVectors(target, muzzle)
    rel.x += (targetVelocity.x - own.x) * t + 0.5 * targetAcceleration.x * t * t
    rel.y += (targetVelocity.y - own.y) * t + 0.5 * (GRAVITY + targetAcceleration.y) * t * t
    rel.z += (targetVelocity.z - own.z) * t + 0.5 * targetAcceleration.z * t * t
    t = bulletTimeToRange(rel.length(), MUZZLE_SPEED)
  }
  out.aim.copy(rel).normalize()
  out.time = t

  // 弾と同じ式で 1 発を飛ばし、いちばん近づいたときの外れを、その距離で割った角だけ向きを直す
  for (let shot = 0; shot < SHOTS; shot++) {
    pos.copy(muzzle)
    vel.copy(own).addScaledVector(out.aim, MUZZLE_SPEED)
    let best = Infinity
    let bestT = 0
    // 相手から見た弾の位置（相対）。1 ステップのあいだは直線とみて、線分の上でいちばん近い点を取る。
    // 相対の速さは 1,000 m/s を超えるので、ステップの端の点だけを見ると狙いが合っていても数 m 外れて見える
    prevRel.subVectors(muzzle, target)
    for (let i = 1; i * FIXED_DT <= MAX_FLIGHT; i++) {
      stepBullet(pos, vel, FIXED_DT)
      const ti = i * FIXED_DT
      where.copy(target).addScaledVector(targetVelocity, ti).addScaledVector(targetAcceleration, 0.5 * ti * ti)
      curRel.subVectors(pos, where)
      seg.subVectors(curRel, prevRel)
      const len2 = seg.lengthSq()
      const k = len2 > 0 ? Math.min(1, Math.max(0, -prevRel.dot(seg) / len2)) : 0
      closest.copy(prevRel).addScaledVector(seg, k)
      const d = closest.lengthSq()
      if (d < best) {
        best = d
        bestT = (i - 1 + k) * FIXED_DT
        miss.copy(closest).multiplyScalar(-1)
      } else if (k === 0) break
      prevRel.copy(curRel)
    }
    // 外れを、銃口から相手までの距離で割った角だけ向きを足す
    const range = where
      .copy(target)
      .addScaledVector(targetVelocity, bestT)
      .addScaledVector(targetAcceleration, 0.5 * bestT * bestT)
      .sub(muzzle)
      .length()
    out.aim.addScaledVector(miss, 1 / Math.max(range, 1)).normalize()
    out.time = bestT
  }
  out.future
    .copy(target)
    .addScaledVector(targetVelocity, out.time)
    .addScaledVector(targetAcceleration, 0.5 * out.time * out.time)
  return out
}
