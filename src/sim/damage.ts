import { Vec3 } from './vec3'
import { clamp } from './flightModel'
import { TrailRing } from './trail'

/**
 * ダメージの表現。
 *
 * 耐久が減っても落ちるまで何も変わらないと、当てている実感が出ない。
 * **段階を持たせる。**耐久の割合で 2 つの量を出す。
 *
 * | 割合 | 煙 | 舵の効き |
 * | 1.0〜0.6 | なし | そのまま |
 * | 0.6〜0.3 | 薄い | そのまま |
 * | 0.3〜0 | 濃い | 落ちる |
 *
 * **段ではなく傾斜にする。**閾値で切り替えると、1 発当たった瞬間に煙が
 * ぼっと出る。境界で跳ねない形にしておくと、当て続けるほど濃くなるのが
 * 見える。
 *
 * 舵の効きを落とすのは煙より遅らせる。**先に効きが落ちると、まだ煙も出て
 * いないのに動きが鈍って理由が分からない。**
 */

/** 煙が出始める耐久の割合 */
export const SMOKE_ONSET = 0.6
/** 舵の効きが落ち始める耐久の割合 */
export const CONTROL_ONSET = 0.3
/**
 * 耐久が尽きる直前の舵の効き。
 *
 * **0 にはしない。**立て直しができなくなると、撃たれた敵が必ず墜落して
 * しまう。撃墜と墜落の区別が付かなくなるし、`applyAoaLimiter` も効かなく
 * なって失速する。0.55 は「鈍いが飛べる」水準として選んだ値で、
 * 実測で 60 秒の撃ち合いを通しても墜落しないことを確かめてある。
 */
export const CONTROL_FLOOR = 0.55

/**
 * 煙の濃さ 0..1。
 *
 * 割合 0.6 で 0、0 で 1。あいだは線形。
 */
export function damageSmoke(ratio: number): number {
  if (ratio >= SMOKE_ONSET) return 0
  return clamp((SMOKE_ONSET - ratio) / SMOKE_ONSET, 0, 1)
}

/**
 * 舵の効きに掛ける係数 CONTROL_FLOOR..1。
 *
 * 割合 0.3 で 1、0 で `CONTROL_FLOOR`。あいだは線形。
 */
export function damageControl(ratio: number): number {
  if (ratio >= CONTROL_ONSET) return 1
  const t = clamp(ratio / CONTROL_ONSET, 0, 1)
  return CONTROL_FLOOR + (1 - CONTROL_FLOOR) * t
}

/**
 * 煙の履歴の長さ。
 *
 * `SMOKE_STRIDE` ステップごとに記録する。384 本 × 4 ステップ ÷ 120 Hz で
 * 12.8 秒ぶん。250 m/s で飛べば 3.2 km 後ろまで残る。ミサイルの煙
 * （512 本で 17 秒）より短くしてある。機体の煙は薄いので、長く残しても
 * 遠い側は見えない。
 */
export const DAMAGE_SMOKE_LENGTH = 384
/** 何ステップごとに記録するか */
export const DAMAGE_SMOKE_STRIDE = 4

/**
 * 排気口の位置（機体座標）。
 *
 * F-16 の `.ac` では排気口の内壁（`Poly.001`）が X 2.99..4.61 にある。
 * 当方の座標では Z 2.99..4.61 なので、その後端寄り。煙はここから出す。
 */
export const EXHAUST_OFFSET = new Vec3(0, 0, 4.5)

export interface DamageSmokePoint {
  readonly position: Vec3
  /** そのときの煙の濃さ 0..1 */
  readonly smoke: number
}

interface MutableDamageSmokePoint {
  position: Vec3
  smoke: number
}

/** 煙を読む側が要る最小限。描画は履歴の型に縛られない */
export interface DamageSmokeSource {
  readonly trailLength: number
  trailPoint(index: number): DamageSmokePoint
}

// 一時変数。使い回してゴミを出さない
const exhaust = new Vec3()

/**
 * 煙の履歴。
 *
 * `Enemy` が持ち、描画が読む。器は最初に作りきって使い回す。
 */
export class DamageSmoke implements DamageSmokeSource {
  private readonly ring = new TrailRing<MutableDamageSmokePoint>(
    DAMAGE_SMOKE_LENGTH,
    () => ({ position: new Vec3(), smoke: 0 }),
  )
  /** ステップの通し番号。`DAMAGE_SMOKE_STRIDE` ごとに記録する */
  private stepIndex = 0

  get trailLength(): number {
    return this.ring.length
  }

  trailPoint(index: number): DamageSmokePoint {
    return this.ring.at(index)
  }

  /**
   * 1 ステップぶん記録する。
   *
   * **煙が出ていないあいだも記録する。**濃さ 0 の点が並ぶので、描画側は
   * そこを先細りの起点にできる。記録を止めると、傷ついた瞬間に古い位置から
   * 現在まで 1 本の直線が張られる。
   *
   * @param position 機体の位置
   * @param orientation 機体の姿勢。排気口の位置を出すのに使う
   * @param smoke 煙の濃さ 0..1
   */
  record(
    position: Vec3,
    orientation: { rotate(v: Vec3, out: Vec3): Vec3 },
    smoke: number,
  ): void {
    if (this.stepIndex % DAMAGE_SMOKE_STRIDE === 0) {
      const point = this.ring.push()
      orientation.rotate(EXHAUST_OFFSET, exhaust)
      point.position.copy(position).add(exhaust)
      point.smoke = smoke
    }
    this.stepIndex++
  }

  /** 履歴を捨てる。ワールドを作り直すときに呼ぶ */
  clear(): void {
    this.ring.clear()
    this.stepIndex = 0
  }
}
