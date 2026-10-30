import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * GLSL 経路の最後の出力（`tests/e2e/node-reference.json`）を読む口。
 *
 * 段 S1 で GLSL 退避路を捨てた。node-path.spec の突き合わせのうち、CPU に参照実装が
 * 無いもの（画素数の比、太陽と空の放射輝度）は、**GLSL の出力を写した記録と TSL を
 * 比べる。**記録は段 S1 まで `tools/node-reference.mjs` が書いた。手では直さない。
 * 段 S4b で体積の雲（ノイズ・気象マップ・雲影・マーチ）と地形（地表と海面の色）の
 * 記録を、比べる相手ごと消した。
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
  sprite: { soft: string; core: string }
  tone: string
  overlay: { composite: string; marker: string }
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
    sprite: { soft: bytes(raw.sprite.soft), core: bytes(raw.sprite.core) },
    tone: bytes(raw.tone),
    overlay: { composite: bytes(raw.overlay.composite), marker: bytes(raw.overlay.marker) },
    /** 空を背にした半透明の物の画素数。ブルームを切り、消したときに動く画素 */
    translucent: raw.translucent,
  }
}

export type NodeReference = ReturnType<typeof load>

export const NODE_REFERENCE: NodeReference = load()
