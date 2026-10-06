import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DECK_HEIGHT as SIM_DECK_HEIGHT } from '../sim/carrierDeck'

/**
 * 空母。
 *
 * 原本は Sketchfab の USS Gerald R. Ford (CVN-78)（作者 waelXcm、CC BY 4.0。ADR 0017）。
 * `tools/ford-to-glb.mjs` がシーンの頂上に行列を 1 つ掛けて当プロジェクトの座標系
 * （艦首 −Z、上 +Y、右舷 +X、水面 Y 0）へ移した glb を読む。Phase 9 の段 3 までは
 * FlightGear の USS Nimitz（GPLv2、2,644 三角形）だった。
 *
 * **`loadAircraftModel` を使い回さない。**あちらは舵面のノードとヒンジの
 * 定義を前提にしていて、空母にはどちらも無い。分けたほうが読める。
 *
 * 実測（変換後）。116,316 三角形、テクスチャ 30 枚（WebP 5.4 MB）、glb 8.64 MB。
 * 全長 337 m、飛行甲板は水面から 18.87 m。**シーンの三角形予算 1.5M に対して 7.8%。**
 */

export interface Carrier {
  readonly object: THREE.Object3D
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  dispose(): void
}

/**
 * 甲板の高さ m。sim の値（`fordDeck.ts`）をそのまま使う。**描画と射出で別の値を持たない**
 */
export const DECK_HEIGHT = SIM_DECK_HEIGHT

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
    // の注記）は、337 m の船体では起きない
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
 * `heading` は艦首の向き rad。0 で −Z（当方の機首方向）を向き、**右回りが正**
 * （上から見て時計回り。HUD の `headingOf`・敵機・標的機と同じ約束）。
 *
 * three の `rotation.y` は左回りが正なので、符号を反転して渡す。Phase 9 の段 1 までは
 * `heading` をそのまま渡していて、描画と射出だけが左回りだった（レーダーとは逆）
 */
export function placeCarrier(
  carrier: Carrier,
  x: number,
  z: number,
  heading: number,
): void {
  carrier.object.position.set(x, 0, z)
  carrier.object.rotation.set(0, -heading, 0)
}
