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

  /**
   * 主峰へ向かって海上を走り、海岸を越えたところで引き起こして稜線を跨ぐ。
   *
   * スポーンは必ず原点（`replay.ts` の `spawnFromSpec`）で、機首は -Z。
   * 主峰は (1500, -11000) にあるので、まっすぐ飛べば正面に見えてくる。
   * 海岸までおよそ 4 km、山頂までおよそ 11 km。地形の撮影に使う。
   */
  'island-run': {
    name: 'island-run',
    seed: 20260816,
    spawn: { altitude: 800, speed: 320 },
    keyframes: [
      { frame: 0, input: { throttle: 1 } },
      { frame: 14 * SEC, input: { throttle: 1, pitch: 0.32 } },
      // 引いたままだと上昇が止まらない。押し戻して稜線の上で水平に戻す
      { frame: 20 * SEC, input: { throttle: 1, pitch: -0.2 } },
      { frame: 23 * SEC, input: { throttle: 1, pitch: 0 } },
    ],
  },
  /**
   * 急上昇して舵を戻す。翼端渦の長さを見るための台本。
   *
   * 渦は揚力係数が高いあいだだけ生まれる。引き起こしのあいだに濃い区間が
   * でき、舵を戻すとそこで生成が止まる。その区間が後方へ遠ざかっていく
   * ようすを撮る。**引き起こしを続ける台本では渦が画面の外へ抜けてしまい、
   * 長さが足りているかを判断できない。**
   */
  'zoom-climb': {
    name: 'zoom-climb',
    seed: 20260816,
    spawn: { altitude: 900, speed: 340 },
    keyframes: [
      { frame: 0, input: { pitch: 0.85, throttle: 1 } },
      // 2 秒引いて機首を起こしたら中立へ戻す。以降は惰性で上昇する
      { frame: 2 * SEC, input: { pitch: 0.02, throttle: 1 } },
    ],
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
