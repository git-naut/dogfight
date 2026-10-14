import { Vec3 } from './vec3'
import type { Quat } from './quat'
import type { CrashCause, Touchdown } from './deckContact'

/**
 * 着艦フックと拘束索（Phase 9 の段 8）。
 *
 * **フックの先端が、前のステップから今のステップまでに拘束索の線分を越えたかを掃引で見る。**
 * 弾の当たり判定と同じ作法で、速くても索をすり抜けない。越えた瞬間の先端の高さが索の上端より
 * 低く、速さが上限より遅ければ掛かる。掛かったら `Arrestor` が閉じた式で止める（`Catapult` と
 * 同じ形）。範囲を外れたら掛からずに走り抜ける（ボルター、ユーザーの判断 2026-10-14）。
 *
 * 判定の値（ユーザーと合意、2026-10-14。出典と測り方は ADR 0018）。
 *
 * | 値 | 置いた値 | 根拠 |
 * |---|---|---|
 * | 引き出し長 | 344 ft（104.85 m）、重さと速さに依らず一定 | NAVEDTRA 14310 第 3 章 3-4・3-5 頁（Mk 7 Mod 3） |
 * | 索の上端の高さ | 5 1/2 in（0.14 m） | 同 3-32 頁（最小 2 in、最大 5 1/2 in） |
 * | 掛けてよい最大速度 | 175 mph（152 kt） | DVIDS の NAVAIR の写真説明（Mk 7、50,000 lb まで） |
 * | 中心からのずれ | 索の線分の長さが限界（中心線から左右 13 m） | 甲板の印（`FORD_WIRES`）。定数を置かない |
 * | フックの秒数・角度 | 1 秒・68 度 | **推測** |
 *
 * **値は Nimitz 級の Mk 7 のもの。**Ford の拘束装置は AAG で、AAG の値は見つけていない。
 */

const FT = 0.3048
const DEG = Math.PI / 180

/**
 * 拘束索の値。
 *
 * NAVEDTRA 14310 "Aviation Boatswain's Mate E" 第 3 章 "MK 7 AIRCRAFT RECOVERY EQUIPMENT"。
 * 3-5 頁の表 "Length of deck pendant runout 344 ft (to tail hook)"。3-4 頁 "It is designed to stop
 * all aircraft with the same amount of runout regardless of the aircraft's weight and speed (within
 * the limits specified in current recovery bulletins)"。3-32 頁 "a crossdeck pendant height of
 * 2 inches minimum … and 5 1/2 inches maximum"。
 *
 * 最大速度は DVIDS（米国防総省の広報）の写真 2092094 の説明（NAVAIR の F-35C の試験）
 * "The MK-7 arresting gear is a hydraulic-mechanical engine used to arrest airplanes up to
 * 50,000 pounds gross weight and at engaging speeds of 175 mph"。この機体の 16,650 kg
 * （36,700 lb）は 50,000 lb より軽い
 */
export const ARRESTOR = {
  /** 掛かってから止まるまでの距離 m（フックの位置で測る） */
  runout: 344 * FT,
  /** 索の上端の甲板からの高さ m。フックの先端がこれより低く通れば掛かる */
  wireHeight: 5.5 * 0.0254,
  /** 掛けてよい最大速度 m/s（水平の速さ）。超えたら掛からない */
  maxEngageSpeed: 175 * 0.44704,
} as const

/**
 * フックの付け根（ヒンジ）の位置。**機体座標**（右 +X、上 +Y、機首 −Z）m。
 * 変換の結果（`public/aircraft/f18e.glb` の `extras.hook.origin`、`tools/f18e-hinges.mjs`）
 */
export const HOOK_PIVOT: readonly [number, number, number] = [-0.008, -0.318, 5.299]

/**
 * 収納の姿勢でのフックの先端（下側の縁）の、付け根からの位置 m（機体座標の y, z）。
 * 原本の `Tailhook2` の後端から 5 cm の範囲でいちばん低い点（付け根から 1.720 m 後ろ、
 * 0.335 m 上。5 cm は付け根を決めるときと同じ幅、`tools/f18e-hinges.mjs`）。長さ 1.752 m、
 * 水平より 11 度上を向く
 */
export const HOOK_POINT_STOWED: readonly [number, number] = [0.335, 1.72]

/**
 * フックを下ろし切った角度 rad（収納から、機体の右軸まわりに機首下げの向き）。
 *
 * **推測。**F/A-18E の公表値を見つけていない。3 つの車輪が全部甲板に載った姿勢（機首 0 度）
 * でも先端が甲板に届くよう、先端が主輪の下端より 0.1 m 下へ出る角度（67 度）を切り上げた。
 * 実機のフックはダンパーで甲板へ押し付けられていて、甲板に当たると跳ね上がる。ここでは先端が
 * 甲板より下がらないよう角度を戻す（`hookAngleOnDeck`）
 */
export const HOOK_DOWN_ANGLE = 68 * DEG

/**
 * フックが上げ切りから下ろし切りまで（またはその逆）動く秒数。**推測。**公表値を見つけていない。
 * 脚（5 秒、推測）より速い。実機は自重で落ちる
 */
