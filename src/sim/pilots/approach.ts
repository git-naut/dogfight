import { Vec3 } from '../vec3'
import {
  GAMMA_TAU,
  PUSH_LIMIT,
  ROLL_BAND,
  ROLL_DAMP,
  climbAngleOf,
  levelAndClimb,
  pitchCap,
  rollRateOf,
  type Steering,
} from '../ai/steering'
import {
  AIRCRAFT,
  APPROACH,
  AUGMENTATION_THROTTLE,
  FLAP_LIFT_COEFFICIENT,
  availableThrust,
  clamp,
  dragCoefficient,
  dragMagnitude,
  liftCoefficient,
} from '../flightModel'
import { GRAVITY, airDensity, dynamicPressure } from '../isa'
import { FLAP_DRAG_COEFFICIENT, GEAR_DRAG_COEFFICIENT } from '../aircraft'
import { FORD_DECK_HEIGHT, FORD_LANDING_CENTERLINE, FORD_WIRES } from '../fordDeck'
import { HOOK_DOWN_ANGLE, hookPointWorld } from '../arrestor'
import { pitchOf, type CarrierPose } from '../deckContact'
import type { Pilot, PilotAxes, PilotFlyer } from './pilot'

/**
 * 着艦の進入の操縦役（Phase 9 の段 10）。
 *
 * **自動スロットル（ATC）の分け方で飛ぶ。スロットルが迎角を保ち、機首で進入の線を飛び、バンクで
 * ラインナップを合わせる。**AIAA 2016-1770（NAVAIR の Denham）PDF 9 頁にある、今の部隊の自動
 * スロットルの形 "While the workload for throttle input has been managed by the FCC, the pilot is
 * still responsible to fly the desired flight path with the longitudinal stick"。
 *
 * 最初は手で飛ぶときの分け方（同 PDF 2 頁 "managing glideslope with throttle, angle of attack with
 * pitch stick inputs, and line-up with lateral stick"）で作った。迎角を機首で保つと、経路を曲げる
 * 揚力が速さの増減からしか出ず、スロットルの式を 6 通り試しても狙う点の ±18.2 ft に入らなかった
 * （最良で 27.9 ft 手前）。同じ論文が "tightly coupled" と書く分け方で、ユーザーの判断で切り替えた
 * （2026-10-14、ADR 0021）。
 *
 * 進入の線は、狙う点（フックが着く点）から艦尾へ `glide` の角度で伸ばした線。**フックの先端で
 * 線に乗る。**狙う点は 1 本目と 2 本目の索の間（同 PDF 11 頁 "the desired hook touchdown point
 * located between the #1 and #2 arresting gear wire"、3 本の艦）。
 *
 * **接地したらスロットルをミリタリー（`AUGMENTATION_THROTTLE`、アフターバーナーなしの全開）へ。**
 * 索に掛からなければ、そのまま飛び去る（ボルター）。TWZ と Fighter Sweep の記事にある手順で、
 * 一次資料ではない。甲板にいるあいだは翼を水平・機首はそのまま、離れたら上昇角 `CLIMB_OUT` で
 * 上がる。
 *
 * 空母は止まっていて風も無い（この作品の前提）。実際の空母は 25〜30 kt ほどで走る
 */

/** 甲板を離れたあとの上昇角 rad。**手触りの値** */
export const CLIMB_OUT = 0.15

/**
 * 進入の線からの高さの誤差を詰める時定数 s。誤差 1 m で、狙う経路角を 1 m ÷（この秒数 × 速さ）
 * だけ動かす。**手触りの値**（`tests/sim/approach.test.ts` で狙う点に入ることを確かめた）。
 *
 * 機首で機首の角度を決めると迎角がまず動き、スロットルが迎角を戻してから経路角が追いつく。
 * 内側が遅いので、外側を 3〜5 秒にすると行き過ぎた（2026-10-14）
 */
