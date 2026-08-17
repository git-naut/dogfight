import { GLSL3, Mesh, PlaneGeometry, ShaderMaterial } from 'three'
import waterVert from './shaders/water.vert?raw'
import waterFrag from './shaders/water.frag?raw'
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
): Water {
  const geometry = new PlaneGeometry(WATER_EXTENT, WATER_EXTENT)
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: waterVert,
    fragmentShader: waterFrag,
    uniforms: {
      ...uniforms,
      waveTime: { value: 0 },
      waterSpecular: { value: quality.waterSpecular },
    },
  })

  const mesh = new Mesh(geometry, material)
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
      material.uniforms['waveTime']!.value = seconds
    },

    setQuality(next) {
      material.uniforms['waterSpecular']!.value = next.waterSpecular
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
