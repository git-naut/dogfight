import { airDensity } from '../isa'
import {
  ARM_TIME,
  BURN_TIME,
  FUZE_RADIUS,
  MISSILE_DIAMETER,
  MISSILE_MASS,
  MISSILE_LIFETIME,
  PROPELLANT_MASS,
  THRUST,
} from './missile'

/**
 * DLZ（Dynamic Launch Zone）。いま撃ったら当たるかを距離で示す。
 *
 * 3 つの半径を出す。
 *
 * - `rMax` 目標が現在の針路を保つ前提で、届く最大の距離
 * - `rNe` 目標が発射の瞬間に反転して逃げても届く距離（no-escape zone）
 * - `rMin` 起動遅れのぶん近すぎて撃てない距離
 *
 * **閉形式では書かない。**ミサイルの 1 次元運動を前方積分して出す。推力と
 * 抗力と質量変化がすべて効くので、近似式にすると効き方が見えなくなる。
 * 実装は 30 行で済むし、毎フレームではなく間隔を空けて更新すれば費用も
 * 問題にならない。
 *
 * **誘導の曲がりは入れていない。**視線に沿った 1 次元の追いかけとして解く。
 * 実機の DLZ も同じ近似で出す。曲がるぶんだけエネルギーを失うので、
 * ここで出る値はやや楽観になる。
 */

/** 前方積分の刻み 秒。0.1 秒で 60 秒ぶんでも 600 歩 */
const DLZ_STEP = 0.1

/** 抗力係数。ミサイルと同じ値を使う */
const DRAG_COEFFICIENT = 0.5
const REFERENCE_AREA = Math.PI * (MISSILE_DIAMETER / 2) ** 2

/**
 * 安全解除と起動の遅れから決まる最小距離 m。
 *
 * 安全解除まで 0.5 秒。そのあいだに閉じる距離より近いと、当たっても
 * 起爆しない。相対速度で変わるので接近速度から出す。
 */
export function minimumRange(closingSpeed: number): number {
  // 接近していないときも下限は残す。誘導が立ち上がる距離
  const closing = Math.max(0, closingSpeed)
  return ARM_TIME * closing + FUZE_RADIUS * 8
}

/**
 * ミサイルの速度と飛距離を前方積分する。
 *
 * @param launchSpeed 発射時の速度 m/s（母機の速度）
 * @param altitude 高度 m。空気密度が抗力に効く
 * @param seconds 何秒ぶん進めるか
 * @returns 飛距離 m と終端速度 m/s
 */
export function integrateMissile(
  launchSpeed: number,
  altitude: number,
  seconds: number,
): { distance: number; speed: number } {
  const density = airDensity(altitude)
  let speed = launchSpeed
  let mass = MISSILE_MASS
  let distance = 0
  let motor = BURN_TIME

  const steps = Math.max(1, Math.round(seconds / DLZ_STEP))
  for (let i = 0; i < steps; i++) {
    let acceleration = 0
    if (motor > 0) {
      const burn = Math.min(DLZ_STEP, motor)
      acceleration += (THRUST / mass) * (burn / DLZ_STEP)
      mass -= (PROPELLANT_MASS / BURN_TIME) * burn
      motor -= DLZ_STEP
    }
    const drag = 0.5 * density * speed * speed * REFERENCE_AREA * DRAG_COEFFICIENT
    acceleration -= drag / mass

    speed = Math.max(0, speed + acceleration * DLZ_STEP)
    distance += speed * DLZ_STEP
  }
  return { distance, speed }
}

/**
 * 追いつける最大の距離 m。
 *
 * ミサイルと目標を同時に前方積分し、**寿命が尽きるまでに詰められた距離**を
 * 返す。詰めた距離がそのまま「その距離から撃てば届く」という意味になる。
 *
 * `targetSpeedAway` は**ミサイルから見て目標が離れていく速さ。**自機との
 * 接近速度ではない。ミサイルの初速には母機の速度が入っているので、そこへ
 * さらに接近速度を足すと二重に数える。
 *
 * **実際にそれで間違えた。**追う構図で接近速度 10 m/s を渡して 27,070 m と
 * 出したが、実測は 12,126 m。同じ向きへ飛ぶ目標はミサイルから見れば 240 m/s
 * で逃げている。240 を渡すと 12,070 m で実測と 0.5% 以内に合う。
 *
 * 打ち切りが 2 つある。一度追い越したあとで再び目標より遅くなったら、
 * そこから先は開く一方なので切る。寿命が尽きてもそこで終わり。
 *
 * **発射直後の遅さで切ってはいけない。**初速は母機の速度なので、逃げる
 * 目標より遅いところから始まることがある。燃焼で追い越すまで待つ。
 */
