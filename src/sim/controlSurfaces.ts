/**
 * 舵面の位置と速さの上限（2026-10-07）。
 *
 * 出典は NASA TM-4786（Iliff ほか, "Extraction of Lateral-Directional Stability and Control
 * Derivatives for the Basic F-18 Aircraft at High Angles of Attack", 1997）の表
 * "F-18 aerodynamic control surface position and rate limits"。配布区分は
 * Unclassified—Unlimited。原文の PDF で確かめた。**A/B 型の F-18 の値**で、E 型の公表値は
 * 見つけていない。E 型も同じ系の飛行制御なので、この値を使う。
 *
 * | 舵面 | 後縁上げ | 後縁下げ | 速さ |
 * |---|---|---|---|
 * | 水平尾翼 | 24 度 | 10.5 度 | 40 度/秒 |
 * | エルロン | 24 度 | 45 度 | 100 度/秒 |
 * | ラダー | 左右 30 度 | | 82 度/秒 |
 *
 * **sim が持つのは −1..1 の位置だけ。**角度へ写すのは描画（`render/aircraft/surfaces.ts`）。
 * ここでは、角度の速さの上限を守るように位置を寄せる。Phase 9 まではこの表が無く、
 * 位置を時定数 0.08 秒で指令へ寄せ、描画が上下とも同じ角度（水平尾翼 24 度、エルロン 30 度）
 * で振っていた。キーを押すと 0.2 秒ほどで最大まで振れ、水平尾翼の付け根の前縁が胴体の
 * 外へ大きく出た（ユーザーの指摘、2026-10-07）
 */

/** 舵面 1 種類の上限 */
export interface SurfaceLimit {
  /** 位置 +1 で振れる角度 deg（水平尾翼は後縁上げ、ラダーは右） */
  readonly positiveDeg: number
  /** 位置 −1 で振れる角度 deg */
  readonly negativeDeg: number
  /** 角度の速さの上限 deg/s */
  readonly rateDegPerSecond: number
}

/**
 * 指令の種類ごとの上限。
 *
 * **エルロンは左右で向きが逆**なので、位置 ±1 のどちらでも、片方が後縁上げ（24 度）、
 * もう片方が後縁下げ（45 度）になる。位置の速さは大きいほう（45 度）で決める。後縁下げの
 * 側がちょうど 100 度/秒で、後縁上げの側は 53 度/秒になる（速さの上限は超えない）
 */
export const SURFACE_LIMITS = {
  elevator: { positiveDeg: 24, negativeDeg: 10.5, rateDegPerSecond: 40 },
  aileron: { positiveDeg: 45, negativeDeg: 45, rateDegPerSecond: 100 },
  rudder: { positiveDeg: 30, negativeDeg: 30, rateDegPerSecond: 82 },
} as const satisfies Record<'elevator' | 'aileron' | 'rudder', SurfaceLimit>

/** エルロンの後縁上げと後縁下げの上限 deg。描画が左右の舵面へ振り分ける */
export const AILERON_TRAILING_EDGE_UP_DEG = 24
export const AILERON_TRAILING_EDGE_DOWN_DEG = 45

/**
 * 位置 `current` を指令 `target` へ、角度の速さの上限を守って 1 ステップ寄せる。
 *
 * 位置の速さは、いまいる側（正か負か）の角度で割って決める。水平尾翼は正の側（後縁上げ
 * 24 度）で 40/24 = 1.67/s、負の側（後縁下げ 10.5 度）で 40/10.5 = 3.81/s。**0 をまたぐ
 * ステップは、またぐ前の側の速さで動く**（1 ステップ 1/120 秒なので、ずれは 0.3 度未満）
 */
export function stepSurface(current: number, target: number, limit: SurfaceLimit, dt: number): number {
  const goal = Math.min(1, Math.max(-1, target))
  const sideDeg = current > 0 || (current === 0 && goal > 0) ? limit.positiveDeg : limit.negativeDeg
  const maxStep = (limit.rateDegPerSecond / sideDeg) * dt
  const delta = goal - current
  if (Math.abs(delta) <= maxStep) return goal
  return current + Math.sign(delta) * maxStep
}
