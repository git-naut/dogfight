import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShadowInputs } from '../../src/render/clouds/shadowInputs'

/**
 * GLSL 経路の最後の出力（`tests/e2e/node-reference.json`）を読む口。
 *
 * 段 S1 で GLSL 退避路を捨てる。node-path.spec の突き合わせのうち、CPU に参照実装が
 * 無いもの（雲のノイズ・気象マップ・雲影・マーチ、地表と海面の色、画素数の比）は、
 * **GLSL の出力を写した記録と TSL を比べる。**記録は `tools/node-reference.mjs` が
 * 書き、手では直さない。
 *
 * 記録そのものの健全さ（枝を通っているか、階調を使い切っているか）は
 * `tests/render/nodeReference.test.ts` が見る。比べる相手が空の絵なら、何を
 * 写し間違えても一致してしまう。
 *
 * vitest と Playwright の両方が読むので、three にも DOM にも依存しない。
 * 道具はどちらもリポジトリの根から走る。
 */

interface Raw {
  project: string
  sunElevation: number
  sunRadiance: [number, number, number]
  skyRadiance: [number, number, number]
  noiseSlice: string
  weatherSlice: string
  march: {
    samples: { total: number; max: number; hit: number }
    exhausted: number
    tiles: number[]
    resolveUv: string
    resolveChanged: number
  }
  shadow: { coverage: number; inputs: ShadowInputs; bins: number[]; tiles: number[] }
  sprite: { soft: string; core: string }
  tone: string
  overlay: { composite: string; marker: string }
  surface: {
    terrain: string
    terrainBranches: string
    water: string[]
    waterBranches: string[]
  }
  translucent: { explosion: number; vortex: number }
}

const bytes = (base64: string): number[] => [...Buffer.from(base64, 'base64')]

function load() {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/e2e/node-reference.json'), 'utf8'),
  ) as Raw
  return {
    /** 記録を撮った project。起動引数が違えば比べられない */
    project: raw.project,
    /** `?capture=1&frame=0` の太陽高度 rad */
    sunElevation: raw.sunElevation,
    /** 同じ構図の太陽と空の放射輝度（GLSL 版 takram が EXR から出す値） */
    sunRadiance: raw.sunRadiance,
    skyRadiance: raw.skyRadiance,
    noiseSlice: bytes(raw.noiseSlice),
    weatherSlice: bytes(raw.weatherSlice),
    march: { ...raw.march, resolveUv: bytes(raw.march.resolveUv) },
    shadow: raw.shadow,
    sprite: { soft: bytes(raw.sprite.soft), core: bytes(raw.sprite.core) },
    tone: bytes(raw.tone),
    overlay: { composite: bytes(raw.overlay.composite), marker: bytes(raw.overlay.marker) },
    surface: {
      terrain: bytes(raw.surface.terrain),
      terrainBranches: bytes(raw.surface.terrainBranches),
      water: raw.surface.water.map(bytes),
      waterBranches: raw.surface.waterBranches.map(bytes),
    },
    /** 空を背にした半透明の物の画素数。ブルームを切り、消したときに動く画素 */
    translucent: raw.translucent,
  }
}

export type NodeReference = ReturnType<typeof load>

export const NODE_REFERENCE: NodeReference = load()
