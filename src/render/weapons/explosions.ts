import * as THREE from 'three'
import { FIXED_DT } from '../../sim/loop'
import {
  EXPLOSION_LIFETIME,
  coreOpacity,
  fireballOpacity,
  fireballRadius,
  smokeOpacity,
  type ExplosionSource,
} from '../../sim/effects'
import { RIBBON_NEAR_CLIP_DEPTH } from '../ribbon'
import {
  RADIAL_SPRITE_FRAGMENT,
  RADIAL_SPRITE_VERTEX,
} from './radialSprite'
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

/**
 * 火球の色。赤い燃焼。
 *
 * **加算合成では赤が原理的に出ない。**空は全チャンネルに線形 0.1365 /
 * 0.1602 / 0.1844 を敷いている（rgb(195,201,206) の逆算）。加算は足すだけ
 * なので、G と B をその値以下にできない。赤とは「G と B が低い」ことなので
 * 届かない。AgX を node へ移植して掃引した結果（実測と ±1 階調で一致）。
 *
 * | 合成 | 最良の彩度 | 出力の比 |
 * | 加算 | 35 | 1 : 0.88 : 0.86 |
 * | 通常・不透明度 1 | 123 | 1 : 0.53 : 0.36 |
 *
 * `docs/weapons.md` の「加算では黒い煙が描けない」と同じ理屈が、赤い火にも
 * 逆向きに効く。**加算をやめて通常合成にした。**火球は不透明な高温ガスの
 * 塊なので、置き換えるほうが物理にも近い。
 *
 * 比は 1 : 0.12 : 0.03。線形 0.06〜0.25 の範囲なら彩度 117〜123 が出る。
 */
const FIREBALL_COLOR = new THREE.Color(0.18, 0.022, 0.005)

/**
 * 芯の色。
 *
 * **明るさを下げるだけでは色が戻らない。**AgX の脱色は絶対値で効くので、
 * 露出後が 1 を超えている限り白へ寄る。(0.42, 0.30, 0.12) は露出 6 倍で
 * (2.52, 1.80, 0.72) になり、出力は rgb(230,219,198)。比が 1 : 0.71 : 0.29
 * から 1 : 0.95 : 0.86 へ崩れて、彩度が 255 中 32 しか残らなかった。
 * 橙ではなくクリーム色の靄に見える。
 *
 * **露出後を 1 未満に置く。**(0.14, 0.05, 0.012) なら (0.84, 0.30, 0.072)。
 * 空より暗くなる画素が出るが、そのほうが読める。実測（285 m、`gun-pass`
 * f130、`?explosions=0` との引き算）。
 *
 * | 芯の色 | 出力 | 彩度 | 空との最大差 |
 * | (0.42, 0.30, 0.12) | rgb(230,219,198) | 32 | 35 |
 * | (0.14, 0.05, 0.012) | rgb(202,163,134) | 68 | 72 |
 * | (0.08, 0.025, 0.005) | rgb(183,142,118) | 65 | 88 |
 *
 * 1,140 m でも効く（最大差 26 → 45、彩度 27 → 45。`missile-shot` f679）。
 * **測るのは命中の 0.10 秒後。**芯は `CORE_HOLD` 0.18 秒 + 0.12 秒で
 * 0.30 秒に消えるので、f700（0.275 秒後）では芯をほぼ捉えない。
 *
 * **比も火球と揃えて 1 : 0.12 : 0.03 にした。**白熱に寄せた 1 : 0.71 : 0.29
 * では、脱色域を出ても彩度 91 で止まる。純赤の比なら 123 まで出る。実機で
 * (0.14, 0.017, 0.004) を測ったら彩度 85・rgb(206,140,121) になった
 * （火球ぶんが混ざるのでモデルの 123 より低い）。
 *
 * **赤を担えるのは芯だけ。**火球の不透明度は経過 0.10 秒で
 * `exp(-0.10/0.28)` = 0.70 が上限なので、通常合成にしても 3 割が空と混ざって
 * 彩度 44 で止まる。芯は `CORE_HOLD` のあいだ 1.0 を保つ。
 */
const CORE_COLOR = new THREE.Color(0.14, 0.017, 0.004)

/** 芯の半径は火球の何倍か。内側の締まった部分 */
const CORE_SCALE = 0.55

