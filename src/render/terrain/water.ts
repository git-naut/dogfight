import { type Material, Mesh, PlaneGeometry } from 'three'
import type { QualitySettings } from '../quality'
import type { TerrainSharedUniforms } from './terrainMesh'

/**
 * 海面。
 *
 * 高度 0 の平らな板をカメラの XZ に追従させる。地形は 48 km 四方しか
 * 無いので、その外はここが水平線まで覆う。
 */

/**
 * 板の一辺 m。
 *
 * カメラの far は 200 km。高度 2 km からの水平線は 160 km 先なので、
 * 300 km あれば追従させても縁が視界に入らない。
 */
const WATER_EXTENT = 300_000

/**
 * 海面の材質。
 *
 * 作るのは `nodeMaterials.ts`（`NodeMaterial`）。段 S1 で GLSL 版の材質を
 * 捨てたので、呼ぶ側が必ず作り手を渡す。板もカメラ追従も材質に依らない
 */
export interface WaterMaterial {
  readonly material: Material
  /** 波の位相。sim のフレーム番号から導いた秒を渡す */
  setWaveTime(seconds: number): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

export type WaterMaterialFactory = (
  uniforms: TerrainSharedUniforms,
  quality: QualitySettings,
) => WaterMaterial

export interface Water {
  readonly mesh: Mesh
  /** カメラに追従させる。板は平らなので XZ だけ動かす */
  follow(x: number, z: number): void
  /** 波の位相。sim のフレーム番号から導いた秒を渡す */
  setWaveTime(seconds: number): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

export function createWater(
  quality: QualitySettings,
  uniforms: TerrainSharedUniforms,
  createMaterial: WaterMaterialFactory,
): Water {
  const geometry = new PlaneGeometry(WATER_EXTENT, WATER_EXTENT)
  const material = createMaterial(uniforms, quality)

  const mesh = new Mesh(geometry, material.material)
  mesh.rotation.x = -Math.PI / 2
  // 板は視界を覆うので、視錐台で捨ててはいけない
  mesh.frustumCulled = false

  return {
    mesh,

    follow(x, z) {
      mesh.position.x = x
      mesh.position.z = z
    },

    setWaveTime(seconds) {
      material.setWaveTime(seconds)
    },

    setQuality(next) {
      material.setQuality(next)
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
