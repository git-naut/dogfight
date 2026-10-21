/**
 * エンジン音の 3 層の混ぜ方（Phase 10 の段 B11b、ADR 0038）。**純関数と定数だけ。**
 *
 * 実録音のループ 3 本（`public/audio/`、ADR 0037）をスロットルで重ねる。アイドル（F-22 のアイドル）は
 * 低いスロットルで大きく、タービン（ジェットのタービン）はスロットルとともに大きく高くなり、
 * アフターバーナー（轟音）は sim の `AUGMENTATION_THROTTLE`（0.85）を越えると重なる。0.85 を下から
 * 越えた瞬間に点火の音を 1 回鳴らす。値は耳で詰めた推測（ユーザーが試聴して決める）
 */
import { AUGMENTATION_THROTTLE } from '../sim/flightModel'

/** 3 層の大きさ（0..1、ループは RMS −18 dBFS にそろえてある） */
export interface EngineLayerGains {
  idle: number
  turbine: number
  burner: number
}

/** タービンの再生の速さ。スロットル 0 で 0.85 倍、1 で 1.15 倍（音の高さが上がる） */
export const TURBINE_RATE_IDLE = 0.85
export const TURBINE_RATE_FULL = 1.15
/** 点火の音を鳴らしたあと、次に鳴らせるまでの秒 */
export const BURNER_LIGHT_COOLDOWN = 1

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** スロットル 0..1 から 3 層の大きさを出す */
export function engineLayerGains(throttle: number, out: EngineLayerGains = { idle: 0, turbine: 0, burner: 0 }): EngineLayerGains {
  const t = Math.min(1, Math.max(0, throttle))
  // 最初は idle 0.55・turbine 0.55 の幅で、0.2 から 0.7 へ上げても大きさが 0.05 dB しか上がらなかった
  // （アイドルが下がるぶんとタービンが上がるぶんが打ち消し合う）。幅を 0.45 と 0.8 にした
  out.idle = 0.1 + 0.45 * (1 - smoothstep(0.1, 0.7, t))
  out.turbine = 0.15 + 0.8 * smoothstep(0, AUGMENTATION_THROTTLE, t)
  out.burner = 0.8 * smoothstep(AUGMENTATION_THROTTLE, 1, t)
  return out
}

/** スロットル 0..1 からタービンの再生の速さを出す */
export function turbineRate(throttle: number): number {
  const t = Math.min(1, Math.max(0, throttle))
  return TURBINE_RATE_IDLE + (TURBINE_RATE_FULL - TURBINE_RATE_IDLE) * t
}

/**
 * 点火の音を鳴らすか。前のスロットルが 0.85 未満で今が 0.85 以上、かつ前に鳴らしてから
 * `BURNER_LIGHT_COOLDOWN` 秒たっていれば鳴らす
 */
export function shouldLightBurner(previous: number, current: number, now: number, lastLitAt: number): boolean {
  return previous < AUGMENTATION_THROTTLE && current >= AUGMENTATION_THROTTLE && now - lastLitAt >= BURNER_LIGHT_COOLDOWN
}
