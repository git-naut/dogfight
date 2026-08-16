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

/**
 * 動圧 q = ½ρv²。
 *
 * 揚力も抗力も舵の効きも、すべてこの量に比例する。飛行力学で最も
 * 頻繁に出てくる組み合わせなので名前を付けておく。
 */
export function dynamicPressure(density: number, speed: number): number {
  return 0.5 * density * speed * speed
}
