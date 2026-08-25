import { Vec3 } from '../vec3'
import type { Quat } from '../quat'
import type { Missile } from './missile'

/**
 * ミサイル警告。
 *
 * **どちらへ逃げるかの判断材料を出す。**有無だけでは回避が成立しない。実機は
 * RWR（レーダー警戒受信機）と MAWS（ミサイル接近警報）が別物だが、この作品は
 * 赤外線誘導しかないので RWR に相当するものがない。MAWS だけを作る。
 *
 * 方位は自機の座標系で出す。0 が正面、+π/2 が右、±π が真後ろ。HUD は
 * これを矢印か時計方位に写す。
 *
 * ## 接近しているものだけ
 *
 * 判定は接近速度 V_c = −(r · v) / |r| が正であること。r は自機からミサイルへ
 * の視線ではなく、**ミサイルから自機への視線**で取る（`closingSpeed` と
 * 同じ向き）。
 *
 * **外れたあとも鳴り続けると意味が薄れる。**フレアで逸らしたミサイルは
 * 自機から離れていくので、そこで警告が消える。それが「振り切った」の
 * 手応えになる。
 */

/** 警告を出す最大の距離 m。これより遠いミサイルは無視する */
export const WARNING_RANGE = 8000

/** 接近と見なす最低の接近速度 m/s。これ以下は並走とみなす */
export const WARNING_CLOSING_SPEED = 20

export interface MissileThreat {
  /** 飛んでいて接近しているミサイルがあるか */
  active: boolean
  /** 自機座標系での方位 rad。0 が正面、+ が右、±π が真後ろ */
  bearing: number
  /** いちばん近いものまでの距離 m */
  range: number
  /** 着弾までの秒。接近速度と距離から出す概算 */
  timeToImpact: number
  /** 接近しているミサイルの数 */
  count: number
}

export function createMissileThreat(): MissileThreat {
  return { active: false, bearing: 0, range: 0, timeToImpact: 0, count: 0 }
}

// 一時変数。使い回してゴミを出さない
const los = new Vec3()
const relative = new Vec3()
const local = new Vec3()

/**
 * 脅威を測って `out` へ書く。
 *
 * **いちばん近いものを 1 つだけ出す。**複数を同時に出しても、どちらへ逃げるか
 * 決められない。数だけは `count` で伝える。
 *
 * @param missiles 飛んでいるかもしれないミサイル
 * @param position 自機の位置
 * @param velocity 自機の速度
 * @param orientation 自機の姿勢。方位を機体座標へ落とすのに使う
 */
export function measureThreat(
  missiles: readonly Missile[],
  position: Vec3,
  velocity: Vec3,
  orientation: Quat,
  out: MissileThreat,
): MissileThreat {
  out.active = false
  out.bearing = 0
  out.range = 0
  out.timeToImpact = 0
  out.count = 0

  let nearest: Missile | null = null
  let nearestRange = Infinity
  let nearestClosing = 0

  for (const missile of missiles) {
    if (missile.state !== 'flying') continue

    los.subVectors(position, missile.position)
    const range = los.length()
    if (range < 1e-6 || range > WARNING_RANGE) continue

    // 接近速度。正で接近
    relative.subVectors(velocity, missile.velocity)
    const closing = -relative.dot(los) / range
    if (closing < WARNING_CLOSING_SPEED) continue

    out.count++
    if (range < nearestRange) {
      nearest = missile
      nearestRange = range
      nearestClosing = closing
    }
  }

  if (nearest === null) return out

  out.active = true
  out.range = nearestRange
  out.timeToImpact = nearestRange / nearestClosing

  // 方位。自機から見てミサイルがどちらにいるか
  los.subVectors(nearest.position, position)
  orientation.rotateInverse(los, local)
  // 機首は −Z、右は +X。水平面へ落として角度を取る
  out.bearing = Math.atan2(local.x, -local.z)
  return out
}
