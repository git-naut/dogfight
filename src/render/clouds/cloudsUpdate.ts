import type { Vector2, Vector3 } from 'three'

/**
 * 雲の描画へ毎フレーム渡す入力。
 *
 * 段 S1 で GLSL 経路の `cloudsPass.ts` から移した。純粋な計算の `geometry.ts` を
 * three に依存させないため、three の型を使うこれだけを別のファイルに置く。
 */
export interface CloudsUpdate {
  /** sim のフレーム番号から導いた秒。実時間を渡さないこと */
  cloudTime: number
  sunDirection: Vector3
  sunColor: Vector3
  ambientColor: Vector3
  coverage: number
  /** 雲影マップの中心。自機の真下あたりに置く */
  shadowCenter: Vector2
  /** 雲影を焼くか。プリセットで切る */
  groundShadow: boolean
}
