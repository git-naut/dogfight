/** `tools/f18-hinges.mjs` の型。本体は素の JavaScript（node が直接実行する） */

export interface F18Hinge {
  node: string
  /** XML 座標のヒンジの一端 */
  from: number[]
  /** XML 座標のヒンジのもう一端 */
  to: number[]
  /** 最大舵角 度 */
  maxDeg: number
}

export const F18_HINGES: F18Hinge[]
export function xmlToWorld(v: number[]): [number, number, number]
export function xmlToAc(v: number[]): [number, number, number]
