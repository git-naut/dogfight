import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCarrier } from '@render/carrier'

/**
 * 空母は影を受けるだけで、投げない（段 S4d）。投げ手にすると、偏り 0 の影の地図で甲板が
 * 自分を影にし、機体のまわりに同心円の縞（影のにきび）が出た。実機の catapult-launch で確かめ、
 * 投げ手から外すと縞が消えた
 */

/**
 * 三角形 1 枚の GLB（本物の glb は 8.6 MB あるので読まない）。node には `ProgressEvent` が無く
 * three の `FileLoader` が止まるので、URL からは読まず、`loadAsync` を差し替えてバイト列を渡す
 */
function triangleGlb(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] },
    ],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  }
  let json = JSON.stringify(gltf)
  while (json.length % 4 !== 0) json += ' '
  const jsonBytes = new TextEncoder().encode(json)
  const bin = new Uint8Array(positions.buffer)
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new DataView(new ArrayBuffer(total))
  const bytes = new Uint8Array(out.buffer)
  out.setUint32(0, 0x46546c67, true) // glTF
  out.setUint32(4, 2, true)
  out.setUint32(8, total, true)
  out.setUint32(12, jsonBytes.length, true)
  out.setUint32(16, 0x4e4f534a, true) // JSON
  bytes.set(jsonBytes, 20)
  const binAt = 20 + jsonBytes.length
  out.setUint32(binAt, bin.length, true)
  out.setUint32(binAt + 4, 0x004e4942, true) // BIN
  bytes.set(bin, binAt + 8)
  return out.buffer
}

describe('空母の影', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('どの部品も影を受け、投げない', async () => {
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(function (this: GLTFLoader) {
      return this.parseAsync(triangleGlb(), '')
    })
    const carrier = await loadCarrier('carrier.glb')
    const meshes: THREE.Mesh[] = []
    carrier.object.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o)
    })
    // 部品が 0 なら下の検査は空振りで通る
    expect(meshes.length).toBe(1)
    expect(carrier.triangles).toBe(1)
    for (const m of meshes) {
      expect(m.castShadow).toBe(false)
      expect(m.receiveShadow).toBe(true)
    }
  })
})
