import * as THREE from 'three'
import type { AircraftModel } from './aircraft/model'
import { createControlSurfaces, type ControlSurfaces } from './aircraft/surfaces'
import {
  createAfterburner,
  keepFlameMaterial,
  type Afterburner,
  type FlameMaterialFactory,
} from './aircraft/afterburner'

/**
 * 機体の表示。
 *
 * 中身は Sketchfab の F/A-18E（作者 KOG_THORNS、CC BY 4.0）。`?craft=f18`
 * では FlightGear FGAddon の F/A-18C（Fabrice Kauffmann、GPLv2+）に戻る。
 * 座標変換は変換ツール側が済ませてあるので、ここでは読んで舵面と炎を
 * 動かすだけ。
 *
 * アフターバーナーの炎は原本に入っている。FlightGear は
 * `engines/engine[0]/augmentation` で `ExternalFlame` を出し入れし、
 * `InternalFlame` は常に見せている。同じ扱いにする。
 *
 * **モデルは受け取るだけで読み込まない。**標的機が同じ機体を使うので、
 * `loadAircraftModel` を呼ぶのは `scene.ts` の 1 回だけにする。2 回呼ぶと
 * パースとテクスチャの復号が 2 度走り、ジオメトリとマテリアルが複製される。
 * 破棄も呼び出し側がモデルに対して行う。
 */

/** この値を超えたらアフターバーナーの炎を出す */
const AUGMENTATION_THROTTLE = 0.85

export interface AircraftView {
  readonly object: THREE.Object3D
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  /** 動かせた舵面の枚数。6 枚あるはず */
  readonly surfaceCount: number
  /** アフターバーナーの強さ 0..1 */
  setThrottle(value: number): void
  /** 舵面の位置 −1..1。sim の AircraftSample の値をそのまま渡す */
  setControls(elevator: number, aileron: number, rudder: number): void
  /**
   * 降着装置を出すか。sim の `AircraftSample.gearDown` をそのまま渡す。
   *
   * **判定を描画側に持たない。**キャプチャモードは `sync()` が 1 回しか
   * 走らないので、描画側で高度を見て切り替える形にすると出ない
   */
  setGearDown(down: boolean): void
  dispose(): void
}

export interface AircraftViewOptions {
  /** 炎の材質の作り手。既定は恒等（`afterburner.ts` の `FlameMaterialFactory`） */
  flameMaterial?: FlameMaterialFactory
}

export function createAircraftView(
  model: AircraftModel,
  options: AircraftViewOptions = {},
): AircraftView {
  // 原本が炎の板を持つ機体（F/A-18C）はそれを出し入れする
  const externalFlame = model.object.getObjectByName('ExternalFlame') ?? null
  if (externalFlame !== null) externalFlame.visible = false
  // ノズルの定義がある機体（F/A-18E）は自前で描く
  const burner: Afterburner | null =
    model.nozzles.length > 0
      ? createAfterburner(model.nozzles, options.flameMaterial ?? keepFlameMaterial)
      : null
  if (burner !== null) model.object.add(burner.object)
  const gear = model.gear

  const surfaces: ControlSurfaces = createControlSurfaces(model.surfaces, model.hinges)

  return {
    object: model.object,
    triangles: model.triangles,
    surfaceCount: surfaces.count,

    setControls(elevator, aileron, rudder) {
      surfaces.update(elevator, aileron, rudder)
    },

    setGearDown(down) {
      if (gear === null) return
      gear.visible = down
    },

    setThrottle(value: number) {
      const t = Math.min(1, Math.max(0, value))
      // 0.85 を超えた分を 0..1 へ写す。届かなければ 0（消える）
      const strength =
        t <= AUGMENTATION_THROTTLE
          ? 0
          : (t - AUGMENTATION_THROTTLE) / (1 - AUGMENTATION_THROTTLE)

      burner?.setStrength(strength)

      if (externalFlame !== null) {
        externalFlame.visible = strength > 0
        // 点火してすぐは短く、全開で伸びる
        if (strength > 0) externalFlame.scale.set(1, 1, 0.55 + strength * 0.45)
      }
    },

    dispose() {
      // モデルの破棄はしない。標的機の複製と実体を共有しているので、
      // ここで消すと標的まで壊れる。破棄は scene.ts がモデルに対して 1 回。
      // **炎はこの view が作ったもの**なので、ここで捨てる
      burner?.dispose()
    },
  }
}
