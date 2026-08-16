import type { ReplayScript } from './replay'

/**
 * 名前付きの入力スクリプト。
 *
 * リプレイ検証とスクリーンショット回帰の両方から参照する。同じスクリプトを
 * 使うので、テストが見ている状態と撮った絵が食い違わない。
 *
 * 1 秒は 120 フレーム。
 */
const SEC = 120

export const SCRIPTS = {
  /** 何もせず水平飛行を続ける。飛行モデルの基準線。 */
  level: {
    name: 'level',
    seed: 20260816,
    spawn: { altitude: 2000, speed: 250 },
    keyframes: [],
  },

  /** 左へバンクして旋回する。 */
  'bank-left': {
    name: 'bank-left',
    seed: 20260816,
    spawn: { altitude: 2500, speed: 260 },
    keyframes: [
      { frame: 0, input: { roll: -1 } },
      // 45 度あたりまで倒したらロールを止めて引く
      { frame: Math.round(0.28 * SEC), input: { roll: 0, pitch: 0.4 } },
    ],
  },

  /** 機首を上げて上昇する。 */
  'pull-up': {
    name: 'pull-up',
    seed: 20260816,
    spawn: { altitude: 1200, speed: 300 },
    keyframes: [{ frame: 0, input: { pitch: 0.8, throttle: 1 } }],
  },

  /** 低空を高速で通過する。高度感の確認用。 */
  'low-pass': {
    name: 'low-pass',
    seed: 20260816,
    spawn: { altitude: 220, speed: 320 },
    keyframes: [{ frame: 0, input: { throttle: 1 } }],
  },
} as const satisfies Record<string, ReplayScript>

export type ScriptName = keyof typeof SCRIPTS

export const SCRIPT_NAMES = Object.keys(SCRIPTS) as ScriptName[]

export function isScriptName(value: string): value is ScriptName {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, value)
}

export function getScript(name: string): ReplayScript {
  return isScriptName(name) ? SCRIPTS[name] : SCRIPTS.level
}
