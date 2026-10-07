import * as THREE from 'three'
import type { AircraftModel } from './aircraft/model'
import { augmentation } from '../sim/flightModel'
import {
  createVaporCone,
  vaporStrength,
  type VaporCone,
  type VaporMaterialFactory,
} from './aircraft/vaporCone'
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


export interface AircraftView {
  readonly object: THREE.Object3D
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  /** 動かせた舵面の枚数。6 枚あるはず */
  readonly surfaceCount: number
  /**
   * アフターバーナーの強さ 0..1。
   *
   * @param seconds 描画の時刻（`frame × FIXED_DT`）。炎の脈動の位相（段 30e）。
   *   渡さなければ揺らさない
   */
  setThrottle(value: number, seconds?: number): void
  /**
   * マッハ数。音速の近くでベイパーコーンを出す（段 30f）。
   *
   * @param seconds 描画の時刻（`frame × FIXED_DT`）。膜の模様を流す位相
   */
  setMach(mach: number, seconds?: number): void
  /** 舵面の位置 −1..1。sim の AircraftSample の値をそのまま渡す */
  setControls(elevator: number, aileron: number, rudder: number): void
  /**
   * 降着装置の位置 0..1。sim の `AircraftSample.gearPosition` をそのまま渡す。
   * 0 は上げ切りで隠す。脚ごとの付け根がある機体（F/A-18E）は、位置に応じて脚を
   * 畳む向きへ回す（Phase 9 の段 6）。**1 では回転 0** で、出し切りの絵は段 5 までと同じ
   *
   * **判定を描画側に持たない。**キャプチャモードは `sync()` が 1 回しか
   * 走らないので、描画側で状態を持つ形にすると出ない
   */
  setGear(position: number): void
  dispose(): void
}

export interface AircraftViewOptions {
  /** 炎の材質の作り手。既定は恒等（`afterburner.ts` の `FlameMaterialFactory`） */
  flameMaterial?: FlameMaterialFactory
  /** ベイパーコーンを描くか（段 30f）。既定は false */
  vaporCone?: boolean
  /** ベイパーコーンの材質の作り手。node 経路はノイズで揺らす版を差す */
  vaporMaterial?: VaporMaterialFactory
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
  // ベイパーコーン。音速の近くでだけ見える（段 30f）
  const vapor: VaporCone | null =
    options.vaporCone === true ? createVaporCone(options.vaporMaterial) : null
  if (vapor !== null) model.object.add(vapor.object)
  const gear = model.gear

  const surfaces: ControlSurfaces = createControlSurfaces(model.surfaces, model.hinges)

  return {
    object: model.object,
    triangles: model.triangles,
    surfaceCount: surfaces.count,

    setControls(elevator, aileron, rudder) {
      surfaces.update(elevator, aileron, rudder)
    },

    setGear(position) {
      if (gear === null) return
      // **扉が先に開き、脚はそのあと動く**（2026-10-08）。扉の無い機体は脚が位置どおりに動く。
      // 出し切り（1）で脚の回転 0 なので、出し切りの絵は扉を足す前と同じ
      const timing = model.doorTiming
      const share = timing?.share ?? 0
      const legs = share > 0 ? Math.min(1, Math.max(0, (position - share) / (1 - share))) : position
      // 脚は動いているあいだだけ出す。扉の開き始め（脚がまだ畳まれたまま）に出すと、前へ
      // 畳んだ前脚の車輪が外板からはみ出して見える
      gear.visible = legs > 0
      for (const leg of model.gearLegs) {
        leg.object.quaternion.setFromAxisAngle(leg.axis, (1 - legs) * leg.retractRad)
      }
      if (timing === null) return
      const open = Math.min(1, position / timing.share)
      for (const door of model.doors) {
        door.object.quaternion.setFromAxisAngle(door.axis, open * timing.openRad)
        // 主脚の扉は閉じたら隠す（外板と重なってちらつく）。前脚の扉は格納部の穴に蓋をする
        door.object.visible = open > 0 || !door.hideWhenClosed
      }
    },

    setMach(mach: number, seconds?: number) {
      vapor?.setStrength(vaporStrength(mach), seconds)
    },

    setThrottle(value: number, seconds?: number) {
      // 0.85 を超えた分を 0..1 へ写す。届かなければ 0（消える）。境目は sim が持つ
      const strength = augmentation(value)

      burner?.setStrength(strength, seconds)

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
      vapor?.dispose()
    },
  }
}
