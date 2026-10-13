/**
 * `tools/f18e-stab-root.mjs` の型。本体は素の JavaScript（`tools/f18e-parts.d.mts` と同じ理由）
 */
type Vec3 = [number, number, number]

export declare const ROOT_MARGIN: number
export declare const ROOT_TOUCH: number
export declare const ROOT_BAND: number

export interface RootPoint {
  x: number
  y: number
  /** 中心線からの横の距離 m */
  z: number
  /** 振れの上限までで測った胴体までの横の距離の最大 m。どの角度でも当たらなければ null */
  gap: number | null
  /** 中心線へ寄せる幅 m */
  shift: number
}

export declare function measureStabRoot(
  gltfPath: string,
  maxDeg: number,
): Record<'left' | 'right', { points: RootPoint[]; hinge: { from: Vec3; to: Vec3 } }>

export declare function extendStabRoot(
  gltfPath: string,
  gltf: unknown,
  binary: Uint8Array,
  maxDeg: number,
): { moved: number; left: number; right: number }

export declare function rootInsideFuselage(
  gltfPath: string,
  maxDeg: number,
): Record<'left' | 'right', Record<string, { inside: number; outside: number }>>
