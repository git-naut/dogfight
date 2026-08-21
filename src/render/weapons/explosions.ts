import * as THREE from 'three'
import { FIXED_DT } from '../../sim/loop'
import {
  EXPLOSION_LIFETIME,
  fireballOpacity,
  fireballRadius,
  smokeOpacity,
  type ExplosionSource,
} from '../../sim/effects'
import { RIBBON_NEAR_CLIP_DEPTH } from '../ribbon'
import type { QualitySettings } from '../quality'

/**
 * 爆発。
 *
 * 状態は sim が持つ（`Effects`）。ここは経過秒から絵を作るだけ。描画側に
 * 状態を置くとキャプチャモードでは `sync()` が 1 回しか走らないので何も
 * 出ない。翼端渦の履歴を sim に置いたのと同じ理由。
 *
 * 火球・煙・破片の 3 層で描く。どれもカメラを向いたビルボード。
 *
 * **板をそのまま描いてはいけない。**最初にそうしたら、四角い半透明の板が
 * そのまま画面に出た。ビルボードは中心から縁へ向かって減衰させて初めて
 * 球や煙に見える。テクスチャを持たずシェーダで済ませる（画像の調達も
 * 焼き込みも要らない）。
 *
 * **経過秒はフレーム番号から出す。**`time += dt` の積算は禁止（`CLAUDE.md`）。
 * 起きたフレームとの差に固定ステップを掛ける。
 *
 * ## near 面
 *
 * ビルボードは常にカメラを向くので、リボンのような断面は出ない。ただし
 * **矩形が near 面（`scene.ts` の 5 m）を跨ぐと切れる。**至近で撃墜すると
 * 半径 20 m の火球がカメラを包むので、実際に起きる。
 *
 * 中心の視線深度が `閾値 + 半径` を割ったら半径を絞る。カメラに近いほど
 * 小さくして、跨がせない。**淡くするだけでは足りない**という翼端渦で
 * 実測した性質があるので、大きさそのものを変える。
 */

/** 火球の色。橙から黄 */
const FIREBALL_COLOR = new THREE.Color(1.0, 0.42, 0.1)
/** 煙の色。暗い灰 */
const SMOKE_COLOR = new THREE.Color(0.09, 0.085, 0.08)
/** 破片の色。火球より明るい芯 */
const SHARD_COLOR = new THREE.Color(1.0, 0.62, 0.2)

/** 破片の大きさ m */
const SHARD_SIZE = 1.6
/** 煙の半径は火球の何倍か */
const SMOKE_SCALE = 1.5