export const GLIDE_TAU = 7
/** 狙う経路角を進入角から動かす幅の上限 rad（3 度）。**手触りの値** */
export const GLIDE_CORRECTION_LIMIT = 0.052
/**
 * 機首の角度の誤差を詰める時定数 s。**手触りの値**。狙う機首の角度は「狙う経路角 + 迎角 8.1 度」。
 * 経路角の誤差をそのままピッチへ入れると、経路角が機首より遅れて動くので行き過ぎた（2026-10-14）
 */
export const PITCH_TAU = 1.5
/**
 * 迎角の誤差 1 rad あたりのスロットル。**手触りの値**。迎角が大きい（遅い）ほど開ける。
 * 3 では迎角が 5.5〜10.7 度まで振れた（2026-10-14）
 */
export const AOA_THROTTLE_GAIN = 20
/** 迎角の誤差の積分 1 rad·s あたりのスロットル。**手触りの値** */
export const AOA_THROTTLE_INTEGRAL = 6
/** 横のずれ 1 m あたりの目標のバンク rad。**手触りの値** */
export const LINEUP_GAIN = 0.01
/** 横の速さ 1 m/s あたりの目標のバンク rad。**手触りの値** */
export const LINEUP_RATE_GAIN = 0.06
/** 目標のバンクの上限 rad（15 度）。**手触りの値** */
export const LINEUP_BANK_LIMIT = 0.26

/**
 * 着艦の狙う点と向き（空母の座標）。狙う点は 1 本目と 2 本目の索の中点の中点で、着艦区域の
 * 中心線の上にある。向きは中心線に沿って艦首へ（着艦で機体が進む向き）
 */
export function landingAimLocal(): { x: number; z: number; dirX: number; dirZ: number } {
  const mid = (i: number): [number, number] => {
    const w = FORD_WIRES[i]!
    return [(w.starboard[0] + w.port[0]) / 2, (w.starboard[1] + w.port[1]) / 2]
  }
  const [x1, z1] = mid(0)
  const [x2, z2] = mid(1)
  // 中心線 x = k z + c を z が減る向きに進む
  const k = FORD_LANDING_CENTERLINE.k
  const n = Math.hypot(k, 1)
  return { x: (x1 + x2) / 2, z: (z1 + z2) / 2, dirX: -k / n, dirZ: -1 / n }
}

/**
 * 進入の台本の空母の配置。着艦区域の中心線を世界の −Z 向きに重ね、狙う点を自機の始まり
 * （原点）から `distance` m 前、中心線を `lateral` m 左に置く（自機は中心線の右 `lateral` m から
 * 始まる）
 */
export function approachCarrier(distance: number, lateral: number): CarrierPose {
  const heading = Math.atan(FORD_LANDING_CENTERLINE.k)
  const aim = landingAimLocal()
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  return { x: -lateral - (aim.x * c - aim.z * s), z: -distance - (aim.x * s + aim.z * c), heading }
}

/** 空母の座標の点を世界へ（右回りの heading、`carrierDeckSampler` の逆） */
export function carrierToWorld(carrier: CarrierPose, x: number, z: number): [number, number] {
  const c = Math.cos(carrier.heading)
  const s = Math.sin(carrier.heading)
  return [carrier.x + x * c - z * s, carrier.z + x * s + z * c]
}

const tmp = new Vec3()

/**
 * @param glide 進入角 rad。通常は 3.5 度
 */
