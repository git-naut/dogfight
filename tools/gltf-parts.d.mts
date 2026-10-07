/**
 * `tools/gltf-parts.mjs` の型（Phase 9 の段 2 で、テストから直接読むために足した）。
 * 部品の型は `tools/f18e-parts.d.mts` の `RawPart` と同じ
 */
import type { RawPart, Vec3 } from './f18e-parts.mjs'

export type { RawPart, Vec3 }

/** glTF を読んで、部品ごとの世界座標の外接箱を返す */
export declare function readGltfParts(
  gltfPath: string,
  options?: { vertices?: boolean },
): {
  parts: (RawPart & { vertices?: Vec3[]; indices?: number[] | null })[]
  min: Vec3
  max: Vec3
  size: Vec3
}

/** 左右対称の部品の組を探す */
export declare function findMirrorPairs(
  parts: readonly RawPart[],
  axis?: number,
  tolerance?: number,
): [RawPart, RawPart][]