export const HOOK_TRANSIT_SECONDS = 1

/** 着艦の結果。sim が持ち、テストと（段 11 の）表示が読む */
export type LandingResult =
  | {
      readonly kind: 'trap'
      /** 掛かった索の番号。1 が艦尾に近い */
      readonly wire: 1 | 2 | 3
      /** 掛かったときの水平の速さ m/s */
      readonly engageSpeed: number
      /** 掛かった点の、索の中点（着艦区域の中心線）からのずれ m。右舷が正 */
      readonly offCenter: number
      /** 車輪が甲板に触れたときの記録。車輪より先に掛かれば null */
      readonly touchdown: Touchdown | null
    }
  | {
      readonly kind: 'bolter'
      /**
       * 掛からなかった理由。`hookUp` はフックが下り切っていない、`tooFast` は索を越えたが
       * 最大速度を超えていた、`missed` はフックを下ろしていたが索の上を通った（または外れた）
       */
      readonly reason: 'hookUp' | 'tooFast' | 'missed'
      readonly touchdown: Touchdown | null
    }
  | {
      readonly kind: 'crash'
      readonly cause: CrashCause
      readonly touchdown: Touchdown | null
    }

/** フックが角度 `angle` のときの先端の位置（機体座標）を `out` に書く */
export function hookPointBody(angle: number, out: Vec3): Vec3 {
  const [y, z] = HOOK_POINT_STOWED
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  // 機体の右軸（+X）まわりに +angle 回す。後ろ（+Z）を向いた先端が下がる
  return out.set(HOOK_PIVOT[0], HOOK_PIVOT[1] + y * c - z * s, HOOK_PIVOT[2] + y * s + z * c)
}

const tmp = new Vec3()

/** フックの先端の世界の位置 */
export function hookPointWorld(position: Vec3, orientation: Quat, angle: number, out: Vec3): Vec3 {
  hookPointBody(angle, tmp)
  orientation.rotate(tmp, out)
  return out.add(position)
}

/**
 * 甲板の上でのフックの角度。下ろした角度 `angle` で先端が甲板より下へ出るなら、先端が甲板に
 * 載る角度まで戻す（甲板に当たって跳ね上がる）。先端の高さは角度に対して単調に下がる範囲
 * （0〜`HOOK_DOWN_ANGLE`）なので二分法で解く
 */
export function hookAngleOnDeck(
  position: Vec3,
  orientation: Quat,
  angle: number,
  deckHeight: number,
): number {
  if (hookPointWorld(position, orientation, angle, tmp).y >= deckHeight) return angle
  if (hookPointWorld(position, orientation, 0, tmp).y <= deckHeight) return 0
  let lo = 0
  let hi = angle
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (hookPointWorld(position, orientation, mid, tmp).y > deckHeight) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * 拘束装置。掛かった瞬間の位置・向き・速さから、**閉じた式で**止める。
 *
 * 引き出し長が重さと速さに依らず一定（Mk 7 の CROV）なので、減速度は `v0² / (2 × runout)` の
 * 一定と置く。130 kt で掛かると 2.17 G、3.1 秒で止まる。推力と抗力は水平の動きに効かせない
 * （装置がそのぶんも吸う）。位置は経過ステップ数から毎回計算し直す（`time += dt` の積算をしない）
 */
export class Arrestor {
  /** 減速度 m/s² */
  readonly decel: number
  /** 止まるまでのステップ数 */
  readonly stopSteps: number
  private steps = 0

  constructor(
    /** 掛かった瞬間の機体の原点の水平位置 */
    private readonly startX: number,
    private readonly startZ: number,
    /** 水平の進む向き（単位ベクトル） */
    private readonly dirX: number,
    private readonly dirZ: number,
    /** 掛かった瞬間の水平の速さ m/s */
    readonly engageSpeed: number,
    private readonly fixedDt: number,
  ) {
    this.decel = (engageSpeed * engageSpeed) / (2 * ARRESTOR.runout)
    this.stopSteps = Math.ceil(engageSpeed / this.decel / fixedDt)
  }

  /** 止まり切ったか */
  get stopped(): boolean {
    return this.steps >= this.stopSteps
  }

  /** 掛かってから進んだ距離 m */
  get distance(): number {
    const t = Math.min(this.steps * this.fixedDt, this.engageSpeed / this.decel)
    return this.engageSpeed * t - 0.5 * this.decel * t * t
  }

  /** 1 ステップ進め、水平の位置と速度を書き換える。上下は触らない */
  advance(position: Vec3, velocity: Vec3): void {
    this.steps++
    const t = Math.min(this.steps * this.fixedDt, this.engageSpeed / this.decel)
    const v = Math.max(0, this.engageSpeed - this.decel * t)
    const s = this.engageSpeed * t - 0.5 * this.decel * t * t
    position.x = this.startX + this.dirX * s
    position.z = this.startZ + this.dirZ * s
    velocity.x = this.dirX * v
    velocity.z = this.dirZ * v
  }
}