export function createApproachPilot(carrier: CarrierPose, glide: number, fixedDt: number): Pilot {
  const aim = landingAimLocal()
  const [ax, az] = carrierToWorld(carrier, aim.x, aim.z)
  const c = Math.cos(carrier.heading)
  const s = Math.sin(carrier.heading)
  // 向きは回すだけ（位置を足さない）
  const dx = aim.dirX * c - aim.dirZ * s
  const dz = aim.dirX * s + aim.dirZ * c
  // 右（進む向きを上から見て右回りに 90 度）
  const rx = -dz
  const rz = dx
  const tanGlide = Math.tan(glide)
  const steering: Steering = { pitch: 0, roll: 0 }
  let aoaIntegral = 0
  let touched = false

  return {
    fly(flyer: PilotFlyer, out: PilotAxes): void {
      out.yaw = 0
      if (flyer.onDeck) touched = true
      if (touched) {
        // 接地したらミリタリー。甲板では翼を水平に、離れたら上がる
        out.throttle = AUGMENTATION_THROTTLE
        if (flyer.onDeck) {
          out.pitch = 0
          out.roll = clamp((-flyer.bank - ROLL_DAMP * rollRateOf(flyer)) / ROLL_BAND, -1, 1)
        } else {
          levelAndClimb(flyer, CLIMB_OUT, GAMMA_TAU, steering)
          out.pitch = steering.pitch
          out.roll = steering.roll
        }
        return
      }

      // 進入の線は、フックの先端で測る（下ろし切った角度で。上げたままでも同じ線を飛ぶ）
      const hook = hookPointWorld(flyer.position, flyer.orientation, HOOK_DOWN_ANGLE, tmp)
      const along = (ax - hook.x) * dx + (az - hook.z) * dz
      const error = hook.y - (FORD_DECK_HEIGHT + along * tanGlide)
      const speed = Math.max(flyer.speed, 1)

      // 機首で経路を飛ぶ。狙う経路角は、進入角に高さの誤差を `GLIDE_TAU` 秒で詰めるぶんを足したもの
      const gammaCmd =
        -glide - clamp(error / (GLIDE_TAU * speed), -GLIDE_CORRECTION_LIMIT, GLIDE_CORRECTION_LIMIT)
      const gamma = climbAngleOf(flyer.velocity)
      // 機首の角度を「狙う経路角 + 進入の迎角」へ。ピッチ率の上限で割ってピッチの入力へ
      const pitchCmd = gammaCmd + APPROACH.alpha
      out.pitch = clamp(
        (pitchCmd - pitchOf(flyer.orientation)) / PITCH_TAU / pitchCap(speed),
        -PUSH_LIMIT,
        1,
      )

      // スロットルが迎角を保つ。いまの経路角で釣り合う推力を式で出し、迎角の誤差で足し引きする
      const density = airDensity(flyer.position.y)
      const q = dynamicPressure(density, speed)
      const cl = liftCoefficient(flyer.angleOfAttack) + FLAP_LIFT_COEFFICIENT * flyer.gearPosition
      const cd =
        dragCoefficient(cl) + (GEAR_DRAG_COEFFICIENT + FLAP_DRAG_COEFFICIENT) * flyer.gearPosition
      const balance =
        (dragMagnitude(q, cd) + AIRCRAFT.mass * GRAVITY * Math.sin(gamma)) /
        Math.cos(flyer.angleOfAttack) /
        availableThrust(1, density)
      const aoaError = flyer.angleOfAttack - APPROACH.alpha
      const raw = balance + AOA_THROTTLE_GAIN * aoaError + AOA_THROTTLE_INTEGRAL * aoaIntegral
      // 振り切っているあいだは積まない（積分の巻き上がりを防ぐ）
      if ((raw < 1 || aoaError < 0) && (raw > 0 || aoaError > 0)) aoaIntegral += aoaError * fixedDt
      out.throttle = clamp(raw, 0, 1)

      // ラインナップはバンクで。右へずれていれば左へ傾ける
      const side = (flyer.position.x - ax) * rx + (flyer.position.z - az) * rz
      const sideRate = flyer.velocity.x * rx + flyer.velocity.z * rz
      const bankTarget = clamp(
        -LINEUP_GAIN * side - LINEUP_RATE_GAIN * sideRate,
        -LINEUP_BANK_LIMIT,
        LINEUP_BANK_LIMIT,
      )
      out.roll = clamp((bankTarget - flyer.bank - ROLL_DAMP * rollRateOf(flyer)) / ROLL_BAND, -1, 1)
    },
  }
}
