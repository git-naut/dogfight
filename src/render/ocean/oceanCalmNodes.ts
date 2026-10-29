import { abs, clamp, float, length, max, vec2 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import {
  CARRIER_CALM_BAND,
  CARRIER_HULL,
  WATERLINE_FOAM_BAND,
  WATERLINE_FOAM_STRENGTH,
  type CarrierPose,
} from './oceanCalm'

/**
 * 空母のまわりの凪と喫水線の泡を TSL で（段 S4a-3）。式は `oceanCalm.ts` と 1 対 1。
 * 空母が居ない場面では、凪は 1、泡は 0 の定数を返す（節点を作らない）
 */

type N<T extends string> = Node<T>

export interface CalmNodes {
  /** 変位に掛ける係数 s（傾きとモーメントには s と s²） */
  calm(xz: N<'vec2'>): N<'float'>
  /** 喫水線で注ぐ泡 0..1 */
  waterline(xz: N<'vec2'>): N<'float'>
}

const smoothstep01 = (t: N<'float'>) => {
  const c = clamp(t, 0, 1)
  return c.mul(c).mul(float(3).sub(c.mul(2))) as unknown as N<'float'>
}

export function createCalmNodes(carrier: CarrierPose | null): CalmNodes {
  if (carrier === null) {
    return {
      calm: () => float(1) as unknown as N<'float'>,
      waterline: () => float(0) as unknown as N<'float'>,
    }
  }
  const c = Math.cos(carrier.heading)
  const s = Math.sin(carrier.heading)
  const h = CARRIER_HULL
  /** 船体の水線までの符号付きの距離 m（`hullDistance`） */
  const distance = (xz: N<'vec2'>) => {
    const d = xz.sub(vec2(carrier.x, carrier.z))
    const lx = d.x.mul(c).add(d.y.mul(s))
    const lz = d.x.mul(-s).add(d.y.mul(c))
    const qx = abs(lx.sub(h.centerX))
    const qz = max(abs(lz.sub(h.centerZ)).sub(h.halfLength - h.halfWidth), 0)
    return length(vec2(qx, qz)).sub(h.halfWidth) as unknown as N<'float'>
  }
  return {
    calm: (xz) => smoothstep01(distance(xz).div(CARRIER_CALM_BAND)),
    waterline: (xz) => {
      const d = distance(xz)
      const inside = d.lessThan(0)
      const v = float(1).sub(smoothstep01(d.div(WATERLINE_FOAM_BAND))).mul(WATERLINE_FOAM_STRENGTH)
      return inside.select(float(0), v) as unknown as N<'float'>
    },
  }
}
