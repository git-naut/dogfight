import type { AircraftSample } from '../sim/aircraft'
import { Vec3 } from '../sim/vec3'
import { elevationOf, headingOf } from './project'

/**
 * HUD に出す数値。
 *
 * **単位の変換は表示層だけで行う。**sim は SI のまま（メートル・秒・ラジアン）
 * で、ノットとフィートへ写すのはここ 1 か所。`CLAUDE.md` の単位系の規約。
 *
 * DOM に触らないので node の単体テストで固定できる。canvas への描き方が
 * 変わっても、読み取れる値の意味は変わらないという分け方にしてある。
 */

/** 1 m/s は何ノットか。1 ノット = 1852 m/h なので 3600/1852 */
export const KNOTS_PER_METER_PER_SECOND = 3600 / 1852
/** 1 m は何フィートか。国際フィートは 0.3048 m ちょうど */
export const FEET_PER_METER = 1 / 0.3048

const DEG = 180 / Math.PI

export function toKnots(metersPerSecond: number): number {
  return metersPerSecond * KNOTS_PER_METER_PER_SECOND
}

export function toFeet(meters: number): number {
  return meters * FEET_PER_METER
}

export interface HudReadout {
  /** 対気速度 kt */
  speedKt: number
  /** 海抜 ft */
  altitudeFt: number
  /** 対地高度 ft */
  aglFt: number
  /** 機首方位 度。真北（-Z）が 0、右回りが正で 0..360 */
  headingDeg: number
  /** 機首の仰角 度。上が正 */
  pitchDeg: number
  /** バンク角 度。右が正 */
  bankDeg: number
  /** 荷重倍数 */
  loadFactor: number
  /** 迎角 度 */
  angleOfAttackDeg: number
  /** 実効スロットル 0..1 */
  throttle: number
  /** 機首の向き（単位ベクトル） */
  nose: Vec3
  /** 速度の向き（単位ベクトル）。速度がほぼ 0 なら機首の向きに倒す */
  flightPath: Vec3
  stalled: boolean
  crashed: boolean
}

export function createHudReadout(): HudReadout {
  return {
    speedKt: 0,
    altitudeFt: 0,
    aglFt: 0,
    headingDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    loadFactor: 1,
    angleOfAttackDeg: 0,
    throttle: 0,
    nose: new Vec3(0, 0, -1),
    flightPath: new Vec3(0, 0, -1),
    stalled: false,
    crashed: false,
  }
}

/** 0..360 度へ写す。方位は負の値で出すと読みにくい */
export function toCompassDegrees(radians: number): number {
  const deg = radians * DEG
  const wrapped = deg % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * サンプルから HUD の数値を作る。器は使い回す。
 *
 * 速度がほぼ 0 のときはフライトパスマーカーの向きが定まらない。機首の向きへ
 * 倒す。0 ベクトルを投影すると同次座標が 0 になって画面の中心に張り付き、
 * 止まった瞬間にマーカーが跳ぶ。
 */
export function computeReadout(sample: AircraftSample, out: HudReadout): HudReadout {
  sample.orientation.forward(out.nose)

  out.speedKt = toKnots(sample.speed)
  out.altitudeFt = toFeet(sample.altitude)
  out.aglFt = toFeet(sample.agl)
  out.headingDeg = toCompassDegrees(headingOf(out.nose.x, out.nose.y, out.nose.z))
  out.pitchDeg = elevationOf(out.nose.x, out.nose.y, out.nose.z) * DEG
  out.bankDeg = sample.bank * DEG
  out.loadFactor = sample.loadFactor
  out.angleOfAttackDeg = sample.angleOfAttack * DEG
  out.throttle = sample.throttle
  out.stalled = sample.stalled
  out.crashed = sample.crashed

  const speed = sample.velocity.length()
  if (speed > 1) out.flightPath.copy(sample.velocity).multiplyScalar(1 / speed)
  else out.flightPath.copy(out.nose)

  return out
}
