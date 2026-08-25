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

/** 火の玉の色。マグネシウムの炎は白に近い黄 */
const FLARE_COLOR = new THREE.Color(1, 0.86, 0.55)
/** 煙の色。燃え残りの灰 */
const SMOKE_COLOR = new THREE.Color(0.55, 0.5, 0.46)

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
export const FLARE_OPACITY = 0.55

/** 煙の濃さ。通常合成。**火より効くので薄くする**（上の実測） */
const SMOKE_OPACITY = 0.12

/**
 * 燃え始めの立ち上がりに使う秒数。
 *
 * 点火の瞬間に最大の明るさで出ると唐突に見える。短く膨らませる。
 */
const IGNITION_SECONDS = 0.15

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
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

  interface Slot {
    fire: THREE.Mesh
    smoke: THREE.Mesh
  }

  const materials: THREE.Material[] = []
  const slots: Slot[] = Array.from({ length: capacity }, () => {
    // 火は芯が明るく縁が締まる。煙はふわりと広がる
    const fireMaterial = radial(FLARE_COLOR, 1.8, true)
    const smokeMaterial = radial(SMOKE_COLOR, 0.9, false)
    materials.push(fireMaterial, smokeMaterial)

    const fire = new THREE.Mesh(quad, fireMaterial)
    const smoke = new THREE.Mesh(quad, smokeMaterial)
    fire.frustumCulled = false
    smoke.frustumCulled = false
    fire.visible = false
    smoke.visible = false
    // 煙を先に描く。火が上に乗る
    group.add(smoke)
    group.add(fire)
    return { fire, smoke }
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

        if (
          place(
            slot.fire,
            world,
            FLARE_RADIUS * ignition,
            FLARE_OPACITY * fade,
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
