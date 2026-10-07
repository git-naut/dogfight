/**
 * `tools/f18e-hinges.mjs` の型。
 *
 * 本体は素の JavaScript。理由は `tools/f18e-parts.d.mts` と同じ。
 */

import type { Vec3, PartRole, PartSide } from './f18e-parts.d.mts'

/** 舵面が読む指令の種類。`src/render/aircraft/model.ts` の `SurfaceChannel` と揃える */
export type SurfaceChannel = 'elevator' | 'aileron' | 'rudder'

export declare const MAX_DEG: Record<PartRole, number>
export declare const SURFACE_DEG: Record<PartRole, { up: number; down: number }>
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
  /** 「指令 × 符号」が正のときの上限 deg */
  maxDegPositive: number
  /** 「指令 × 符号」が負のときの上限 deg */
  maxDegNegative: number
  /** 正の回転が後縁を上げるか（ラダーは左右の向き） */
  positiveRaisesTrailingEdge: boolean
  channel: SurfaceChannel
  sign: number
}

export declare function buildHinges(gltfPath: string): F18eHinge[]

/** 端の断面の前縁の鼻の中心 */
export declare function noseCenter(vertices: readonly Vec3[], span: number, end: 'lo' | 'hi'): Vec3

/** 最大舵角まで回したとき、継ぎ目の頂点が固定の部品から離れる距離 m */
export declare function seamDeparture(
  gltfPath: string,
  hinges: readonly F18eHinge[],
): Record<string, { seam: number; max: number; mean: number }>

/** 脚が格納まで回る角度 deg */
export declare const GEAR_RETRACT_DEG: Record<'nose' | 'left' | 'right', number>

export interface F18eGearHinge {
  node: string
  leg: 'nose' | 'left' | 'right'
  sourceNodes: string[]
  /** 付け根。モデルの元の軸で m */
  origin: Vec3
  /** 正の角で畳む向きに回る軸（単位ベクトル） */
  axis: Vec3
  retractDeg: number
}

export declare function buildGearHinges(gltfPath: string): {
  gear: F18eGearHinge[]
  hook: { node: string; sourceNodes: string[]; origin: Vec3; axis: Vec3 }
}
