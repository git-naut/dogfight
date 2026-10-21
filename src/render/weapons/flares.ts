import * as THREE from 'three'
import type { Flare } from '../../sim/weapons/flare'
import { FLARE_BURN_SECONDS, flashIntensity } from '../../sim/weapons/flare'
import { clampRadiusToNear } from './explosions'
import {
  createGlRadialSprite,
  makeRadialSprite,
  radialSpriteHandle,
  type RadialSpriteFactory,
  type RadialSpriteMaterial,
} from './radialSprite'
import type { QualitySettings } from '../quality'
import { BAND_HOT_COLOR, HOT_COLOR, RED_ORANGE, YELLOW_ORANGE, placeBand } from './fireSprites'

/**
 * フレアの描画。
 *
 * 爆発と同じ、中心から縁へ減衰するビルボード。**テクスチャは要らない。**
 * UV の中心からの距離で切るだけ。
 *
 * **Phase 5 の教訓を踏む。**ビルボードは減衰させないと四角い板に見える。
 * 曳光弾は加算の値が露出 6 倍と AgX で彩度を失って白に飛んだ。フレアも同じ
 * 経路なので、**色と濃さは絵で確かめてから決める。**
 *
 * near 面の扱いも爆発と同じ `clampRadiusToNear` を通す。**フレアは自機の
 * すぐ後ろに出るので、カメラの至近を通る。**リボンではないので断面は出ない
 * はずだが、板が near 面を跨ぐと切り口が出る。
 */

/**
 * 火の玉の半径 m。
 *
 * マグネシウム系の火工品は数十 cm の火球になるとされる。**この値は絵で
 * 決める。**小さすぎると 500 m 先で 1 画素にもならない。
 */
export const FLARE_RADIUS = 1.6

/**
 * 尾を引く煙の半径。火の玉より大きく、薄い。
 */
export const FLARE_SMOKE_RADIUS = 3.2

/*
 * 火の色（段 B9 で改めた）。段 B8 までは白い光で、燃えているあいだ (0.30, 0.28, 0.25)・点火の瞬間
 * (1.2, 1.1, 0.95) を混ぜていた。マグネシウムの炎は白に近いという理由で色を付けず、出力は
 * rgb(221,219,216)・彩度 5 だった。後ろの海面の霞で寄与が透過率 0.13 まで落ちるので、芯は深度を
 * 書いていた。
 *
 * ユーザーの指示（2026-10-21）で、ミサイルの炎の尾と同じ赤みの橙の火と帯に寄せた。色は
 * `fireSprites.ts`。録画（lesson 5 のコマ 23400〜23520）はフレアの説明の区間だが、撒いた火そのものは
 * 写っていない（機体の左下の光はフレアに引き寄せられたミサイルの爆発とみた）。値は推測。霞の後ろの
 * パス（爆発の組の子）で描くので、深度を書く芯は要らない
 */

/**
 * 閃光のときに半径を何倍にするか。
 *
 * 点火の瞬間だけ大きく見せる。**220 m の円は実測 17 画素**しかないので、
 * 色だけでは閃光に見えない。
 */
const FLASH_RADIUS_GAIN = 1.6
/**
 * 煙の色。白色の煙。無彩色にする。
 *
 * (0.55, 0.5, 0.46) はわずかに暖色へ寄っていた。**白い煙は空に対して
 * 伸びしろが小さい。**空が `rgb(195,201,206)` で AgX の上限が線形 1.0 で
 * `rgb(245,245,245)` なので、差は最大 50 階調しか取れない（灰色なら 97）。
 */
const SMOKE_COLOR = new THREE.Color(0.5, 0.5, 0.5)

/**
 * 芯として扱う不透明度の下限。
 *
 * これを下回る画素は芯の層では捨てる。**捨てないと縁で背景が透けたまま
 * 深度が書かれ、その画素の背景が自分の距離の霞になって暗く沈む。**実測で、
 * 縁ごと深度を書くと外接いっぱいの暗い円が出た（赤み 76・彩度 95 は出るが
 * 絵が壊れる）。芯だけに絞ると副作用なしで赤み 89・彩度 121 になる。
 */

