/** `tools/f18-hinges.mjs` の型。本体は素の JavaScript（node が直接実行する） */

/**
 * 舵面のヒンジ 1 本。
 *
 * 軸の与え方は原典に合わせて 2 通り。2 点で書いてあるものは `to`、中心と
 * 方向で書いてあるものは `axis`。
 */
export interface FgHinge {
  /** 出力する glb のノード名。描画側はこの名前で引く */
  node: string
  /** まとめる .ac のオブジェクト名。1 枚の舵面が複数に割れている機体がある */
  objects: string[]
  /** XML 座標のヒンジ上の 1 点。ノードの原点になる */
  from: number[]
  /** XML 座標のヒンジ上のもう 1 点 */
  to?: number[]
  /** XML 座標の軸の方向 */
  axis?: number[]
  /** 最大舵角 度 */
  maxDeg: number
  /** どの指令で動くか */
  channel: 'elevator' | 'aileron' | 'rudder'
  /** 舵の向き。指令に掛ける符号 */
  sign: number
}

/** 以前の名前。呼び出し側の互換のため残す */
export type F18Hinge = FgHinge

export const F18_HINGES: FgHinge[]
export function xmlToWorld(v: number[]): [number, number, number]
export function xmlToAc(v: number[]): [number, number, number]
