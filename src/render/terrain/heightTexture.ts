import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
} from 'three'
import type { Terrain } from '../../sim/terrain'

/**
 * sim が焼いた高さ場を GPU へ上げる。
 *
 * 高さは頂点シェーダが双三次で引くので、フィルタは最近傍にする。線形に
 * すると、双三次のタップがハードウェアの線形補間と二重に掛かって
 * sim 側の heightAt とずれる。ずれると「見えている山と当たる山が違う」
 * ことになり、地形を sim に持たせた意味がなくなる。
 *
 * `RedFormat` + `FloatType` + `NearestFilter` は WebGL2 の中核機能で、
 * 浮動小数点テクスチャの線形フィルタ拡張には依存しない。
 */
export function createHeightTexture(terrain: Terrain): DataTexture {
  const texture = new DataTexture(
    terrain.heights,
    terrain.size,
    terrain.size,
    RedFormat,
    FloatType,
  )
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/**
 * 法線を焼いてテクスチャにする。
 *
 * フラグメントで求めない。双三次を 4 回引くと 1 画素あたり 64 タップになる。
 * 焼いておけば 1 タップで済み、線形フィルタが滑らかにしてくれる。
 *
 * 焼くときは格子の中央差分を使う。双三次の勾配とは厳密には違うが、
 * 48 m 刻みの法線を線形で引くぶんには差が出ない。近距離の細かさは
 * シェーダ側の法線の摂動で足す。
 */
export function createNormalTexture(terrain: Terrain): DataTexture {
  const size = terrain.size
  const heights = terrain.heights
  const texel = terrain.texel
  const data = new Uint8Array(size * size * 4)

  for (let iz = 0; iz < size; iz++) {
    const zm = iz > 0 ? iz - 1 : 0
    const zp = iz < size - 1 ? iz + 1 : size - 1
    for (let ix = 0; ix < size; ix++) {
      const xm = ix > 0 ? ix - 1 : 0
      const xp = ix < size - 1 ? ix + 1 : size - 1

      const dx = heights[iz * size + xp]! - heights[iz * size + xm]!
      const dz = heights[zp * size + ix]! - heights[zm * size + ix]!
      // 縁では片側差分になるので、実際の刻みで割る
      const spanX = (xp - xm) * texel
      const spanZ = (zp - zm) * texel

      // 勾配 (dh/dx, dh/dz) の面の法線は (-dh/dx, 1, -dh/dz)
      let nx = -dx / spanX
      const ny = 1
      let nz = -dz / spanZ
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx /= length
      nz /= length

      const o = (iz * size + ix) * 4
      data[o] = Math.round((nx * 0.5 + 0.5) * 255)
      data[o + 1] = Math.round((ny / length * 0.5 + 0.5) * 255)
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      data[o + 3] = 255
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
