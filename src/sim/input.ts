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
  }
}

/** 部分指定から InputState を作る。テストとリプレイスクリプトで使う。 */
export function makeInput(partial: Partial<InputState> = {}): InputState {
  return { ...neutralInput(), ...partial }
}
