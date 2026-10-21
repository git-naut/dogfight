import * as THREE from 'three'
import { MISSILE_LENGTH } from '../../sim/weapons/missile'
import {
  createGlRadialSprite,
  makeRadialSprite,
  radialSpriteHandle,
  type RadialSpriteFactory,
} from './radialSprite'
import { BAND_HOT_COLOR, HOT_COLOR, RED_ORANGE, YELLOW_ORANGE, placeBand, placeRound } from './fireSprites'
import type { QualitySettings } from '../quality'

/**
 * ミサイルの発射炎と炎の尾（段 B9、ADR 0034）。
 *
 * 録画（lesson 5 のコマ 20022〜20031）は、撃った瞬間に吊るしのまわりが 1 コマだけ明るく光り（黄みの白い芯
 * 約 60 画素・橙のまわり 約 120 画素）、そのあと太く明るい炎の尾を引いて照準へ向かう。尾はカメラの近くまで
 * 長く伸び、画面の左下の外まで届く（20023）。炎の色は、ユーザーの指示で火の赤みを足した。
 *
 * どちらもフレアと同じ、中心から縁へ落ちる板（`radialSprite.ts`）で描く。炎の尾はミサイルの軸に沿って
 * 伸ばした板で、軸の周りに回して面をカメラへ向ける。
 *
 * **爆発の組の子にして、霞の後ろのパスで描く**（`views.ts`）。場面のパスに置くと、深度を書かない板に
 * 後ろの地形の距離で霞が掛かり、炎の尾がまったく写らなかった。このパスでは深度を書く芯（`opaqueCore`）が
 * 暗い輪になったので、どの層も深度を書かない
 */

/** 発射炎を出す秒。録画は 1 コマ（33 ms）。合意した幅は 2 コマ以内 */
export const LAUNCH_FLASH_SECONDS = 2 / 30

/**
 * 発射炎の半径 m。
 *
 * 追従カメラ（後方 24.2 m・上 5.55 m、速さ 250 m/s で縦の画角 約 46 度）から吊るしまで 約 24.5 m で、
 * 1 m が 約 52 画素に写る。録画の芯 約 60 画素・まわり 約 120 画素を直径とみて半径にした。まわりは
 * 縁で薄れて見かけが縮むので大きめに置く
 */
const FLASH_GLOW_RADIUS = 1.6
const FLASH_CORE_RADIUS = 0.9
const FLASH_HOT_RADIUS = 0.7

/**
 * 炎の尾の 3 層の長さと太さ m。噴射口から後ろへ伸ばす。
 *
 * 前後の距離どおりの 6 m では、発射から 0.3 秒のあいだ自機の水平尾翼と主翼の陰に入り、機首の前に出た
 * あとは視線に沿って点に縮んで、尾として写らなかった。録画に寄せて長く太くした（ユーザーの決定）。
 * 噴射口に近いほど黄みの白、端ほど赤みの橙になるよう、短く細い層を内側に重ねる
 */
export const FLAME_LENGTH = 15
const FLAME_WIDTH = 2
const FLAME_INNER_LENGTH = 13
const FLAME_INNER_WIDTH = 1.1
const FLAME_HOT_LENGTH = 11
const FLAME_HOT_WIDTH = 0.5
/** 噴射口の白い芯の半径 m */
const NOZZLE_HOT_RADIUS = 0.35

// 色は `fireSprites.ts`（フレアと共有）。露出後 1 未満の赤みの橙を通常合成、黄みの白い芯だけ加算

const GLOW_OPACITY = 1
const CORE_OPACITY = 1
const HOT_OPACITY = 1

/** 描画が読むミサイル 1 発ぶん。`scene.ts` の `MissilePose` と同じ形 */
export interface MissileFlameSource {
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
  readonly age: number
  readonly burning: boolean
}

