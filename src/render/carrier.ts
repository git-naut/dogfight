import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 空母。
 *
 * 原本は FlightGear fgdata の USS Nimitz (CVN-68)（作者 Vivian Meazza、
 * GPLv2）。`tools/ac3d-to-glb.mjs` が当プロジェクトの座標系（艦首 −Z、
 * 上 +Y、右舷 +X）へ移した glb を読む。
 *
 * **`loadAircraftModel` を使い回さない。**あちらは舵面のノードとヒンジの
 * 定義を前提にしていて、空母にはどちらも無い。分けたほうが読める。
 *
 * 実測（変換後）。2,644 三角形、21 プリミティブ、マテリアル 18、
 * テクスチャ 10 種、glb 189 KB。飛行甲板は Z −112.2..222.0 の 334.2 m、
 * 幅 82.6 m、高さ 58.1 m。**シーンの三角形予算 1.5M に対して 0.18%。**
 */

export interface Carrier {
  readonly object: THREE.Object3D
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  dispose(): void
}

/**
 * 甲板の高さ m。
 *
 * 原本の `.ac` でカタパルトと甲板が Y 20.0 にある。海面を 0 とすると、
 * そのまま置けば喫水線が合う（船体の下端が −1.2）。
 */
export const DECK_HEIGHT = 20

export async function loadCarrier(url: string): Promise<Carrier> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)

  const object = gltf.scene
  let triangles = 0

  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    const geometry = node.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    triangles += (index !== null ? index.count : geometry.getAttribute('position').count) / 3

    // **視錐台の判定は残す。**機体と違って動かないので、画面の外に出たら
    // 描かないほうがよい。追従カメラの至近で境界球が外れる問題（`enemyView`
    // の注記）は、334 m の船体では起きない
    node.castShadow = true
    node.receiveShadow = true
  })

  return {
    object,
    triangles,
    dispose(): void {
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return
        node.geometry.dispose()
        const material = node.material
        if (Array.isArray(material)) for (const m of material) m.dispose()
        else material.dispose()
      })
    },
  }
}

/**
 * 空母を海面へ置く。
 *
 * `heading` は艦首の向き rad。0 で −Z（当方の機首方向）を向く。
 */
export function placeCarrier(
  carrier: Carrier,
  x: number,
  z: number,
  heading: number,
): void {
  carrier.object.position.set(x, 0, z)
  carrier.object.rotation.set(0, heading, 0)
}
