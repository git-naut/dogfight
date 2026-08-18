import * as THREE from 'three'
import { loadAircraftModel, type AircraftModel } from './aircraft/model'

/**
 * 機体の表示。
 *
 * 中身は FlightGear FGAddon の F/A-18C（作者 Fabrice Kauffmann、GPLv2+）。
 * 座標変換は `tools/ac3d-to-glb.mjs` が済ませてあるので、ここでは読んで
 * 舵面と炎を動かすだけ。
 *
 * アフターバーナーの炎は原本に入っている。FlightGear は
 * `engines/engine[0]/augmentation` で `ExternalFlame` を出し入れし、
 * `InternalFlame` は常に見せている。同じ扱いにする。
 */

/** この値を超えたらアフターバーナーの炎を出す */
const AUGMENTATION_THROTTLE = 0.85

export interface AircraftView {
  readonly object: THREE.Object3D
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  /** アフターバーナーの強さ 0..1 */
  setThrottle(value: number): void
  dispose(): void
}

export async function createAircraftView(url: string): Promise<AircraftView> {
  const model: AircraftModel = await loadAircraftModel(url)

  const externalFlame = model.object.getObjectByName('ExternalFlame') ?? null
  if (externalFlame !== null) externalFlame.visible = false

  return {
    object: model.object,
    triangles: model.triangles,

    setThrottle(value: number) {
      if (externalFlame === null) return
      const t = Math.min(1, Math.max(0, value))
      const lit = t > AUGMENTATION_THROTTLE
      externalFlame.visible = lit
      if (lit) {
        // 点火してすぐは短く、全開で伸びる。0.85 を超えた分を 0..1 へ写す
        const strength = (t - AUGMENTATION_THROTTLE) / (1 - AUGMENTATION_THROTTLE)
        externalFlame.scale.set(1, 1, 0.55 + strength * 0.45)
      }
    },

    dispose() {
      model.dispose()
    },
  }
}