/*
 * 大きさと濃さは絵で決めた。285 m の爆発を `?explosions=0` との引き算で
 * 測っている（`gun-pass` f130、経過 0.14 秒、強さ 1）。
 *
 * | 段階 | 画素 | 最大階調 | 外接 |
 * | 芯なし（元の実装） | 3,377 | 47 | 66x66 |
 * | 芯を足した直後 | 2,132 | 29 | 54x50 |
 * | 芯に専用の不透明度 | 2,132 | 34 | 54x50 |
 * | 芯を 0.55 倍へ拡大 | 2,132 | 35 | 54x50 |
 * | 煙を 0.3 秒遅らせた | 1,041 | 35 | 38x37 |
 *
 * **靄の正体は煙だった。**経過 0.14 秒で不透明度 0.74、半径 24 m の灰色の
 * 膜が空を覆って火球を沈めていた。実物の爆発は火球が先で煙は後から立つ。
 */

/**
 * 外側の炎の不透明度に掛ける係数。
 *
 * 通常合成へ変えたので、これは「どれだけ空を置き換えるか」になる。1.0 でも
 * `fireballOpacity` が経過 0.10 秒で 0.70 なので、空が 3 割残る。値は絵で決める。
 */
const FIREBALL_ADDITIVE = 1.0

/** 外側の炎の半径は火球の何倍か */
const FIREBALL_SCALE = 0.9
/**
 * 煙の色。暗い灰。
 *
 * **露出 6 倍を織り込む。**0.09 では露出後 0.54 になり、空（1.0 前後）と
 * 差が付かず 15 階調しか動かなかった。0.030 なら露出後 0.18 で 27 階調。
 */
const SMOKE_COLOR = new THREE.Color(0.030, 0.028, 0.026)
/** 破片の色。火球より明るい芯 */
const SHARD_COLOR = new THREE.Color(0.30, 0.186, 0.06)

/** 破片の大きさ m */
const SHARD_SIZE = 1.6
/** 煙の半径は火球の何倍か */
const SMOKE_SCALE = 1.2

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
      vertexShader: RADIAL_SPRITE_VERTEX,
      fragmentShader: RADIAL_SPRITE_FRAGMENT,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

  interface Slot {
    /** 不透明な芯。通常合成なので色が残る */
    core: THREE.Mesh
    fireball: THREE.Mesh
    smoke: THREE.Mesh
    shards: THREE.Mesh[]
  }

  const slots: Slot[] = []
  const materials: THREE.Material[] = []

  function slot(index: number): Slot {
    const existing = slots[index]
    if (existing !== undefined) return existing

    // 火球は芯が明るく縁が締まる。煙はふわりと広がる。破片は点に近い。
    // **火球も芯も煙も通常合成。**加算は赤にならない（`FIREBALL_COLOR`）。
    // 加算のまま残すのは破片だけで、こちらは点に近い光の粒として使う
    const coreMaterial = radial(CORE_COLOR, 2.2, false)
    const fireballMaterial = radial(FIREBALL_COLOR, 1.6, false)
    const smokeMaterial = radial(SMOKE_COLOR, 0.9, false)
    const shardMaterial = radial(SHARD_COLOR, 2.4, true)
    materials.push(coreMaterial, fireballMaterial, smokeMaterial, shardMaterial)

    const core = new THREE.Mesh(quad, coreMaterial)
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
    for (const mesh of [core, fireball, smoke]) {
      mesh.frustumCulled = false
      mesh.visible = false
      group.add(mesh)
    }
    // 煙を火球の後ろに置く。火球が上に乗り、芯はいちばん上。
    // **3 層すべて通常合成なので、この順序がそのまま重なりを決める。**
    // 加算だった頃は順序が結果を変えなかった
    smoke.renderOrder = -1
    core.renderOrder = 1

    const made: Slot = { core, fireball, smoke, shards }
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
        // 不透明な芯。**通常合成なので色が残る。**加算の火球だけだと
        // 露出 6 倍と AgX で白い靄になる（実測）
        place(
          s.core,
          center,
          radius * CORE_SCALE,
          // **芯は別の不透明度。**fireballOpacity だと 0.14 秒で 0.61 に
          // なり、4 割が背景と混ざって白い靄になる（実測）
          coreOpacity(age) * explosion.strength,
          cameraPosition,
          cameraForward,
        )
        // 外側の炎。**加算を弱くする。**強いと芯を覆って白い靄になる
        place(
          s.fireball,
          center,
          radius * FIREBALL_SCALE,
          fireballOpacity(age) * explosion.strength * FIREBALL_ADDITIVE,
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
        s.core.visible = false
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
