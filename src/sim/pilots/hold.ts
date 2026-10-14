import { GAMMA_TAU, levelAndClimb, type Steering } from '../ai/steering'
import { clamp } from '../flightModel'
import type { Pilot, PilotAxes, PilotFlyer } from './pilot'

/**
 * 翼を水平にして上昇角 0 を保ち、速さを保つ操縦役（Phase 9 の段 9）。
 *
 * 口（`ReplayScript.pilot`）を確かめるためのいちばん小さい操縦役で、段 10 の着艦の進入でも
 * 部品として使う。姿勢は `levelAndClimb`（敵の AI の立て直しと同じ部品）、速さはスロットルの
 * 比例積分で合わせる。
 *
 * **積分の初期値は、最初のステップで機体の実効スロットルにそろえる。**台本は釣り合いの
 * スロットルで始まるので、0 から積むと最初の数秒で速さが落ちる
 */

/** 速さの誤差 1 m/s あたりのスロットル。**手触りの値**（`tests/sim/pilots.test.ts` で収束を確かめた） */
export const HOLD_SPEED_GAIN = 0.05
/** 速さの誤差の積分 1 m あたりのスロットル。**手触りの値** */
export const HOLD_SPEED_INTEGRAL = 0.01

export function createHoldPilot(speed: number, fixedDt: number): Pilot {
  const steering: Steering = { pitch: 0, roll: 0 }
  let integral: number | null = null
  return {
    fly(flyer: PilotFlyer, out: PilotAxes): void {
      levelAndClimb(flyer, 0, GAMMA_TAU, steering)
      out.pitch = steering.pitch
      out.roll = steering.roll
      out.yaw = 0
      const error = speed - flyer.speed
      // 最初の 1 回で、出力が今のスロットルになる積分の値から始める
      if (integral === null) integral = (flyer.throttle - HOLD_SPEED_GAIN * error) / HOLD_SPEED_INTEGRAL
      const raw = HOLD_SPEED_GAIN * error + HOLD_SPEED_INTEGRAL * integral
      // 振り切っているあいだは積まない（積分の巻き上がりを防ぐ）
      if ((raw < 1 || error < 0) && (raw > 0 || error > 0)) integral += error * fixedDt
      out.throttle = clamp(raw, 0, 1)
    },
  }
}
