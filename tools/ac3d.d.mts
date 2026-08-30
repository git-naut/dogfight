/**
 * `tools/ac3d.mjs` の型。
 *
 * 本体は素の JavaScript で書いてある。node が変換なしで実行できる必要が
 * あるため（`npm run assets` から呼ばれる）。テストは TypeScript なので、
 * 型だけここで与える。
 */

export type Vec3 = [number, number, number]

export interface Ac3dMaterial {
  name: string
  rgb: number[]
  amb: number[]
  emis: number[]
  spec: number[]
  shi: number
  trans: number
}

export interface Ac3dSurface {
  flags: number
  mat: number
  /** [頂点番号, u, v] */
  refs: [number, number, number][]
}

export interface Ac3dNode {
  type: string
  name: string
  texture: string | null
  loc: number[]
  /** 稜線とみなす角度 度。書かれていなければ null */
  crease: number | null
  /** テクスチャの繰り返し。UV に掛ける */
  texrep: number[]
  /** テクスチャのずらし。UV に足す */
  texoff: number[]
  vertices: number[][]
  surfaces: Ac3dSurface[]
  kids: Ac3dNode[]
}

export interface Ac3dPart {
  name: string
  texture: string | null
  crease: number | null
  texrep: number[]
  texoff: number[]
  vertices: number[][]
  surfaces: Ac3dSurface[]
}

export interface Ac3dStats {
  objects: number
  vertices: number
  triangles: number
  surfaces: number
  textures: string[]
}

export interface Ac3dBounds {
  min: number[]
  max: number[]
  size: number[]
}

export const SURF_SMOOTH: number
export const SURF_TWO_SIDED: number

export function parseAc3d(text: string): {
  materials: Ac3dMaterial[]
  root: Ac3dNode
}
export function toWorld(v: number[]): Vec3
export function flatten(root: Ac3dNode): Ac3dPart[]
export function stats(root: Ac3dNode): Ac3dStats
export function bounds(parts: Ac3dPart[]): Ac3dBounds
