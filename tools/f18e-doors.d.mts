/**
 * `tools/f18e-doors.mjs` の型。本体は素の JavaScript（`tools/f18e-parts.d.mts` と同じ理由）
 */
type Vec3 = [number, number, number]

export interface DoorDefinition {
  node: string
  leg: 'nose' | 'left' | 'right'
  hideWhenClosed: boolean
  /** 閉じたときの 4 隅。最初の 2 点が蝶番の辺 */
  corners: Vec3[]
}

export declare const DOOR_SHARE: number
export declare const DOOR_OPEN_DEG: number
export declare const DOORS: DoorDefinition[]

export declare function doorHinges(): (DoorDefinition & { origin: Vec3; axis: Vec3 })[]

/** 下から真上へ光線を飛ばし、最初に当たる高さ m。当たらなければ null */
export declare function lowestHit(
  gltfPath: string,
  points: readonly (readonly [number, number])[],
  exclude?: ReadonlySet<string>,
): (number | null)[]