export interface MissileFlames {
  readonly object: THREE.Object3D
  /** 発射炎を出しているミサイルの数。E2E が読む */
  readonly flashesDrawn: number
  /** 炎の尾を出しているミサイルの数。E2E が読む */
  readonly flamesDrawn: number
  update(
    missiles: readonly MissileFlameSource[],
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  /**
   * 材質を先に組むため、1 発ぶんの全部の板を不透明度 0 でカメラの前に置く（`explosions.ts` の
   * `prewarm` と同じ）。描いたあとは空の列で `update` して隠す
   */
  prewarm(cameraPosition: THREE.Vector3, cameraForward: THREE.Vector3): void
  dispose(): void
}

const NOT_ENABLED: MissileFlames = {
  object: new THREE.Group(),
  flashesDrawn: 0,
  flamesDrawn: 0,
  update() {},
  prewarm() {},
  dispose() {},
}

const forward = new THREE.Vector3()
const backward = new THREE.Vector3()
const nozzle = new THREE.Vector3()
const scratch = new THREE.Vector3()
const MINUS_Z = new THREE.Vector3(0, 0, -1)

export function createMissileFlames(
  capacity: number,
  quality: QualitySettings,
  // 材質の作り手を外から差す。理由は `explosions.ts` の同じ引数
  sprite: RadialSpriteFactory = createGlRadialSprite,
  /**
   * 発射炎の材質の作り手。**node 経路では場面の物に隠されない作り手を渡す。**噴射口は主翼の下にあり、
   * 上方のカメラからは主翼に隠れて淡い光が覗くだけだった。録画（20022）の発射炎は主翼と胴体に重なって
   * 光る。出ているのは 2 コマだけなので、地形越しに透けても目立たない
   */
  flashSprite: RadialSpriteFactory = sprite,
): MissileFlames {
  if (quality.missileFlameSprites === 0) return NOT_ENABLED

  const group = new THREE.Group()
  group.frustumCulled = false
  const quad = new THREE.PlaneGeometry(1, 1)
  const materials: THREE.Material[] = []

  function layer(
    color: THREE.Color,
    falloff: number,
    order: number,
    additive = false,
    factory: RadialSpriteFactory = sprite,
  ): THREE.Mesh {
    const made = makeRadialSprite(factory, { color, falloff, additive })
    materials.push(made.material)
    const mesh = new THREE.Mesh(quad, made.material)
    mesh.frustumCulled = false
    mesh.visible = false
    // 同じ位置に重ねるので、順序は renderOrder で決める（`flares.ts` の注記）
    mesh.renderOrder = order
    group.add(mesh)
    return mesh
  }

  // 1 発 7 枚。外側から内側へ描く
  interface Slot {
    flashGlow: THREE.Mesh
    flashCore: THREE.Mesh
    flashHot: THREE.Mesh
    flame: THREE.Mesh
    flameInner: THREE.Mesh
    flameHot: THREE.Mesh
    nozzleHot: THREE.Mesh
  }
  const slots: Slot[] = Array.from({ length: capacity }, () => ({
    flashGlow: layer(RED_ORANGE, 0.8, 0, false, flashSprite),
    flame: layer(RED_ORANGE, 0.8, 0),
    flashCore: layer(YELLOW_ORANGE, 1.2, 1, false, flashSprite),
    flameInner: layer(YELLOW_ORANGE, 1.2, 1),
    flashHot: layer(HOT_COLOR, 1.4, 2, true, flashSprite),
    flameHot: layer(BAND_HOT_COLOR, 1.4, 2, true),
    nozzleHot: layer(HOT_COLOR, 1.4, 2, true),
  }))
  const allLayers = (slot: Slot): THREE.Mesh[] => [
    slot.flashGlow,
    slot.flashCore,
    slot.flashHot,
    slot.flame,
    slot.flameInner,
    slot.flameHot,
    slot.nozzleHot,
  ]

  let flashesDrawn = 0
  let flamesDrawn = 0

  return {
    object: group,

    get flashesDrawn() {
      return flashesDrawn
    },

    get flamesDrawn() {
      return flamesDrawn
    },

    update(missiles, cameraPosition, cameraForward) {
      flashesDrawn = 0
      flamesDrawn = 0
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!
        const missile = missiles[i]
        if (missile === undefined) {
          for (const mesh of allLayers(slot)) mesh.visible = false
          continue
        }
        forward.copy(MINUS_Z).applyQuaternion(missile.quaternion)
        backward.copy(forward).negate()
        nozzle.copy(missile.position).addScaledVector(forward, -MISSILE_LENGTH / 2)

        // 発射炎。経過とともに薄れる
        const flash = missile.age < LAUNCH_FLASH_SECONDS ? 1 - missile.age / LAUNCH_FLASH_SECONDS : 0
        const glowShown = placeRound(slot.flashGlow, nozzle, FLASH_GLOW_RADIUS, GLOW_OPACITY * flash, cameraPosition, cameraForward)
        placeRound(slot.flashCore, nozzle, FLASH_CORE_RADIUS, CORE_OPACITY * flash, cameraPosition, cameraForward)
        placeRound(slot.flashHot, nozzle, FLASH_HOT_RADIUS, HOT_OPACITY * flash, cameraPosition, cameraForward)
        if (glowShown) flashesDrawn++

        // 炎の尾。燃えているあいだ
        if (missile.burning) {
          const flameShown = placeBand(slot.flame, nozzle, backward, FLAME_LENGTH, FLAME_WIDTH, GLOW_OPACITY, cameraPosition, cameraForward)
          placeBand(slot.flameInner, nozzle, backward, FLAME_INNER_LENGTH, FLAME_INNER_WIDTH, CORE_OPACITY, cameraPosition, cameraForward)
          placeBand(slot.flameHot, nozzle, backward, FLAME_HOT_LENGTH, FLAME_HOT_WIDTH, HOT_OPACITY, cameraPosition, cameraForward)
          placeRound(slot.nozzleHot, nozzle, NOZZLE_HOT_RADIUS, HOT_OPACITY, cameraPosition, cameraForward)
          if (flameShown) flamesDrawn++
        } else {
          slot.flame.visible = false
          slot.flameInner.visible = false
          slot.flameHot.visible = false
          slot.nozzleHot.visible = false
        }
      }
    },

    prewarm(cameraPosition, cameraForward) {
      const slot = slots[0]
      if (slot === undefined) return
      scratch.copy(cameraPosition).addScaledVector(cameraForward, 50)
      for (const mesh of allLayers(slot)) {
        mesh.position.copy(scratch)
        mesh.scale.setScalar(1)
        radialSpriteHandle(mesh.material as THREE.Material)!.setOpacity(0)
        mesh.visible = true
      }
    },

    dispose() {
      quad.dispose()
      for (const material of materials) material.dispose()
      group.clear()
    },
  }
}
