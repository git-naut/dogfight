/**
 * `tools/f18e-parts.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。node が変換なしで実行できる必要が
 * あるため（`npm run assets` から呼ばれる）。テストは TypeScript なので、
 * 型だけここで与える。
 */

export type Vec3 = [number, number, number]

/** モデルの単位を m へ直す倍率。実測 0.2005 */
export declare const SCALE: number

/** 公称寸法 m */
export declare const SPEC: {
  length: number
  span: number
  height: number
  wingArea: number
}

/** `tools/gltf-parts.mjs` が返す生の部品 */
export interface RawPart {
  name: string
  /** 親ノードの名前。Sketchfab の変換はマテリアルごとに子ノードを作る */
  parent: string | null
  mesh: number
  material: number | undefined
  triangles: number
  min: Vec3
  max: Vec3
  center: Vec3
  extent: Vec3
}

/** m 単位に直した部品。同定の条件はこちらを見る */
export interface MetricPart {
  index: number
  name: string
  triangles: number
  /** 前後。**機首が負** */
  x: number
  /** 上下 */
  y: number
  /** 左右 */
  z: number
  absZ: number
  sizeX: number
  sizeY: number
  sizeZ: number
  raw: RawPart
}

export type PartRole = 'aileron' | 'flap' | 'stabilator' | 'rudder'
export type PartSide = 'left' | 'right'

/** 同定できた舵面。親ノード単位でまとめてある */
export interface MatchedPart {
  name: string
  role: PartRole
  side: PartSide
  /** 回すノードの名前（親） */
  node: string
  triangles: number
  primitives: MetricPart[]
  part: MetricPart
}

export interface IdentifyResult {
  parts: MetricPart[]
  matched: MatchedPart[]
  gear: MetricPart[]
  pairs: [number, number][]
  /** m 単位の全体の大きさ */
  size: Vec3
  min: Vec3
  max: Vec3
}

export declare function identifyParts(gltfPath: string): IdentifyResult
