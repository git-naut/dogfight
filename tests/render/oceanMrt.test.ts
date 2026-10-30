import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * 海面の材質が MRT を受けられること（段 27a の教訓、段 S4b で地形の検査から移した）。
 *
 * **`fragmentNode` を持つ材質には three が MRT を当てない**（`NodeMaterial.setup`
 * の else の枝）。場面のパスが法線も書き出すと、1 本しか書かない材質は描画の
 * 準備に失敗して消える。実測で基準画像 42 枚がすべて動き、コンソールに
 * `Color target has no corresponding fragment stage output` が出た。
 *
 * 地形の材質は組み立てて確かめていたが、海面はレンダラが無いと組めない。本文を読んで、
 * 海面と外側の板の 2 つの材質が `outputNode` に差し、`fragmentNode` を使わないことを見る
 */
const source = readFileSync(
  fileURLToPath(new URL('../../src/render/ocean/oceanSurface.ts', import.meta.url)),
  'utf8',
)
/** コメントを外した本文。**注記に名前が出るだけで落ちる形にしない** */
const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('海面は MRT を受けられる', () => {
  it('fragmentNode を使わない', () => {
    expect(body.includes('fragmentNode')).toBe(false)
  })

  it('海面と外側の板の 2 つの材質が outputNode に差す', () => {
    expect(body.match(/new MeshBasicNodeMaterial\(\)/g)?.length).toBe(2)
    expect(body).toContain('(material as unknown as { outputNode: unknown }).outputNode =')
    expect(body).toContain('(plateMaterial as unknown as { outputNode: unknown }).outputNode =')
  })
})
