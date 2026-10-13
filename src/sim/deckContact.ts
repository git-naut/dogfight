import { Vec3 } from './vec3'
import type { Quat } from './quat'
import { FORD_DECK_HEIGHT, FORD_DECK_OUTLINE, FORD_ISLAND } from './fordDeck'

/**
 * 空母の甲板の当たり（Phase 9 の段 7）。
 *
 * **甲板の上で、脚が出ていて、降下率と姿勢が範囲の内側なら、車輪で走る。**範囲を外れたら
 * 墜落。脚を上げたまま触れたとき、艦橋に当たったとき、甲板の下（船体）に入ったときも墜落。
 * 甲板の外は今までどおり地形と海面で当たる（`aircraft.ts`）。
 *
 * 判定の値（ユーザーと合意、2026-10-14。出典と測り方は ADR 0018）。
 *
 * | 判定 | 値 | 根拠 |
 * |---|---|---|
 * | 墜落になる降下率 | 7.32 m/s（24 ft/s） | 米国特許 4,869,444（Boeing、1989）PDF 12 頁「艦上機は典型的に最大 24 ft/s の降下率を受ける」 |
 * | 硬い着地（記録だけ） | 3.66 m/s（12 ft/s） | arXiv 1901.07951 PDF 15 頁「着艦の成功は最終の降下率 12 ft/s 未満」 |
 * | 機首の角度 | −7.6〜+14.2 度 | この機体の形で、主輪を甲板に付けて機首を下げ・上げたときに機体が甲板に当たる角度（原本で測定） |
 * | 傾き | ±22.1 度 | 同じく、片側の主輪で傾けたときに翼端が当たる角度 |
 *
 * 甲板の形は `FORD_DECK_OUTLINE`（空母の座標、32 頂点）。船体は甲板の輪郭をそのまま海面まで
 * 下ろした柱とみなす。艦橋は `FORD_ISLAND` の箱。**どちらも近似で、機体は原点の 1 点で見る。**
 */

const FT = 0.3048
const DEG = Math.PI / 180

export const TOUCHDOWN_LIMITS = {
  /** これを超える降下率で触れたら墜落 m/s */
  sinkRate: 24 * FT,
  /** これを超える降下率は硬い着地として記録する（墜落にはしない）m/s */
  hardSinkRate: 12 * FT,
  /** 機首の角度の範囲 rad。上げが正 */
  pitchMin: -7.6 * DEG,
  pitchMax: 14.2 * DEG,
  /** 傾きの上限 rad（左右とも） */
  rollMax: 22.1 * DEG,
} as const

/**
 * 車輪の下端の位置。**機体座標**（右 +X、上 +Y、機首 −Z）m。原本（`assets/upstream/f18e`）の
 * 車輪の部品の外接箱から測った（`tests/sim/deckContact.test.ts` が原本と突き合わせる）。
 * **原本の横 z が機体の −x** になる
 * （`tools/f18e-to-glb.mjs` の回転 (x, y, z) → (−z, y, x)）。原本で +z が左（`La1` が +5.41）。
 * 主輪は左右で横位置がわずかに違う（原本のまま）
 */
export const WHEELS: readonly (readonly [number, number, number])[] = [
  // 右の主輪（原本 Meshpart184、横 z −1.322）
  [1.322, -1.658, 0.7],
  // 左の主輪（原本 Meshpart189、横 z +1.410）
  [-1.41, -1.659, 0.792],
  // 前輪（原本 Meshpart192）
  [0.002, -1.618, -5.096],
]

/**
 * 脚を上げたときの機体の最下点の深さ m（原点から下）。脚とフックを除いた部品のうち
 * いちばん低い点（胴体の下の吊り下げ物、原本 Meshpart146、前後 −2.2〜2.3 m）
 */
export const BELLY_DEPTH = 1.046

/**
 * 甲板の上で車輪が転がる抵抗の係数（減速度 = 係数 × g）。
 *
 * **推測。**タイヤの転がり抵抗の一般的な大きさ（0.01〜0.02 程度）から置いた。拘束索で止める
 * のは段 8 で、それまでは甲板の端から飛び立つか落ちる
 */
