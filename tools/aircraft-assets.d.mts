/**
 * `tools/aircraft-assets.mjs` の型。
 *
 * 本体は素の JavaScript。node が変換なしで実行できる必要がある
 * （`npm run assets` から呼ばれる）。テストは TypeScript なので型だけここで
 * 与える。`ac3d.d.mts` と同じ作法。
 */

export const DEFAULT_GEAR_PATTERN: RegExp

export interface AssetHinge {
  node: string
  objects: string[]
  from: number[]
  to: number[]
  maxDeg: number
  channel: string
  sign: number
}

export interface AssetDefinition {
  id: string
  source: string
  textureDir: string
  textures: Record<string, string>
  textureHint: string
  hinges: AssetHinge[]
  xmlToWorld: (v: number[]) => [number, number, number]
  cockpitTexture?: string
  extraNodes?: string[]
  gearPattern?: RegExp
  hidden?: string[]
  notGear?: string[]
  /** 丸ごと落とすテクスチャ。名前ではなくテクスチャで指定する */
  dropTextures?: RegExp[]
  copyright: string
}

export const AIRCRAFT_ASSETS: AssetDefinition[]
export function assetById(id: string): AssetDefinition
