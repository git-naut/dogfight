/**
 * 1ステップ分の操縦入力。
 *
 * 生のキーイベントではなく正規化した値で受け取る。こうしておくと
 * キーボードでもゲームパッドでもリプレイスクリプトでも同じ型で流し込める。
 * sim 層がブラウザの入力 API を知らずに済む。
 */
export interface InputState {
  /** ピッチ。+1 が機首上げ、-1 が機首下げ */
  pitch: number
  /** ロール。+1 が右バンク、-1 が左バンク */
  roll: number
  /** ヨー。+1 が右、-1 が左 */
  yaw: number
  /** スロットルの目標値。0 が最小、1 が最大（実効値は機体側で追従する） */
  throttle: number
  fireGun: boolean
  fireMissile: boolean
  /** フレアの投下。押しっぱなしでは 1 回しか撒かない */
  deployFlare: boolean
  /**
   * 降着装置の出し入れ（Phase 9 の段 5）。押した瞬間だけ効き、押しっぱなしでは 1 回しか
   * 切り替えない。押した瞬間の判定は `World` が持つ（甲板の上では受け付けないため）
   */
  gearToggle: boolean
  /**
   * 着艦フックの上げ下ろし（Phase 9 の段 8）。押した瞬間だけ効く。押した瞬間の判定は
   * `World` が持つ（射出中は受け付けないため）
   */
  hookToggle: boolean
  /**
   * ハイGターン（Phase 10 の段 B6）。押しているあいだ、引いたときの旋回をきつくし、速さを失う。
   * 録画は加減速の 2 つのボタンの同時押し、キーボードは Shift と Ctrl の同時押し
   */
  highG: boolean
  /**
   * オートパイロット（段 B6）。押した瞬間に入り、ロールかピッチを入れると切れる。押した瞬間の判定は
   * `World` が持つ。録画はヨーの 2 つのボタンの同時押し、キーボードは Q と E の同時押し
   */
  autopilot: boolean
  /** ターゲット切替（段 B6）。押した瞬間だけ効く。判定は `Combat` が持つ。キーボードは T */
  switchTarget: boolean
}

export function neutralInput(): InputState {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0.5,
    fireGun: false,
    fireMissile: false,
    deployFlare: false,
    gearToggle: false,
    hookToggle: false,
    highG: false,
    autopilot: false,
    switchTarget: false,
  }
}

/** 部分指定から InputState を作る。テストとリプレイスクリプトで使う。 */
export function makeInput(partial: Partial<InputState> = {}): InputState {
  return { ...neutralInput(), ...partial }
}
