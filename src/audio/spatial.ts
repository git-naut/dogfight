/**
 * 立体の音とドップラー（Phase 10 の段 B11d、ADR 0040）。**純関数だけ。**すれ違いの判定は sim の `flyby.ts`
 *
 * 音は自機から見た向きと距離に置く（Web Audio の PannerNode）。聞き手は原点に置き、向きは既定（前が −Z、
 * 上が +Y）のまま動かさない。この作品の機体の座標（機首 −Z、上 +Y、右 +X）と同じなので、音源の位置を
 * 自機の座標へ直して渡せば、左右と前後がそのまま合う
 */

export interface Vec3Like {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface QuatLike {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

/** 音速 m/s（海面の標準大気） */
export const SPEED_OF_SOUND = 343
/** ドップラーで変える再生の速さの下限と上限。音が崩れるほど変えない（推測） */
export const DOPPLER_MIN = 0.7
export const DOPPLER_MAX = 1.4

/**
 * 世界の座標の相対位置 `rel`（音源 − 自機）を、自機の座標へ直す。姿勢 `q` は機体 → 世界の回転なので、
 * 逆に回す（共役で回す）
 */
export function toListenerLocal(rel: Vec3Like, q: QuatLike, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // v' = q* v q。共役で回すので、q の xyz の符号を反転して通常の回転の式に入れる
  const qx = -q.x
  const qy = -q.y
  const qz = -q.z
  const qw = q.w
  const tx = 2 * (qy * rel.z - qz * rel.y)
  const ty = 2 * (qz * rel.x - qx * rel.z)
  const tz = 2 * (qx * rel.y - qy * rel.x)
  out.x = rel.x + qw * tx + (qy * tz - qz * ty)
  out.y = rel.y + qw * ty + (qz * tx - qx * tz)
  out.z = rel.z + qw * tz + (qx * ty - qy * tx)
  return out
}

/**
 * ドップラーの再生の速さ。`rel` は音源 − 自機の位置、`relVel` は音源 − 自機の速度。近づく速さ v で
 * 音速 ÷（音速 − v）。0.7〜1.4 で止める
 */
export function dopplerRate(rel: Vec3Like, relVel: Vec3Like): number {
  const d = Math.hypot(rel.x, rel.y, rel.z)
  if (d < 1e-6) return 1
  const closing = -(rel.x * relVel.x + rel.y * relVel.y + rel.z * relVel.z) / d
  const denominator = SPEED_OF_SOUND - closing
  if (denominator <= 0) return DOPPLER_MAX
  return Math.min(DOPPLER_MAX, Math.max(DOPPLER_MIN, SPEED_OF_SOUND / denominator))
}
