/**
 * 国際標準大気（ISA）。
 *
 * 空気密度は揚力・抗力・推力のすべてに掛かるので、高度を上げると
 * 曲がりにくくなり加速も鈍る。飛行ゲームの高度感を作る土台になる。
 */

/** 標準重力加速度 m/s² */
export const GRAVITY = 9.80665

/** 海面高度の空気密度 kg/m³ */
export const SEA_LEVEL_DENSITY = 1.225

/** 対流圏界面の高度 m。ここより上は温度が一定になり式が変わる。 */
export const TROPOPAUSE_ALTITUDE = 11_000

/**
 * 成層圏（等温層）のスケールハイト m。
 *
 * H = R·T/g = 287.05 × 216.65 / 9.80665 ≈ 6341.6。
 * 温度が一定なので密度は指数関数で減る。
 */
const STRATOSPHERE_SCALE_HEIGHT = 6341.62

// 対流圏の気温減率から導かれる密度式の係数。
// ρ = ρ0 · (1 - 2.25577e-5·h)^4.2559
const LAPSE_COEFFICIENT = 2.25577e-5
const DENSITY_EXPONENT = 4.2559

/** 対流圏の式をそのまま界面で評価した値。ここで繋ぐと段差が出ない。 */
export const TROPOPAUSE_DENSITY = troposphereDensity(TROPOPAUSE_ALTITUDE)

function troposphereDensity(altitude: number): number {
  return SEA_LEVEL_DENSITY * (1 - LAPSE_COEFFICIENT * altitude) ** DENSITY_EXPONENT
}

/**
 * 高度から空気密度を返す。
 *
 * 海面より下は海面値で頭打ちにする。地面にめり込んだ瞬間に密度が跳ねて
 * 力が発散するのを防ぐ。
 */
export function airDensity(altitude: number): number {
  if (Number.isNaN(altitude)) return SEA_LEVEL_DENSITY
  if (altitude <= 0) return SEA_LEVEL_DENSITY
  if (altitude < TROPOPAUSE_ALTITUDE) return troposphereDensity(altitude)

  return (
    TROPOPAUSE_DENSITY *
    Math.exp(-(altitude - TROPOPAUSE_ALTITUDE) / STRATOSPHERE_SCALE_HEIGHT)
  )
}

/** 海面高度の気温 K */
export const SEA_LEVEL_TEMPERATURE = 288.15

/** 対流圏の気温減率 K/m */
const TEMPERATURE_LAPSE_RATE = 0.0065

/** 対流圏界面より上の気温 K。等温層なので一定 */
export const TROPOPAUSE_TEMPERATURE =
  SEA_LEVEL_TEMPERATURE - TEMPERATURE_LAPSE_RATE * TROPOPAUSE_ALTITUDE

/**
 * 高度から気温 K を返す。
 *
 * コントレイルが出る条件の判定に使う。密度と違って力には効かないが、
 * 「どの高度で飛行機雲が引けるか」は気温で決まる。
 */
export function temperature(altitude: number): number {
  if (Number.isNaN(altitude)) return SEA_LEVEL_TEMPERATURE
  if (altitude <= 0) return SEA_LEVEL_TEMPERATURE
  if (altitude < TROPOPAUSE_ALTITUDE) {
    return SEA_LEVEL_TEMPERATURE - TEMPERATURE_LAPSE_RATE * altitude
  }
  return TROPOPAUSE_TEMPERATURE
}

/**
 * コントレイルが出始める気温 K。
 *
 * 排気の水蒸気が氷晶になるには −40 度あたりが目安。ISA だと高度 8,460 m
 * より上。実際は湿度と気圧にも依るが、そこまで踏み込まない。
 */
export const CONTRAIL_TEMPERATURE = 233.15

/** 比熱比 */
const GAMMA = 1.4
/** 乾燥空気の気体定数 J/(kg·K) */
const GAS_CONSTANT = 287.05

/**
 * 高度から音速 m/s を返す。
 *
 * a = √(γRT)。海面で 340.3 m/s、対流圏界面で 295.1 m/s。
 *
 * 翼端渦の濃さに使う。渦の芯の温度低下は、無次元で見ると
 * マッハ数と揚力係数の積の二乗に比例する（ΔT/T ∝ γM²Cl²/2）。
 * 揚力係数だけで見ると、速くて荷重倍数の高い引き起こしを過小評価する。
 */
export function speedOfSound(altitude: number): number {
  return Math.sqrt(GAMMA * GAS_CONSTANT * temperature(altitude))
}

/**
 * 動圧 q = ½ρv²。
 *
 * 揚力も抗力も舵の効きも、すべてこの量に比例する。飛行力学で最も
 * 頻繁に出てくる組み合わせなので名前を付けておく。
 */
export function dynamicPressure(density: number, speed: number): number {
  return 0.5 * density * speed * speed
}