/**
 * 火の玉の濃さ。
 *
 * **加算合成なので飛びやすい。**曳光弾で 1 度踏んだ（露出 6 倍と AgX で
 * 彩度を失って白になった）。フレアも同じ経路。
 *
 * 前方 220 m の敵が撒いたフレアを引き算で測った（`?flares=0` との差）。
 *
 * | 火 | 煙 | 画素 | 最大階調 | 見え方 |
 * | 0.90 | 0.35 | 1,767 | 73 | 白い暈。色が飛ぶ |
 * | 0.35 | 0.35 | 1,767 | 58 | まだ白い。暈は煙のほう |
 * | 0.55 | 0.12 | 1,605 | 63 | 芯が締まり黄が残る |
 *
 * **暈の正体は煙だった。**火の濃さを下げても消えず、煙を薄くして初めて
 * 締まった。煙の半径は火の 2 倍あるので、外側の白はほぼ煙。
 */
export const FLARE_OPACITY = 0.95

/** 煙の濃さ。通常合成。**火より効くので薄くする**（上の実測） */
const SMOKE_OPACITY = 0.12

/**
 * 燃え始めの立ち上がりに使う秒数。
 *
 * 点火の瞬間に最大の明るさで出ると唐突に見える。短く膨らませる。
 */
const IGNITION_SECONDS = 0.15

/**
 * 火が満濃度を保つ残り時間の割合。
 *
 * これを下回ってから薄れ始める。0.25 は燃焼 4 秒に対して残り 1 秒。
 * **保持しないと芯が消える。**線形に薄めると経過 1.49 秒で不透明度 0.596 に
 * なり、`CORE_CUT` を割る。
 */
const FIRE_HOLD_FRACTION = 0.25

/**
 * 至近で半径を絞り始める距離 m。
 *
 * この距離より近いと、板が画角いっぱいに広がらないよう半径を縮める。
 * `MIN_CAMERA_DISTANCE` で完全に消すのではなく、まず絞る。
 */
const SHRINK_DISTANCE = 60

/**
 * この距離より近いフレアは描かない m。
 *
 * **追従カメラは自機の後方 23 m にいて、フレアは自機の後ろへ落ちる。**
 * （2026-10-01 に寄せる前のカメラ。いまは後方 19.5 m・上 3.8 m、`camera.ts`）
 * だから撒いた 0.5 秒後にはカメラの至近を通る。実測で、半径 1.6 m の板が
 * 画面の下半分を白く塗りつぶした（76,401 画素・最大 148 階調）。
 *
 * `clampRadiusToNear` は near 面を跨がないよう絞るだけで、至近の板が
 * 画角いっぱいに広がるのは止められない。**距離で切る。**
 *
 * **20 m にしていたら自機のフレアが一度も映らなかった。**排気口から出た
 * 瞬間がカメラから 19.5 m で、足切りに 0.5 m 足りない。遠ざかる前に後ろへ
 * 落ちるので、映る窓がまったくなかった（`flare-break` の実測）。
 *
 * | 経過 | 距離 | 前方深度 |
 * | 0.00 s | 19.5 m | 18.5 m |
 * | 0.39 s | 9.3 m | 4.8 m |
 * | 0.56 s | 11.9 m | −7.3 m（カメラの後ろ） |
 *
 * 8 m まで下げて、代わりに `SHRINK_DISTANCE` から半径を絞る。画面を白く
 * 塗りつぶすのは板の見かけの大きさが原因なので、そちらを抑えれば足りる。
 */
const MIN_CAMERA_DISTANCE = 8

/**
 * 火の帯の長さと太さ m（段 B9、ユーザーの指示でミサイルの炎の尾に寄せた。値は推測）。進む向きの
 * 後ろへ伸ばす。外は赤みの橙、内は黄みの橙、芯は黄みの白（加算）
 */
const BAND_LENGTH = 6
const BAND_WIDTH = 1.6
const BAND_INNER_LENGTH = 4.5
const BAND_INNER_WIDTH = 0.8
const BAND_HOT_LENGTH = 3.5
const BAND_HOT_WIDTH = 0.4
/** 黄みの白い芯の半径 m。点火の閃光では `FLASH_RADIUS_GAIN` で膨らむ */
const HOT_RADIUS = 0.5