export interface Explosions {
  readonly object: THREE.Object3D
  /** 描いた爆発の数 */
  readonly drawn: number
  /**
   * 爆発を描き直す。毎フレーム呼ぶ。
   *
   * @param frame sim のフレーム番号。経過秒をここから出す
   * @param cameraPosition カメラの位置
   * @param cameraForward 視線方向の単位ベクトル。near 面の判定に使う
   */
  update(
    source: ExplosionSource,
    frame: number,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: Explosions = {
  object: new THREE.Group(),
  drawn: 0,
  update() {},
  setQuality() {},
  dispose() {},
}

// 使い回す。毎フレーム作らない
const center = new THREE.Vector3()
const scratch = new THREE.Vector3()

/**
 * near 面を跨がない半径を返す。
 *
 * 中心の深度が `閾値 + 半径` を割ったら、跨がない大きさまで絞る。深度が
 * 閾値そのものを割ったら 0（描かない）。
 */
export function clampRadiusToNear(depth: number, radius: number): number {
  if (depth <= RIBBON_NEAR_CLIP_DEPTH) return 0
  return Math.min(radius, depth - RIBBON_NEAR_CLIP_DEPTH)
}

export function createExplosions(
  capacity: number,
  quality: QualitySettings,
): Explosions {
  let sprites = quality.explosionSprites
  if (sprites === 0) return NOT_ENABLED

  const group = new THREE.Group()
  // 爆発は機体の周りで起きる。視錐台で捨てられると消える
  group.frustumCulled = false

  // 板は 1 枚だけ作って全部で共有する。ビルボードなので向きは毎フレーム決める
  const quad = new THREE.PlaneGeometry(1, 1)

  /**
   * 中心から縁へ減衰する板。
   *
   * `falloff` が大きいほど縁が締まる。火球は芯が明るいので大きく、煙は
   * ふわりと広がるので小さくする。UV の中心からの距離で切るだけなので、
   * テクスチャは要らない。
   */
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
          // 中心からの距離。0.5 で縁
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
    fireball: THREE.Mesh
    smoke: THREE.Mesh
    shards: THREE.Mesh[]
  }

  const slots: Slot[] = []
  const materials: THREE.Material[] = []

  function slot(index: number): Slot {
    const existing = slots[index]
    if (existing !== undefined) return existing

    // 火球は芯が明るく縁が締まる。煙はふわりと広がる。破片は点に近い
    const fireballMaterial = radial(FIREBALL_COLOR, 1.6, true)
    const smokeMaterial = radial(SMOKE_COLOR, 0.9, false)
    const shardMaterial = radial(SHARD_COLOR, 2.4, true)
    materials.push(fireballMaterial, smokeMaterial, shardMaterial)

    const fireball = new THREE.Mesh(quad, fireballMaterial)
    const smoke = new THREE.Mesh(quad, smokeMaterial)
    // 破片は 1 個ずつ位置が違うので個別のメッシュ。数は品質で決まる
    const shards = Array.from({ length: sprites }, () => {
      const mesh = new THREE.Mesh(quad, shardMaterial)
      mesh.frustumCulled = false
      mesh.visible = false
      group.add(mesh)
      return mesh
    })
    for (const mesh of [fireball, smoke]) {
      mesh.frustumCulled = false
      mesh.visible = false
      group.add(mesh)
    }
    // 煙を火球の後ろに置く。加算の火球が上に乗る
    smoke.renderOrder = -1

    const made: Slot = { fireball, smoke, shards }
    slots[index] = made
    return made
  }

  let drawn = 0

  /** ビルボードを置く。カメラを向け、near 面を跨がない大きさにする */
  function place(
    mesh: THREE.Mesh,
    position: THREE.Vector3,
    radius: number,
    opacity: number,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void {
    if (opacity <= 0.001 || radius <= 0) {
      mesh.visible = false
      return
    }
    const depth = scratch.subVectors(position, cameraPosition).dot(cameraForward)
    const clamped = clampRadiusToNear(depth, radius)
    if (clamped <= 0) {
      mesh.visible = false
      return
    }
    mesh.position.copy(position)
    // ビルボード。カメラの向きをそのまま使う（視線に垂直な板）
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(cameraPosition, position, THREE.Object3D.DEFAULT_UP),
    )
    mesh.scale.setScalar(clamped * 2)
    const material = mesh.material as THREE.ShaderMaterial
    material.uniforms['uOpacity']!.value = opacity
    mesh.visible = true
  }

  return {
    object: group,

    get drawn() {
      return drawn
    },

    update(source, frame, cameraPosition, cameraForward) {
      let count = 0
      const available = Math.min(source.length, capacity)

      for (let i = 0; i < available; i++) {
        const explosion = source.explosionAt(i)
        if (explosion.frame < 0) continue
        const age = (frame - explosion.frame) * FIXED_DT
        if (age < 0 || age >= EXPLOSION_LIFETIME) continue

        const s = slot(count)
        // 火球は機体の速度を引き継いで流れる。止めると 250 m/s で飛ぶ機体から
        // 取り残されて見える
        center
          .set(explosion.position.x, explosion.position.y, explosion.position.z)
          .addScaledVector(
            scratch.set(
              explosion.velocity.x,
              explosion.velocity.y,
              explosion.velocity.z,
            ),
            age,
          )

        const radius = fireballRadius(age, explosion.strength)
        place(
          s.fireball,
          center,
          radius,
          fireballOpacity(age) * explosion.strength,
          cameraPosition,
          cameraForward,
        )
        place(
          s.smoke,
          center,
          radius * SMOKE_SCALE,
          smokeOpacity(age) * explosion.strength,
          cameraPosition,
          cameraForward,
        )

        // 破片。中心から放射状に飛ぶ
        const shardOpacity = fireballOpacity(age) * 0.8
        for (let k = 0; k < s.shards.length; k++) {
          const shard = explosion.shards[k % explosion.shards.length]!
          scratch
            .set(shard.direction.x, shard.direction.y, shard.direction.z)
            .multiplyScalar(shard.speed * age)
            .add(center)
          place(
            s.shards[k]!,
            scratch,
            SHARD_SIZE * explosion.strength,
            shardOpacity,
            cameraPosition,
            cameraForward,
          )
        }
        count++
      }

      // 余った枠は隠す
      for (let i = count; i < slots.length; i++) {
        const s = slots[i]!
        s.fireball.visible = false
        s.smoke.visible = false
        for (const shard of s.shards) shard.visible = false
      }
      drawn = count
    },

    setQuality(next) {
      sprites = next.explosionSprites
      group.visible = sprites > 0
    },

    dispose() {
      quad.dispose()
      for (const material of materials) material.dispose()
      group.clear()
      slots.length = 0
    },
  }
}