export const ROLLING_FRICTION = 0.02

/** 空母の配置。位置は世界座標 m、向きは方位 rad（0 で艦首が −Z、右回りが正） */
export interface CarrierPose {
  readonly x: number
  readonly z: number
  readonly heading: number
}

/** 甲板の当たりを引くもの。`Aircraft.step` が読む */
export interface DeckSampler {
  /** 世界の (x, z) の真上に飛行甲板があればその高さ m、無ければ null */
  deckHeightAt(x: number, z: number): number | null
  /** 世界の点が艦橋の箱の中か */
  insideIsland(x: number, y: number, z: number): boolean
}

/** 墜落の原因。テストと表示が読む */
export type CrashCause = 'ground' | 'deckSink' | 'deckAttitude' | 'belly' | 'island' | 'hull'

/** 甲板に触れたときの記録（段 8 の着艦の結果が読む） */
export interface Touchdown {
  /** 降下率 m/s（下向きが正） */
  readonly sinkRate: number
  /** 機首の角度 rad（上げが正） */
  readonly pitch: number
  /** 傾き rad（右が正） */
  readonly roll: number
  /** 降下率が `hardSinkRate` を超えたか */
  readonly hard: boolean
}

/** 多角形の内側か（偶奇の規則） */
function insidePolygon(poly: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!
    const [xj, zj] = poly[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/**
 * 空母の配置から甲板の当たりを作る。
 *
 * 世界から空母の座標へは、配置の回転（右回りが正、`catapultLaunch` と同じ約束）の逆を掛ける
 */
export function carrierDeckSampler(carrier: CarrierPose): DeckSampler {
  const cos = Math.cos(carrier.heading)
  const sin = Math.sin(carrier.heading)
  const toLocal = (x: number, z: number): [number, number] => {
    const dx = x - carrier.x
    const dz = z - carrier.z
    return [dx * cos + dz * sin, -dx * sin + dz * cos]
  }
  return {
    deckHeightAt(x, z) {
      const [lx, lz] = toLocal(x, z)
      return insidePolygon(FORD_DECK_OUTLINE, lx, lz) ? FORD_DECK_HEIGHT : null
    },
    insideIsland(x, y, z) {
      const [lx, lz] = toLocal(x, z)
      const b = FORD_ISLAND
      return y <= b.top && lx >= b.xMin && lx <= b.xMax && lz >= b.zMin && lz <= b.zMax
    },
  }
}

const tmp = new Vec3()

/**
 * いちばん低い接点の世界の高さ m。脚が出し切りなら車輪 3 つのうち最も低いもの、
 * そうでなければ機体の最下点（`BELLY_DEPTH`）
 */
export function lowestContact(position: Vec3, orientation: Quat, gearDown: boolean): number {
  if (!gearDown) return position.y - BELLY_DEPTH
  let lowest = Infinity
  for (const [x, y, z] of WHEELS) {
    orientation.rotate(tmp.set(x, y, z), tmp)
    lowest = Math.min(lowest, position.y + tmp.y)
  }
  return lowest
}

/** 機首の角度 rad（上げが正）。機首方向 (0, 0, −1) を回した y 成分から */
export function pitchOf(orientation: Quat): number {
  orientation.rotate(tmp.set(0, 0, -1), tmp)
  return Math.asin(Math.max(-1, Math.min(1, tmp.y)))
}

/** 傾き rad（右翼下げが正）。右翼 (1, 0, 0) を回した y 成分から */
export function rollOf(orientation: Quat): number {
  orientation.rotate(tmp.set(1, 0, 0), tmp)
  return -Math.asin(Math.max(-1, Math.min(1, tmp.y)))
}

/** 触れた瞬間の値を判定する。範囲の内側なら null、外なら墜落の原因 */
export function judgeTouchdown(sinkRate: number, pitch: number, roll: number): CrashCause | null {
  const L = TOUCHDOWN_LIMITS
  if (sinkRate > L.sinkRate) return 'deckSink'
  if (pitch < L.pitchMin || pitch > L.pitchMax || Math.abs(roll) > L.rollMax) return 'deckAttitude'
  return null
}