export function maxRange(
  launchSpeed: number,
  altitude: number,
  targetSpeedAway: number,
): number {
  const density = airDensity(altitude)
  let speed = launchSpeed
  let mass = MISSILE_MASS
  let motor = BURN_TIME
  /** ミサイルが目標に対して詰めた距離 */
  let closed = 0
  /** 一度でも目標より速くなったか。発射直後の遅さで打ち切らないため */
  let overtook = false

  const steps = Math.round(MISSILE_LIFETIME / DLZ_STEP)
  for (let i = 0; i < steps; i++) {
    let acceleration = 0
    if (motor > 0) {
      const burn = Math.min(DLZ_STEP, motor)
      acceleration += (THRUST / mass) * (burn / DLZ_STEP)
      mass -= (PROPELLANT_MASS / BURN_TIME) * burn
      motor -= DLZ_STEP
    }
    const drag = 0.5 * density * speed * speed * REFERENCE_AREA * DRAG_COEFFICIENT
    acceleration -= drag / mass
    speed = Math.max(0, speed + acceleration * DLZ_STEP)

    // 目標に対して詰めた距離。負なら離されている
    closed += (speed - targetSpeedAway) * DLZ_STEP

    /*
     * 打ち切り。
     *
     * **発射直後の遅さで打ち切ってはいけない。**ミサイルの初速は母機の速度
     * なので、逃げる目標より遅いところから始まることがある。実際に母機
     * 180 m/s・目標が 300 m/s で離れる構図（追う構図で接近 −60 m/s）で
     * `rMax` が 0 になったが、実測では 10,768 m 当たる。燃焼で追い越すまで
     * 待つ必要がある。
     *
     * だから「一度追い越したあとで、また遅くなったら」で切る。そこから先は
     * 距離が開く一方になる。
     */
    if (speed > targetSpeedAway) overtook = true
    else if (overtook) break
  }
  return Math.max(0, closed)
}

export interface DlzOptions {
  /** 母機の速度 m/s。ミサイルの初速になる */
  launchSpeed: number
  /** 高度 m */
  altitude: number
  /** 目標の速度 m/s */
  targetSpeed: number
  /** 接近速度 m/s。正で接近 */
  closingSpeed: number
}

export interface Dlz {
  /** 目標が現在の針路を保つ前提で届く最大の距離 m */
  rMax: number
  /** 目標が反転して逃げても届く距離 m */
  rNe: number
  /** 近すぎて撃てない距離 m */
  rMin: number
}

export function createDlz(): Dlz {
  return { rMax: 0, rNe: 0, rMin: 0 }
}

/**
 * DLZ を解く。器を使い回す。
 *
 * **渡すのはミサイルから見た目標の速さ。**自機との接近速度ではない。
 *
 * `rMax` は目標が現在の針路を保つ前提。視線に沿った成分だけを見るので、
 * 追う構図（同じ向きに飛ぶ）なら目標の速度がそのまま離れる速さになり、
 * 正面から向かい合うならその逆向きになる。自機との接近速度と目標の速度から
 * 視線方向の成分を組み直す。
 *
 * `rNe` は目標が発射の瞬間に反転して全速で逃げる前提。目標の速度がそのまま
 * 離れる速さになるので、いちばん厳しい条件になる。
 */
export function solveDlz(options: DlzOptions, out: Dlz = createDlz()): Dlz {
  const { launchSpeed, altitude, targetSpeed, closingSpeed } = options

  /*
   * 目標が視線に沿って離れていく速さ。
   *
   * 接近速度 = 自機の視線方向の速さ − 目標の視線方向の速さ、なので
   * 目標の視線方向の速さ = 自機の速さ − 接近速度 になる。自機の速さは
   * ミサイルの初速でもあるので、`launchSpeed` をそのまま使う。
   *
   * 追う構図（自機 250 / 目標 240）なら 250 − 10 = 240。正面から
   * 向かい合う構図（接近 490）なら 250 − 490 = −240 で、目標が向かってくる。
   */
  const away = launchSpeed - closingSpeed

  out.rMax = maxRange(launchSpeed, altitude, away)
  // 反転して逃げる場合は、目標の速度がそのまま離れる速さになる
  out.rNe = maxRange(launchSpeed, altitude, targetSpeed)
  out.rMin = minimumRange(closingSpeed)

  // 逆転しないようにする。近すぎる状況では rMin が rNe を超えうる
  if (out.rNe > out.rMax) out.rNe = out.rMax
  if (out.rMin > out.rNe) out.rMin = Math.min(out.rMin, out.rNe)
  return out
}

/** 前方積分の刻み。テストから参照する */
export { DLZ_STEP }