export interface Flares {
  readonly object: THREE.Object3D
  /** 実際に描いた数。E2E とデバッグから読む */
  readonly drawn: number
  update(
    flares: readonly Flare[],
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  /**
   * 材質を先に組むため、1 発ぶんの全部の板を不透明度 0 でカメラの前に置く（段 B9。霞の後ろのパスで
   * 描くようにしたので、爆発と同じく最初の 1 発で組む待ちが出る）。描いたあとは空の列で更新して隠す
   */
  prewarm(cameraPosition: THREE.Vector3, cameraForward: THREE.Vector3): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: Flares = {
  object: new THREE.Group(),
  drawn: 0,
  update() {},
  prewarm() {},
  setQuality() {},
  dispose() {},
}

const scratch = new THREE.Vector3()
const lookMatrix = new THREE.Matrix4()
/** 帯を伸ばす向き（進む向きの逆）。毎フレーム作らない */
const backward = new THREE.Vector3()

export function createFlares(
  capacity: number,
  quality: QualitySettings,
  // **材質の作り手を外から差す。**理由は `explosions.ts` の同じ引数
  sprite: RadialSpriteFactory = createGlRadialSprite,
): Flares {
  let enabled = quality.flareSprites > 0
  if (quality.flareSprites === 0) return NOT_ENABLED

  const group = new THREE.Group()
  // フレアは機体の後ろに出る。視錐台で捨てられると消える
  group.frustumCulled = false

  const quad = new THREE.PlaneGeometry(1, 1)

  const radial = (color: THREE.Color, falloff: number, additive: boolean): RadialSpriteMaterial =>
    makeRadialSprite(sprite, { color, falloff, additive })

  /**
   * 1 発 7 枚（段 B9）。ユーザーの指示で、ミサイルの炎と同じ赤みの橙に寄せた（`fireSprites.ts`）。
   * 段 B8 までは白い火の玉（`FLARE_COLOR`）と白い煙の 3 枚で、芯は深度を書いていた。霞の後ろのパスでは
   * 深度を書く芯が暗い輪になるので、どの層も深度を書かない
   */
  interface Slot {
    /** 黄みの橙の芯 */
    core: THREE.Mesh
    /** 赤みの橙の暈 */
    fire: THREE.Mesh
    /** 黄みの白い芯（加算）。点火の閃光で膨らむ */
    hot: THREE.Mesh
    /** 進む向きの後ろへ伸ばす帯。外・内・芯 */
    band: THREE.Mesh
    bandInner: THREE.Mesh
    bandHot: THREE.Mesh
    smoke: THREE.Mesh
  }

  const materials: THREE.Material[] = []
  function layer(color: THREE.Color, falloff: number, additive: boolean, order: number): THREE.Mesh {
    const made = radial(color, falloff, additive)
    materials.push(made.material)
    const mesh = new THREE.Mesh(quad, made.material)
    mesh.frustumCulled = false
    mesh.visible = false
    // **`group.add` の順序では決まらない。**three は透明を
    // `renderOrder → z 降順 → id 昇順` で並べ替える
    // （`WebGLRenderLists.js` の `reversePainterSortStable`）。層は同じ位置に
    // 置くので z が一致し、`renderOrder` を書かないと生成順（id）で決まる
    mesh.renderOrder = order
    group.add(mesh)
    return mesh
  }
  const slots: Slot[] = Array.from({ length: capacity }, () => ({
    smoke: layer(SMOKE_COLOR, 0.9, false, -1),
    fire: layer(RED_ORANGE, 0.8, false, 0),
    band: layer(RED_ORANGE, 0.8, false, 0),
    core: layer(YELLOW_ORANGE, 1.2, false, 1),
    bandInner: layer(YELLOW_ORANGE, 1.2, false, 1),
    hot: layer(HOT_COLOR, 1.4, true, 2),
    bandHot: layer(BAND_HOT_COLOR, 1.4, true, 2),
  }))
  const allLayers = (slot: Slot): THREE.Mesh[] => [
    slot.smoke,
    slot.fire,
    slot.band,
    slot.core,
    slot.bandInner,
    slot.hot,
    slot.bandHot,
  ]

  let drawn = 0

  function place(
    mesh: THREE.Mesh,
    position: THREE.Vector3,
    radius: number,
    opacity: number,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): boolean {
    if (opacity <= 0.004) {
      mesh.visible = false
      return false
    }
    // **至近では描かない。**板が画角いっぱいに広がって画面を塗りつぶす
    const distanceSq = scratch.subVectors(position, cameraPosition).lengthSq()
    if (distanceSq < MIN_CAMERA_DISTANCE ** 2) {
      mesh.visible = false
      return false
    }
    // **消す前にまず絞る。**見かけの大きさを一定に近づけると、至近を通る
    // フレアが画面を塗りつぶさずに済む。消してしまうと自機のフレアが
    // 一度も映らない（`MIN_CAMERA_DISTANCE` の実測表）
    const distance = Math.sqrt(distanceSq)
    const shrink = distance < SHRINK_DISTANCE ? distance / SHRINK_DISTANCE : 1
    const depth = scratch.dot(cameraForward)
    const clamped = clampRadiusToNear(depth, radius * shrink)
    if (clamped <= 0) {
      mesh.visible = false
      return false
    }
    mesh.position.copy(position)
    // ビルボード。視線に垂直な板
    mesh.quaternion.setFromRotationMatrix(
      lookMatrix.lookAt(cameraPosition, position, THREE.Object3D.DEFAULT_UP),
    )
    mesh.scale.setScalar(clamped * 2)
    radialSpriteHandle(mesh.material as THREE.Material)!.setOpacity(opacity)
    mesh.visible = true
    return true
  }

  const world = new THREE.Vector3()

  return {
    object: group,

    get drawn() {
      return drawn
    },

    update(flares, cameraPosition, cameraForward) {
      drawn = 0
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!
        const flare = flares[i]
        if (!enabled || flare === undefined || !flare.alive) {
          for (const mesh of allLayers(slot)) mesh.visible = false
          continue
        }

        world.set(flare.position.x, flare.position.y, flare.position.z)
        // 燃え始めは膨らみ、終わりに向かって痩せる
        const burned = FLARE_BURN_SECONDS - flare.burn
        const ignition = Math.min(1, burned / IGNITION_SECONDS)
        const remaining = flare.burn / FLARE_BURN_SECONDS
        const fade = ignition * remaining
        // **火は保持してから落とす。**線形に薄めると火が半透明のまま煙と
        // 混ざり、赤が出ない（実測で経過 1.49 秒に不透明度 0.596）。爆発の芯
        // で同じ欠陥を直したのと同じ形にする（`sim/effects.ts` の
        // `coreOpacity`）。燃え尽きる手前 1 秒まで 1.0 を保つ
        const fireFade = Math.min(1, remaining / FIRE_HOLD_FRACTION)
        const flash = flashIntensity(burned)

        // **閃光は点火の瞬間が最大。**立ち上がりの傾斜は掛けない。
        // 火工品は一瞬で最大光度へ達するので、膨らませると閃光に見えない
        const fireOpacity = FLARE_OPACITY * fireFade
        const fireRadius = FLARE_RADIUS * (1 + FLASH_RADIUS_GAIN * flash)
        // 閃光は黄みの白い芯を膨らませて出す（段 B8 までは火の色を白へ混ぜていた）
        if (place(slot.fire, world, fireRadius, fireOpacity, cameraPosition, cameraForward)) drawn++
        place(slot.core, world, fireRadius * 0.55, fireOpacity, cameraPosition, cameraForward)
        place(slot.hot, world, HOT_RADIUS * (1 + 2 * FLASH_RADIUS_GAIN * flash), fireOpacity, cameraPosition, cameraForward)

        // 帯は進む向きの後ろへ伸ばす。速さが無ければ出さない
        const speed = Math.hypot(flare.velocity.x, flare.velocity.y, flare.velocity.z)
        if (speed > 1) {
          backward.set(-flare.velocity.x / speed, -flare.velocity.y / speed, -flare.velocity.z / speed)
          placeBand(slot.band, world, backward, BAND_LENGTH, BAND_WIDTH, fireOpacity, cameraPosition, cameraForward)
          placeBand(slot.bandInner, world, backward, BAND_INNER_LENGTH, BAND_INNER_WIDTH, fireOpacity, cameraPosition, cameraForward)
          placeBand(slot.bandHot, world, backward, BAND_HOT_LENGTH, BAND_HOT_WIDTH, fireOpacity, cameraPosition, cameraForward)
        } else {
          slot.band.visible = false
          slot.bandInner.visible = false
          slot.bandHot.visible = false
        }
        place(
          slot.smoke,
          world,
          FLARE_SMOKE_RADIUS * ignition,
          SMOKE_OPACITY * fade,
          cameraPosition,
          cameraForward,
        )
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

    setQuality(next) {
      enabled = next.flareSprites > 0
      group.visible = enabled
    },

    dispose() {
      quad.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
