import type * as THREE from 'three'
import { mrt, output } from 'three/tsl'
import type { FlameMaterialFactory } from '../aircraft/afterburner'
import type { NodeMaterialLibrary } from './nodeAircraftMaterial'

/**
 * 炎を発光体として MRT の `emissive` へ書かせる。
 *
 * **閾値だけでは順光の排気口と雲を分けられない**（段 22 の宿題）。場面の
 * パスは `emissive` の既定を 0 にしてあり（`createScenePass`）、炎だけが
 * 自分の色（`output`）で上書きする。`mrt.merge` は材質の側が勝つ。
 *
 * 炎は three の `MeshBasicMaterial` なので、そのままでは `mrtNode` を差す口が
 * 無い。**node 版へ先に写してから差す**（機体の材質と同じ `fromMaterial`）。
 * 写せない型では原本のまま返し、炎は光らないだけで消えない
 */
export function toNodeFlameMaterial(renderer: { library: NodeMaterialLibrary }): FlameMaterialFactory {
  return (source) => {
    const copy = renderer.library.fromMaterial(source) ?? source
    if (copy === source) return source
    ;(copy as THREE.Material & { mrtNode: unknown }).mrtNode = mrt({ emissive: output })
    return copy
  }
}
