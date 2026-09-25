import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createScenePass } from '@render/pipeline/nodeOutput'

/**
 * 場面のパスの MRT（段 27a）。
 *
 * **書き出す面が増えると帯域を払う。**切っているあいだは `setMRT` を呼ばない
 * こと、入れたときは SSR が読む `normal` の出力ができることを縛る。
 * 絵が変わらないことは `npm run exact` で確かめる（`?scenemrt=1`）
 */
type MrtLike = { outputNodes: Record<string, unknown> } | null

function passOf(normals: boolean | undefined, emissive?: boolean) {
  const handle = createScenePass(new THREE.Scene(), new THREE.PerspectiveCamera(), {
    ...(normals === undefined ? {} : { normals }),
    ...(emissive === undefined ? {} : { emissive }),
  })
  const mrt = (handle.scenePass.getMRT?.() ?? null) as MrtLike
  return { handle, mrt }
}

describe('場面のパスの法線の書き出し', () => {
  it('既定では MRT を持たず、法線のノードも無い', () => {
    const { handle, mrt } = passOf(undefined)
    expect(mrt).toBeNull()
    expect(handle.normalNode).toBeNull()
  })

  it('切っているときも同じ', () => {
    const { handle, mrt } = passOf(false)
    expect(mrt).toBeNull()
    expect(handle.normalNode).toBeNull()
  })

  it('入れると output と normal の 2 本を書き出す', () => {
    const { handle, mrt } = passOf(true)
    expect(Object.keys(mrt!.outputNodes).sort()).toEqual(['normal', 'output'])
    expect(handle.normalNode).not.toBeNull()
  })

  it('発光体だけを入れると output と emissive の 2 本', () => {
    const { handle, mrt } = passOf(undefined, true)
    expect(Object.keys(mrt!.outputNodes).sort()).toEqual(['emissive', 'output'])
    expect(handle.emissiveNode).not.toBeNull()
    expect(handle.normalNode).toBeNull()
  })

  it('両方入れると 3 本', () => {
    const { handle, mrt } = passOf(true, true)
    expect(Object.keys(mrt!.outputNodes).sort()).toEqual(['emissive', 'normal', 'output'])
    expect(handle.emissiveNode).not.toBeNull()
    expect(handle.normalNode).not.toBeNull()
  })

  it('深度のテクスチャは MRT の有無で変わらない', () => {
    // 雲の材質が読む深度。MRT を入れて深度の口が消えたら雲が壊れる
    expect(passOf(true).handle.depthTexture).toBeInstanceOf(THREE.DepthTexture)
    expect(passOf(false).handle.depthTexture).toBeInstanceOf(THREE.DepthTexture)
  })
})
