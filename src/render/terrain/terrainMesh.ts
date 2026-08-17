import {
  BufferAttribute,
  DynamicDrawUsage,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderChunk,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from 'three'
import terrainVert from './shaders/terrain.vert?raw'
import terrainFrag from './shaders/terrain.frag?raw'
import heightfieldGlsl from './shaders/heightfield.glsl?raw'
import { selectPatches, type SelectOptions, type TerrainPatch } from './layout'
import type { QualitySettings } from '../quality'
import type { Terrain } from '../../sim/terrain'

/**
 * 起伏地形。
 *
 * 四分木で選んだパッチを、0..1 の正方格子 1 枚のインスタンスとして並べる。
 * ジオメトリは 1 つ、ドローコールも 1 回。高さは頂点シェーダが高さ場から
 * 双三次で引くので、CPU 側は原点と大きさを渡すだけ。
 */

// 高さ場のサンプルと雲影を地形と海面で共有する。three の include 解決に載せる
;(ShaderChunk as unknown as Record<string, string>)['terrain_heightfield'] = heightfieldGlsl

/**
 * インスタンスの上限。
 *
 * 実測でパッチ枚数は low 61 / medium 115 / high 220 / ultra 256。
 * 倍率を上げると増えるので余裕を持たせる。
 */
const MAX_PATCHES = 512

/** 地形と海面で共有するユニフォーム。毎フレーム同じ値を 2 回書かないため */
export interface TerrainSharedUniforms {
  heightMap: { value: Texture | null }
  terrainNormalMap: { value: Texture | null }
  terrainExtent: { value: number }
  terrainTexels: { value: number }
  cloudShadowMap: { value: Texture | null }
  cloudShadowCenter: { value: Vector2 }
  cloudShadowExtent: { value: number }
  cloudShadowEnabled: { value: number }
  sunDirectionWorld: { value: Vector3 }
  sunRadiance: { value: Vector3 }
  skyRadiance: { value: Vector3 }
}

export function createTerrainUniforms(
  terrain: Terrain,
  cloudShadowExtent: number,
): TerrainSharedUniforms {
  return {
    heightMap: { value: null },
    terrainNormalMap: { value: null },
    terrainExtent: { value: terrain.extent },
    terrainTexels: { value: terrain.size },
    cloudShadowMap: { value: null },
    cloudShadowCenter: { value: new Vector2() },
    cloudShadowExtent: { value: cloudShadowExtent },
    cloudShadowEnabled: { value: 1 },
    sunDirectionWorld: { value: new Vector3(0, 1, 0) },
    sunRadiance: { value: new Vector3(1, 1, 1) },
    skyRadiance: { value: new Vector3(0.1, 0.12, 0.15) },
  }
}

export interface TerrainMesh {
  readonly mesh: Mesh
  /** 描いているパッチ枚数。デバッグ表示と予算の確認に使う */
  readonly patchCount: number
  readonly triangleCount: number
  /** カメラ位置からパッチを選び直す。毎フレーム呼ぶ */
  update(cameraX: number, cameraZ: number): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

/**
 * 0..1 の正方格子。
 *
 * position.xy が格子座標で、z は使わない。頂点シェーダがパッチの原点と
 * 大きさを掛けてワールド座標にする。
 */
function createUnitGrid(cells: number): {
  position: Float32Array
  index: Uint32Array
} {
  const side = cells + 1
  const position = new Float32Array(side * side * 3)
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const o = (j * side + i) * 3
      position[o] = i / cells
      position[o + 1] = j / cells
      position[o + 2] = 0
    }
  }

  const index = new Uint32Array(cells * cells * 6)
  let k = 0
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * side + i
      const b = a + 1
      const c = a + side
      const d = c + 1
      index[k++] = a
      index[k++] = c
      index[k++] = b
      index[k++] = b
      index[k++] = c
      index[k++] = d
    }
  }

  return { position, index }
}

export function createTerrainMesh(
  terrain: Terrain,
  quality: QualitySettings,
  uniforms: TerrainSharedUniforms,
): TerrainMesh {
  let cells = quality.terrainPatchCells
  let geometry = buildGeometry(cells)

  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: terrainVert,
    fragmentShader: terrainFrag,
    uniforms: {
      ...uniforms,
      detailNormals: { value: quality.terrainDetailNormals },
    },
  })

  const mesh = new Mesh(geometry, material)
  // パッチは定義域を覆うので、メッシュ全体を視錐台で捨ててはいけない
  mesh.frustumCulled = false

  const origins = new Float32Array(MAX_PATCHES * 4)
  const morphs = new Float32Array(MAX_PATCHES * 2)
  const originAttribute = new InstancedBufferAttribute(origins, 4)
  const morphAttribute = new InstancedBufferAttribute(morphs, 2)
  // 毎フレーム書き換えるので動的な用途として宣言する
  originAttribute.setUsage(DynamicDrawUsage)
  morphAttribute.setUsage(DynamicDrawUsage)
  geometry.setAttribute('patchOrigin', originAttribute)
  geometry.setAttribute('patchMorph', morphAttribute)

  const patches: TerrainPatch[] = []
  let options = selectOptions(terrain, quality)
  let patchCount = 0

  function buildGeometry(cellCount: number): InstancedBufferGeometry {
    const grid = createUnitGrid(cellCount)
    const g = new InstancedBufferGeometry()
    g.setAttribute('position', new BufferAttribute(grid.position, 3))
    g.setIndex(new BufferAttribute(grid.index, 1))
    return g
  }

  function upload(): void {
    patchCount = Math.min(patches.length, MAX_PATCHES)
    for (let i = 0; i < patchCount; i++) {
      const patch = patches[i]!
      const o = i * 4
      origins[o] = patch.x
      origins[o + 1] = patch.z
      origins[o + 2] = patch.size
      origins[o + 3] = patch.size / cells
      const m = i * 2
      morphs[m] = patch.morphStart
      morphs[m + 1] = patch.morphEnd
    }
    originAttribute.needsUpdate = true
    morphAttribute.needsUpdate = true
    geometry.instanceCount = patchCount
  }

  return {
    mesh,

    get patchCount() {
      return patchCount
    },

    get triangleCount() {
      return patchCount * cells * cells * 2
    },

    update(cameraX, cameraZ) {
      selectPatches(cameraX, cameraZ, options, patches)
      upload()
    },

    setQuality(next) {
      options = selectOptions(terrain, next)
      material.uniforms['detailNormals']!.value = next.terrainDetailNormals

      const nextCells = next.terrainPatchCells
      if (nextCells === cells) return

      // セル数が変わったら格子を作り直す。インスタンスの属性は移し替える
      cells = nextCells
      const rebuilt = buildGeometry(cells)
      rebuilt.setAttribute('patchOrigin', originAttribute)
      rebuilt.setAttribute('patchMorph', morphAttribute)
      rebuilt.instanceCount = patchCount
      geometry.dispose()
      geometry = rebuilt
      mesh.geometry = rebuilt
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

function selectOptions(terrain: Terrain, quality: QualitySettings): SelectOptions {
  return {
    extent: terrain.extent,
    maxDepth: quality.terrainLodLevels - 1,
    distanceScale: quality.lodDistanceScale,
  }
}
