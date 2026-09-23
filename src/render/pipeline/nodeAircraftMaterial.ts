import type * as THREE from 'three'
import type { AircraftMaterialFactory } from '../aircraft/model'

/**
 * 機体の材質を TSL 版へ写す。
 *
 * **写すだけで絵は変えない。**`NodeLibrary.fromMaterial` は対応する
 * `NodeMaterial` のクラスを作り、原本の列挙可能なキーを全部写す。three が
 * 材質を組むときに内部でやるのと同じ手順を、公開の口で先に済ませるだけ。
 *
 * 写しておく理由は `normalNode` と `roughnessNode` を差す口が要ることで、
 * それを使うのは表面ディテールから。この段では**42 枚が 0 画素差**であること
 * を単独で証明する。
 */

/**
 * 使うのは `fromMaterial` だけ。
 *
 * レンダラ全体を要求すると検査で器を作れない。`WebGPURenderer` はこの形に
 * 当てはまる
 */
export interface NodeMaterialLibrary {
  fromMaterial: (material: THREE.Material) => THREE.Material | null
}

/**
 * **クラスが見つからない型では `null` が返る。**`NodeLibrary.js` の
 * `fromMaterial` は `nodeMaterial` を `null` で初期化し、
 * `getMaterialNodeClass` が当たったときだけ代入する。例外は投げない。
 * 素通しすると材質が `null` になってメッシュが壊れるので、原本のまま使う。
 *
 * 既に `NodeMaterial` のときは three 側が原本をそのまま返す（二重に写らない）。
 */
export function toNodeAircraftMaterial(renderer: {
  library: NodeMaterialLibrary
}): AircraftMaterialFactory {
  return (source) => renderer.library.fromMaterial(source) ?? source
}
