import { clamp } from './flightModel'
import type { InputState } from './input'
import { recoverFloor } from './ai/fighter'

/**
 * 操作補助。
 *
 * **`InputState` を作り替えるだけ。**飛行モデルには触らない。G 制限と失速の
 * 回避は機体側が持っている（`applyAoaLimiter` と `gLimitedPitchRate`）ので、
 * 補助は「引きたい量」を書き換えるだけで足りる。AI が `InputState` を作るのと
 * 同じ位置づけ。
 *
 * **sim に置く理由。**`recoverFloor` が `ai/fighter.ts` にあり、`src/input/` は
 * sim を import してよいが逆向きの依存は禁止（`layering.test.ts`）。補助を
 * `src/input/` に置くと AI と同じ式を書き写すことになり、片方だけ直る。
 *
 * 純粋関数にする。状態を持たないので node でテストでき、決定論も保たれる。
 */

/**
 * 操作の型。
 *
 * `expert` は素通し。いまの挙動そのまま。
 * `standard` は 3 つの補助を足す。
 */
export type ControlMode = 'expert' | 'standard'

export const CONTROL_MODES: readonly ControlMode[] = ['expert', 'standard'] as const

export function isControlMode(value: string): value is ControlMode {
  return value === 'expert' || value === 'standard'
}

/**
 * ロールの効きに掛ける係数。
 *
 * **1 より小さくすると穏やかになる。**フルロールが 0.50 秒で 90 度回るのは
 * 速すぎて、慣れないと姿勢を見失う（`docs/weapons.md` の手ごたえの表）。
 */
const STANDARD_ROLL_GAIN = 0.7

/**
 * 自動水平化の強さ。バンク 1 rad あたりのロール指令。
 *
 * ロール入力が無いときだけ効く。**入力中に効かせると、意図した旋回を
 * 押し戻して戦えない。**
 */
const LEVEL_GAIN = 1.2

/** 自動水平化を始めるバンク rad。これ以下は放っておく */
const LEVEL_DEADZONE = 0.05

/**
 * 地面を避け始める余裕の倍率。
 *
 * `recoverFloor` は AI が立て直しに入る高度で、そこから引き起こせば間に合う
 * 値。補助はもう少し早く効かせる。**遅いと「気づいたら手遅れ」になる。**
 */
const FLOOR_MARGIN = 1.3

/** 補助が見る自機の状態 */
export interface AssistView {
  /** バンク rad。右が正 */
  readonly bank: number
  /** 対地高度 m */
  readonly agl: number
  /** 対気速度 m/s */
  readonly speed: number
  /** 上昇角 rad。降下が負 */
  readonly climbAngle: number
}

/**
 * 補助を掛ける。
 *
 * **`expert` は `input` をそのまま返す。**器を作り直さないので、既存の
 * 呼び出し側は何も変わらない。
 *
 * `standard` は 3 つ足す。
 *
 * | 補助 | 効く条件 | 内容 |
 * |---|---|---|
 * | ロールの抑制 | 常に | 指令に係数を掛ける |
 * | 自動水平化 | ロール入力が無い | バンクを 0 へ戻す |
 * | 地面の回避 | 対地高度が閾値を割った | 水平へ戻してから引く |
 *
 * 地面の回避は**水平へ戻すのが先**。傾いたまま引くと揚力が横を向いて旋回に
 * なり、降下が止まらない。実測で、バンク 82 度のまま `pitch: 1` を入れて
 * 降下率 −172 m/s のまま海面へ突っ込んだ（`tests/sim/mission.test.ts`）。
 */
export function applyAssist(
  input: InputState,
  mode: ControlMode,
  view: AssistView,
): InputState {
  if (mode === 'expert') return input

  let roll = input.roll * STANDARD_ROLL_GAIN
  let pitch = input.pitch

  // 自動水平化。ロール入力が無いときだけ
  if (input.roll === 0 && Math.abs(view.bank) > LEVEL_DEADZONE) {
    roll = clamp(-view.bank * LEVEL_GAIN, -1, 1)
  }

  // 地面の回避。**水平へ戻すのが先**
  const floor = recoverFloor(view.speed, view.climbAngle, view.bank) * FLOOR_MARGIN
  if (view.agl < floor) {
    roll = clamp(-view.bank * LEVEL_GAIN, -1, 1)
    // 水平に近づくまでは強く引かない。旋回で沈むのを防ぐ
    pitch = Math.abs(view.bank) < 0.5 ? 1 : 0.2
  }

  input.roll = roll
  input.pitch = pitch
  return input
}
