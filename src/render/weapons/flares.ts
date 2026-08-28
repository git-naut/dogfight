import * as THREE from 'three'
import type { Flare } from '../../sim/weapons/flare'
import { FLARE_BURN_SECONDS, flashIntensity } from '../../sim/weapons/flare'
import { clampRadiusToNear } from './explosions'
import type { QualitySettings } from '../quality'

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

/**
 * 燃えているあいだの色。白い光。
 *
 * **色は付けない。**マグネシウムの炎は白に近く、赤みは出ない。閃光との差は
 * 色相ではなく明るさで見せる。
 *
 * **深度を書かないと潰れる。**フレアは目線より下に出るので、後ろに 300 km の
 * 海面がいる。大気のパスがその距離の霞をビルボードに掛け、寄与が透過率 0.13
 * まで落ちる。不透明な芯を分けて深度を書かせる（`CORE_CUT`）。
 *
 * 露出後 `(1.80, 1.68, 1.50)` で出力 `rgb(221,219,216)`、彩度 5。空の
 * `rgb(160,177,195)` に対して 60 階調ぶん明るい。
 */
const FLARE_COLOR = new THREE.Color(0.30, 0.28, 0.25)

/**
 * 点火の瞬間の色。白熱。
 *
 * マグネシウム系の火工品は点火から一瞬で最大光度へ達する。AgX は明るい色ほど
 * 彩度を落とすので、**白く飛ばしたいときはその性質を逆に使う。**露出後を
 * 1 より大きく置くと脱色域に入って白熱になる。
 *
 * モデルで掃引した推移（通常合成・不透明度 1・深度あり）。
 *
 * | 色 | 露出後 | 出力 | 彩度 |
 * | (1.20, 1.10, 0.95) | (7.20, 6.60, 5.70) | `rgb(247,246,244)` | 3 |
 * | (0.45, 0.42, 0.38) | (2.70, 2.52, 2.28) | `rgb(231,229,227)` | 4 |
 * | (0.30, 0.28, 0.25) | (1.80, 1.68, 1.50) | `rgb(221,219,216)` | 5 |
 *
 * `flashIntensity` で混ぜる。**どちらも無彩色なので、推移するのは明るさだけ。**
 */
const FLASH_COLOR = new THREE.Color(1.2, 1.1, 0.95)

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
const CORE_CUT = 0.5

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

