import type { Flyer } from '../ai/steering'
import type { Vec3 } from '../vec3'
import type { CarrierPose } from '../deckContact'
import { createHoldPilot } from './hold'
import { createApproachPilot } from './approach'

/**
 * 台本の操縦役（Phase 9 の段 9）。
 *
 * **操縦軸（ピッチ・ロール・ヨー）とスロットルは操縦役が決め、ボタンはキーフレームが決める。**
 * 操縦役のある台本では、キーフレームに操縦軸とスロットルを書かない（`tests/replay/scripts.test.ts`
 * が落とす）。どちらが効いているか迷わないため（ユーザーの判断、2026-10-14）。
 *
 * 差し込むのは `ReplayPlayer.at` の 1 か所で、テスト（`runScript`）とキャプチャ（`main.ts`）が同じ
 * `advanceScript` を通る。**ライブ（キーボードで遊ぶ画面）には効かせない。**
 *
 * 敵の AI（`ai/fighter.ts`）とは別物にする。部品（`ai/steering.ts`）だけを共有する。テストの中の
 * 操縦役（`dogfight.test.ts` の `autoPilot`、`mission.test.ts` の `missionPilot`）は、記録した
 * 数値を動かさないよう移さない
 */

/** 操縦役が決める入力。`InputState` のうち操縦軸とスロットル */
export interface PilotAxes {
  pitch: number
  roll: number
  yaw: number
  throttle: number
}

/** 操縦役が決める入力の名前。キーフレームに書いてはいけない */
export const PILOT_AXES = ['pitch', 'roll', 'yaw', 'throttle'] as const satisfies readonly (keyof PilotAxes)[]

/** 操縦される側。`Aircraft` が構造的に満たす */
export interface PilotFlyer extends Flyer {
  /** 実効スロットル 0..1 */
  readonly throttle: number
  /** 世界の位置 m */
  readonly position: Vec3
  /** 迎角 rad */
  readonly angleOfAttack: number
  /** 甲板の上を車輪で走っているか（段 7） */
  readonly onDeck: boolean
  /** 脚とフラップの位置 0..1（段 5、フラップは脚と一緒に動く） */
  readonly gearPosition: number
}

export interface Pilot {
  /** 1 ステップぶんの入力を `out` に書く。ステップごとに 1 回、順に呼ぶ */
  fly(flyer: PilotFlyer, out: PilotAxes): void
}

/**
 * 台本に書く操縦役の指定。数値だけの形にして台本を宣言的に保つ。
 *
 * - `hold`: 翼を水平にして上昇角 0 を保ち、速さ `speed` m/s を保つ（`hold.ts`、段 9）
 * - `approach`: 空母へ進入角 `glide` rad で降りる（`approach.ts`、段 10）。台本に `carrier` が要る
 */
export type PilotSpec =
  | { readonly kind: 'hold'; readonly speed: number }
  | { readonly kind: 'approach'; readonly glide: number }

/** 操縦役が読む台本の情報 */
export interface PilotContext {
  /** 空母の配置。台本に無ければ undefined */
  readonly carrier?: CarrierPose
}

/** 指定から操縦役を作る。**台本の再生ごとに新しく作る**（操縦役は状態を持つ） */
export function createPilot(spec: PilotSpec, fixedDt: number, context: PilotContext = {}): Pilot {
  switch (spec.kind) {
    case 'hold':
      return createHoldPilot(spec.speed, fixedDt)
    case 'approach':
      if (context.carrier === undefined) throw new Error('進入の操縦役は、台本に空母が要る')
      return createApproachPilot(context.carrier, spec.glide, fixedDt)
  }
}
