import * as THREE from 'three'
import type { Flare } from '../../sim/weapons/flare'
import { FLARE_BURN_SECONDS } from '../../sim/weapons/flare'
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
 * 火の玉の色。赤い燃焼。
 *
 * **加算合成では赤が原理的に出ない。**理由は `explosions.ts` の
 * `FIREBALL_COLOR` に書いた。比は爆発と揃えて 1 : 0.12 : 0.03。
 *
 * **それだけでは足りない。**フレアは目線より下に出るので、後ろに 300 km の
 * 海面がいる。深度を書かないと大気のパスがその距離の霞をビルボードに掛け、
 * 寄与が透過率 0.13 まで潰れる。不透明な芯を分けて深度を書かせる
 * （`CORE_CUT`）。実測の推移（`enemy-flare` f180、`?flares=0` との引き算）。
 *
 * | 条件 | 赤み | 彩度 |
 * | 加算・白 (1, 0.86, 0.55) | 8 | 15 |
 * | 通常合成・明るい赤・深度なし | 45 | 48 |
 * | 通常合成・赤・縁ごと深度を書く | 76 | 95 |
 * | 通常合成・赤・芯だけ深度を書く | 89 | 121 |
 *
 * 121 は AgX のモデルが出す上限 123 にほぼ届いている。
 */
const FLARE_COLOR = new THREE.Color(0.14, 0.017, 0.004)
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
 * **保持しないと赤が出ない。**線形に薄めると経過 1.49 秒で不透明度 0.596 に
 * なり、`CORE_CUT` を割って芯が消える。
 */
const FIRE_HOLD_FRACTION = 0.25

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
 * 自機の全長は 17 m。カメラから 20 m は機体の少し後ろにあたる。
 */
const MIN_CAMERA_DISTANCE = 20

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
        uColor: { value: color },
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
    if (scratch.subVectors(position, cameraPosition).lengthSq() < MIN_CAMERA_DISTANCE ** 2) {
      mesh.visible = false
      return false
    }
    const depth = scratch.dot(cameraForward)
    const clamped = clampRadiusToNear(depth, radius)
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
        const fireFade = ignition * Math.min(1, remaining / FIRE_HOLD_FRACTION)
        const fireOpacity = FLARE_OPACITY * fireFade

        // 芯と暈は同じ大きさと濃さで置く。芯の側が `CORE_CUT` で内側だけ残す
        place(
          slot.core,
          world,
          FLARE_RADIUS * ignition,
          fireOpacity,
          cameraPosition,
          cameraForward,
        )
        if (
          place(
            slot.fire,
            world,
            FLARE_RADIUS * ignition,
            fireOpacity,
            cameraPosition,
            cameraForward,
          )
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
