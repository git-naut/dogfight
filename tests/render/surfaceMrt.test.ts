import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { float } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { getQuality } from '@render/quality'
import {
  createNodeSurfaceState,
  createTerrainNodeMaterial,
  createWaterNodeMaterial,
} from '@render/terrain/nodeMaterials'

/**
 * 地表と海面の材質が MRT を受けられること（段 27a）。
 *
 * **`fragmentNode` を持つ材質には three が MRT を当てない**（`NodeMaterial.setup`
 * の else の枝）。場面のパスが法線も書き出すと、1 本しか書かない材質は描画の
 * 準備に失敗して消える。実測で基準画像 42 枚がすべて動き、コンソールに
 * `Color target has no corresponding fragment stage output` が出た。
 * 地表と海面は `outputNode` に差す
 */
type Slots = { fragmentNode: unknown; outputNode: unknown }

function state() {
  return createNodeSurfaceState(
    {
      heightMap: new THREE.DataTexture(),
      terrainNormalMap: new THREE.DataTexture(),
      cloudShadowMap: new THREE.DataTexture(),
      extent: 1000,
      texels: 16,
      cloudShadowExtent: 1000,
    },
    getQuality('high'),
  )
}

const shade = float(1) as unknown as Node<'float'>

describe('地表と海面は MRT を受けられる', () => {
  it('地表は outputNode に差し、fragmentNode を使わない', () => {
    const m = createTerrainNodeMaterial(state(), shade).material as unknown as Slots
    expect(m.fragmentNode).toBeNull()
    expect(m.outputNode).not.toBeNull()
  })

  it('海面も同じ', () => {
    const m = createWaterNodeMaterial(state(), shade).material as unknown as Slots
    expect(m.fragmentNode).toBeNull()
    expect(m.outputNode).not.toBeNull()
  })
})
