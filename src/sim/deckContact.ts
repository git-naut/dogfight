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
 * | 墜落（降下率と機首） | F/A-18E/F の構造設計の範囲の外（`DESIGN_ENVELOPE`） | AIAA 2016-1770 PDF 13 頁 Figure 10 |
 * | 硬い着地（記録だけ） | 17.67 ft/s（5.39 m/s）超え | 同 Table 1、通常の着艦の平均 + 2σ |
 * | 傾き | ±22.1 度 | この機体の形で、片側の主輪で傾けたときに翼端が甲板に当たる角度（原本で測定） |
 *
 * 最初（2026-10-14 の朝）は降下率 24 ft/s（米国特許 4,869,444）と機体の形で当たる角度
 * （機首 −7.6〜+14.2 度）、硬い着地 12 ft/s（arXiv 1901.07951）にしていた。ユーザーが置いた
 * AIAA 2016-1770 に F/A-18E/F そのものの設計の範囲と実測があったので置き換えた（ユーザーの判断）
 *
 * 甲板の形は `FORD_DECK_OUTLINE`（空母の座標、32 頂点）。船体は甲板の輪郭をそのまま海面まで
 * 下ろした柱とみなす。艦橋は `FORD_ISLAND` の箱。**どちらも近似で、機体は原点の 1 点で見る。**
 */

const FT = 0.3048
const DEG = Math.PI / 180

/**
 * F/A-18E/F の構造設計の範囲（接地の 0.25 秒前の機首の角度 deg と降下率 ft/s）。
 *
 * AIAA 2016-1770（Denham、NAVAIR）PDF 13 頁の Figure 10 の赤い線
 * （"The red boundary line is the structural design envelope for the F/A-18E/F aircraft."）。
 * 元の図は 288×483 画素の JPEG で、格子線（2 度ごと・2 ft/s ごと）で軸を合わせ、赤い線の外周を
 * 中心から放射状に拾った（読み取りの誤差は約 0.1 度・0.1 ft/s）。右上の一部（機首 6.6〜10.5 度）は
 * 線が途切れていて、その間は直線でつなぐ。上半分（降下率が中心の 16.9 ft/s より大きい側）だけを
 * 使う。下半分は降下率が小さく構造には楽な側なので、最も広い機首の範囲で見る
 */
export const DESIGN_ENVELOPE: readonly (readonly [number, number])[] = [
  [-3.17, 16.9],
  [-3.17, 18.27],
  [-3.09, 20.08],
  [-2.59, 21.01],
  [-1.76, 22.33],
  [-0.76, 23.7],
  [0.56, 25.12],
  [1.56, 25.67],
  [3.05, 26.44],
  [6.45, 26.38],
  [10.52, 23.42],
  [11.18, 22.44],
  [11.84, 21.23],
  [12.34, 20.03],
  [12.76, 18.55],
  [12.76, 16.9],
]

/** 構造設計の範囲の中心の降下率 ft/s。これより遅ければ機首の範囲だけで見る */
export const ENVELOPE_CENTER_SINK = 16.9
/** 構造設計の範囲の機首の最も広い幅 deg */
export const ENVELOPE_PITCH_MIN = -3.17
export const ENVELOPE_PITCH_MAX = 12.76

export const TOUCHDOWN_LIMITS = {
  /**
   * これを超える降下率は硬い着地として記録する（墜落にはしない）m/s。
   *
   * AIAA 2016-1770 PDF 13 頁の Table 1。手で操縦した通常の着艦の調査 S-67 の平均 13.65 ft/s と
   * 1σ 2.01 ft/s から、平均 + 2σ = 17.67 ft/s。S-68 は 12.99・1.83、S-71 は 11.84・2.25
   */
  hardSinkRate: (13.65 + 2 * 2.01) * FT,
  /**
   * 傾きの上限 rad（左右とも）。構造設計の範囲の図に傾きは無いので、この機体の形で片側の
   * 主輪で傾けたときに翼端が甲板に当たる角度（原本で測定）
   */
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
  if (Math.abs(roll) > TOUCHDOWN_LIMITS.rollMax) return 'deckAttitude'
  const sinkFt = sinkRate / FT
  const pitchDeg = pitch / DEG
  if (sinkFt <= ENVELOPE_CENTER_SINK) {
    return pitchDeg < ENVELOPE_PITCH_MIN || pitchDeg > ENVELOPE_PITCH_MAX ? 'deckAttitude' : null
  }
  if (insidePolygon(DESIGN_ENVELOPE, pitchDeg, sinkFt)) return null
  // 範囲の上端より速いか、上半分の左右の外。機首の幅の内側なら降下率で外れている
  return pitchDeg < ENVELOPE_PITCH_MIN || pitchDeg > ENVELOPE_PITCH_MAX ? 'deckAttitude' : 'deckSink'
}
