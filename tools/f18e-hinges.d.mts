/**
 * `tools/f18e-hinges.mjs` の型。
 *
 * 本体は素の JavaScript。理由は `tools/f18e-parts.d.mts` と同じ。
 */

import type { Vec3, PartRole, PartSide } from './f18e-parts.d.mts'

/** 舵面が読む指令の種類。`src/render/aircraft/model.ts` の `SurfaceChannel` と揃える */
export type SurfaceChannel = 'elevator' | 'aileron' | 'rudder'

export declare const MAX_DEG: Record<PartRole, number>
export declare const SIGN: Record<PartRole, number>

export interface F18eHinge {
  /** 差し込むノードの名前。`AileronLeft` など */
  node: string
  /** 元の glTF のノード名。`Main2` など */
  sourceNode: string
  role: PartRole
  side: PartSide
  /** 軸の 2 点。**モデルの元の軸**（機首 −X、上 +Y、Z 翼幅）で m 単位 */
  from: Vec3
  to: Vec3
  maxDeg: number
  channel: SurfaceChannel
  sign: number
}

export declare function buildHinges(gltfPath: string): F18eHinge[]
