/**
 * 空母のまわりの凪と喫水線の泡（段 S4a-3）。three を import しない純関数。
 *
 * 波は見た目だけで、sim の海面は高さ 0 の平面のまま（計画のユーザーの決定 3）。船体の中や船腹に
 * 波が刺さって見えないよう、船体からの距離で変位を 0 へ絞る。係数 s は変位に、s² は傾きの
 * モーメント（LEAN）に掛ける（モーメントは傾きの 2 乗の量）。
 *
 * 船体は水線の形を、端を丸めた長方形（スタジアム形）で近似する。符号付きの距離が m で出るので、
 * 凪の帯と泡の帯の幅を m で決められる。艦尾は実物では角張っているが、凪の帯（30 m）の内側に
 * 収まる。GPU 側（`oceanSurface.ts`・`oceanFoam.ts`）は同じ式を TSL で持つ。
 */

/**
 * 船体の水線（この作品の座標、船の座標系）。空母の模型（`assets/upstream/ford`）の船体の部品
 * `ship_lower`・`ship_mid` の頂点のうち、水面から ±3 m の帯にあるものの外接箱
 * （2026-10-29 に測った）。x は −18.0〜+20.6 m、z は −159.4〜+161.5 m（艦首が −z）。
 * ±1 m の帯では頂点が少なく、z が −154.5〜+161.5 m だった（幅は同じ）
 */
export const CARRIER_HULL = {
  centerX: 1.3,
  centerZ: 1.0,
  halfWidth: 19.3,
  halfLength: 160.5,
} as const

/** 船体の外で波を 0 から元へ戻す帯の幅 m（推測。絵で確かめる） */
export const CARRIER_CALM_BAND = 30
/** 喫水線の泡の帯の幅 m（推測。絵で確かめる） */
export const WATERLINE_FOAM_BAND = 4
/** 喫水線で注ぐ泡の量（クリップマップの注ぎ足しの上限 1 に対して） */
export const WATERLINE_FOAM_STRENGTH = 0.8

export interface CarrierPose {
  x: number
  z: number
  /** 艦首の向き rad。0 で −Z、右回りが正（`carrierDeck.ts` と同じ約束） */
  heading: number
}

/** ワールドの (px, pz) を船の座標系へ。`catapultLaunch` の回転の逆 */
export function carrierLocal(px: number, pz: number, carrier: CarrierPose): [number, number] {
  const dx = px - carrier.x
  const dz = pz - carrier.z
  const c = Math.cos(carrier.heading)
  const s = Math.sin(carrier.heading)
  return [dx * c + dz * s, -dx * s + dz * c]
}

/** 船の座標系の点から船体の水線までの符号付きの距離 m。中は負 */
export function hullDistance(lx: number, lz: number): number {
  const h = CARRIER_HULL
  const qx = Math.abs(lx - h.centerX)
  const qz = Math.max(Math.abs(lz - h.centerZ) - (h.halfLength - h.halfWidth), 0)
  return Math.hypot(qx, qz) - h.halfWidth
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** 変位に掛ける係数 s。船体の中と水線で 0、帯の外で 1 */
export function carrierCalm(distance: number): number {
  return smoothstep(0, CARRIER_CALM_BAND, distance)
}

/** 喫水線で注ぐ泡 0..1。水線の外側の帯で、中では 0 */
export function waterlineFoam(distance: number): number {
  if (distance < 0) return 0
  return (1 - smoothstep(0, WATERLINE_FOAM_BAND, distance)) * WATERLINE_FOAM_STRENGTH
}