export interface Flares {
  readonly object: THREE.Object3D
  /** 実際に描いた数。E2E とデバッグから読む */
  readonly drawn: number
  update(
    flares: readonly Flare[],
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: Flares = {
  object: new THREE.Group(),
  drawn: 0,
  update() {},
  setQuality() {},
  dispose() {},
}

const scratch = new THREE.Vector3()
const lookMatrix = new THREE.Matrix4()
/** 閃光の色を混ぜる器。毎フレーム作らない */
const flashColor = new THREE.Color()

/**
 * 材質の色を差し替える。
 *
 * **`lerp` の結果をそのまま渡すと全部のフレアが同じ色になる。**器は 1 つしか
 * ないので、uniform には値を写す必要がある。スロットごとに材質を持つのは
 * このため（`createFlares` の `slots`）
 */
function setColor(mesh: THREE.Mesh, color: THREE.Color): void {
  const material = mesh.material as THREE.ShaderMaterial
  ;(material.uniforms['uColor']!.value as THREE.Color).copy(color)
}

export function createFlares(capacity: number, quality: QualitySettings): Flares {
  let enabled = quality.flareSprites > 0
  if (quality.flareSprites === 0) return NOT_ENABLED

  const group = new THREE.Group()
  // フレアは機体の後ろに出る。視錐台で捨てられると消える
  group.frustumCulled = false

  const quad = new THREE.PlaneGeometry(1, 1)

  const radial = (
    color: THREE.Color,
    falloff: number,
    additive: boolean,
    opaqueCore = false,
  ): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      uniforms: {
        // **複製する。**参照のまま入れるとスロット全部が同じ器を指し、
        // 1 つの色を書き換えた瞬間に全部のフレアが同じ色になる
        uColor: { value: color.clone() },
        uOpacity: { value: 0 },
        uFalloff: { value: falloff },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uFalloff;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          if (d > 1.0) discard;
          float a = pow(max(0.0, 1.0 - d), uFalloff) * uOpacity;
          if (a < 0.004) discard;
          #ifdef OPAQUE_CORE
          // 芯は不透明にして深度を書く。縁は捨てる。
          // **背景が透ける画素で深度を書いてはいけない。**書くと、その画素の
          // 背景が自分の距離の霞になって暗く沈み、縁のはっきりした暗い円が出る
          if (a < CORE_CUT) discard;
          gl_FragColor = vec4(uColor, 1.0);
          #else
          gl_FragColor = vec4(uColor, a);
          #endif
        }
      `,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // 不透明な芯だけ深度を書く。理由は `CORE_CUT` の節（`docs/weapons.md`）
      depthWrite: opaqueCore,
      ...(opaqueCore
        ? { defines: { OPAQUE_CORE: '1', CORE_CUT: CORE_CUT.toFixed(2) } }
        : {}),
      side: THREE.DoubleSide,
    })

  interface Slot {
    /** 不透明な芯。深度を書くので大気のパスが自分の距離で霞を掛ける */
    core: THREE.Mesh
    /** 柔らかい暈。深度は書かない */
    fire: THREE.Mesh
    smoke: THREE.Mesh
  }

  const materials: THREE.Material[] = []
  const slots: Slot[] = Array.from({ length: capacity }, () => {
    // 火は芯が明るく縁が締まる。煙はふわりと広がる。
    // **3 層すべて通常合成。**加算は赤にならない（`FLARE_COLOR`）
    const coreMaterial = radial(FLARE_COLOR, 1.8, false, true)
    const fireMaterial = radial(FLARE_COLOR, 1.8, false)
    const smokeMaterial = radial(SMOKE_COLOR, 0.9, false)
    materials.push(coreMaterial, fireMaterial, smokeMaterial)

    const core = new THREE.Mesh(quad, coreMaterial)
    const fire = new THREE.Mesh(quad, fireMaterial)
    const smoke = new THREE.Mesh(quad, smokeMaterial)
    for (const mesh of [core, fire, smoke]) {
      mesh.frustumCulled = false
      mesh.visible = false
    }
    // **`group.add` の順序では決まらない。**three は透明を
    // `renderOrder → z 降順 → id 昇順` で並べ替える
    // （`WebGLRenderLists.js` の `reversePainterSortStable`）。3 層は同じ位置に
    // 置くので z が一致し、`renderOrder` を書かないと生成順（id）で決まる。
    // 加算だった頃は順序が結果を変えないので露出しなかった
    smoke.renderOrder = -1
    core.renderOrder = 1
    group.add(smoke)
    group.add(fire)
    group.add(core)
    return { core, fire, smoke }
  })

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
    const material = mesh.material as THREE.ShaderMaterial
    material.uniforms['uOpacity']!.value = opacity
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
          slot.core.visible = false
          slot.fire.visible = false
          slot.smoke.visible = false
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
        // 白熱と赤を混ぜる。`flash` が 1 なら白、0 なら赤
        flashColor.copy(FLARE_COLOR).lerp(FLASH_COLOR, flash)
        setColor(slot.core, flashColor)
        setColor(slot.fire, flashColor)

        // 芯と暈は同じ大きさと濃さで置く。芯の側が `CORE_CUT` で内側だけ残す
        place(slot.core, world, fireRadius, fireOpacity, cameraPosition, cameraForward)
        if (
          place(slot.fire, world, fireRadius, fireOpacity, cameraPosition, cameraForward)
        ) {
          drawn++
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
