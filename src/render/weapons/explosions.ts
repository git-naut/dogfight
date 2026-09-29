import * as THREE from 'three'
import { FIXED_DT } from '../../sim/loop'
import {
  EXPLOSION_LIFETIME,
  coreOpacity,
  fireballOpacity,
  hotCoreOpacity,
  fireballBodyOpacity,
  fireballHeat,
  fireballRadius,
  smokeOpacity,
  type ExplosionSource,
} from '../../sim/effects'
import { RIBBON_NEAR_CLIP_DEPTH } from '../ribbon'
import {
  createGlRadialSprite,
  makeRadialSprite,
  radialSpriteHandle,
  type RadialSpriteFactory,
  type RadialSpriteMaterial,
} from './radialSprite'
import type { QualitySettings } from '../quality'
import type { FireballSprite, FireballSpriteFactory, FireballState } from './fireballNodes'
import { BALL_INSET } from './fireballShape'

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

/**
 * 白く飛んだ芯の色。**露出前の値。加算で重ねる**（段 29）。
 *
 * 露出 6 倍で 1 を越えて白く飛ぶ値にする。空の線形値は 0.14〜0.18 なので、
 * 足すのは空の数倍。赤い芯（`CORE_COLOR`）の上に乗るので、縁は赤く残る
 */
const HOT_CORE_COLOR = new THREE.Color(1.2, 1.0, 0.75)

/** 白い芯の半径は火球の何倍か。赤い芯（0.55）の内側 */
const HOT_CORE_SCALE = 0.35

/**
 * 火の玉の板の半径は火球の何倍か（段 29b）。**輪郭をノイズで最大 3 割削る**
 * ので、外側の炎（0.9）より大きめに取る。
 *
 * 材質が輪郭を板の内側へ `BALL_INSET`（1.4）倍で縮めるので、その分も掛ける。
 * 見た目の大きさは縮める前の 1.2 倍のまま
 */
const FIREBALL_BODY_SCALE = 1.2 * BALL_INSET

/**
 * 冷めた火の玉がどれだけ膨らむか。熱 0 で板が `1 + この値` 倍になる。
 *
 * 煙は火が消えたあとも広がる。膨らまないと、0.5 秒以降の煙が形を保ったまま
 * 固い塊に見えた
 */
const FIREBALL_SWELL = 0.5

/**
 * 子の火の玉（段 29d、複数の球の連なり）。主の火の玉の周りに、破片の向きへ
 * 押し出して置く。**sim の状態は増やさない。**向きは `Explosion.shards[k]` を流用し、
 * 遅れと押し出しは経過秒から毎回出す。
 *
 * 参考画像の爆発は 1 つの球ではなく、火の玉がいくつも連なって膨らむ。燃料と
 * 機体の破片がばらばらの向きに散って、それぞれが燃えるため
 */
/** 子の火の玉の半径は主の何倍か */
export const BLOB_SCALE = 0.6
/** k 番目の子が火の付く遅れ 秒（k は 0 から）。`BLOB_DELAY * (k + 1)` */
export const BLOB_DELAY = 0.025
/** 押し出し切ったときの中心からの距離は、主の半径の何倍か */
export const BLOB_SPREAD = 1.0
/** 押し出しの時定数 秒。これの 3 倍でほぼ押し出し切る */
export const BLOB_PUSH_TIME = 0.1

/** k 番目の子の火の玉の経過秒。負ならまだ火が付いていない */
export function blobAge(age: number, k: number): number {
  return age - BLOB_DELAY * (k + 1)
}

/**
 * k 番目の子の火の玉の、中心からの距離 m。
 *
 * @param radius 主の火の玉の半径（`fireballRadius`）
 * @param blobSeconds `blobAge` の値
 */
export function blobOffset(radius: number, blobSeconds: number): number {
  if (blobSeconds <= 0) return 0
  return radius * BLOB_SPREAD * (1 - Math.exp(-blobSeconds / BLOB_PUSH_TIME))
}

/**
 * k 番目の子の火の玉の大きさの揺らぎ。0.8〜1.2。黄金比の端数で散らすので決定論
 */
export function blobSize(k: number): number {
  const f = ((k + 1) * 0.6180339887) % 1
  return 0.8 + 0.4 * f
}

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
// 子の火の玉の中心。**`scratch` と分ける**（`placeBall` が中で `scratch` を使う）
const blobCenter = new THREE.Vector3()

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
  // **材質の作り手を外から差す。**node 経路では `ShaderMaterial` が黙って
  // 描かれない（例外は出ない）ので、TSL 版を差し替えられる口が要る。
  // 段 17b で地形と海面に入れたのと同じ形
  sprite: RadialSpriteFactory = createGlRadialSprite,
  // **火の玉の板の作り手（段 29b）。**渡されたら赤い芯と外側の炎の代わりに
  // ノイズで輪郭の揺らぐ火の玉を置く。node 経路だけが渡す（`fireballNodes.ts`）。
  // GLSL 経路は従来の円形スプライトのまま
  fireballSprite: FireballSpriteFactory | null = null,
): Explosions {
  let sprites = quality.explosionSprites
  let blobs = quality.explosionBlobs
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
   *
   * **材質から不透明度の setter を引けるようにしておく。**`place()` は
   * メッシュしか持たないので、材質から作り手へ戻る道が要る
   */
  const radial = (
    color: THREE.Color,
    falloff: number,
    additive: boolean,
  ): RadialSpriteMaterial => makeRadialSprite(sprite, { color, falloff, additive })

  /** 火の玉 1 個。煤の層（`mesh`）と火の層（`fire`）を同じ所に置く（段 29d） */
  interface BallMeshes {
    mesh: THREE.Mesh
    fire: THREE.Mesh
    sprite: FireballSprite
  }

  /**
   * 火の玉を作る。**煤は火の玉の層（0）、火は 0.5。**全部の球の煤が先に描かれ、
   * 火はそのあと。白い芯（2）と赤い芯（1）より下
   */
  function makeBall(factory: FireballSpriteFactory): BallMeshes {
    const sprite = factory()
    const mesh = new THREE.Mesh(quad, sprite.material)
    const fire = new THREE.Mesh(quad, sprite.fireMaterial)
    for (const m of [mesh, fire]) {
      m.frustumCulled = false
      m.visible = false
      group.add(m)
    }
    mesh.renderOrder = 0
    fire.renderOrder = 0.5
    materials.push(sprite.material, sprite.fireMaterial)
    return { mesh, fire, sprite }
  }

  interface Slot {
    /** 白く飛んだ芯。加算。赤い芯の上に乗る */
    hot: THREE.Mesh
    /** 火の玉の板。作り手が渡されたときだけ。赤い芯と外側の炎の代わり */
    ball: BallMeshes | null
    /** 子の火の玉。作り手が渡されたときだけ。数は枠を作ったときの `explosionBlobs` */
    blobs: BallMeshes[]
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
    const hotMaterial = radial(HOT_CORE_COLOR, 2.0, true)
    const coreMaterial = radial(CORE_COLOR, 2.2, false)
    const fireballMaterial = radial(FIREBALL_COLOR, 1.6, false)
    const smokeMaterial = radial(SMOKE_COLOR, 0.9, false)
    const shardMaterial = radial(SHARD_COLOR, 2.4, true)
    materials.push(
      hotMaterial.material,
      coreMaterial.material,
      fireballMaterial.material,
      smokeMaterial.material,
      shardMaterial.material,
    )

    const hot = new THREE.Mesh(quad, hotMaterial.material)
    const core = new THREE.Mesh(quad, coreMaterial.material)
    const fireball = new THREE.Mesh(quad, fireballMaterial.material)
    const smoke = new THREE.Mesh(quad, smokeMaterial.material)
    // 破片は 1 個ずつ位置が違うので個別のメッシュ。数は品質で決まる
    const shards = Array.from({ length: sprites }, () => {
      const mesh = new THREE.Mesh(quad, shardMaterial.material)
      mesh.frustumCulled = false
      mesh.visible = false
      group.add(mesh)
      return mesh
    })
    for (const mesh of [hot, core, fireball, smoke]) {
      mesh.frustumCulled = false
      mesh.visible = false
      group.add(mesh)
    }
    const ball: Slot['ball'] = fireballSprite !== null ? makeBall(fireballSprite) : null
    const blobMeshes: Slot['blobs'] =
      fireballSprite !== null ? Array.from({ length: blobs }, () => makeBall(fireballSprite)) : []
    // 煙を火球の後ろに置く。火球が上に乗り、芯はいちばん上。
    // **3 層すべて通常合成なので、この順序がそのまま重なりを決める。**
    // 加算だった頃は順序が結果を変えなかった
    smoke.renderOrder = -1
    core.renderOrder = 1
    // 白い芯はいちばん上。加算なので下の赤い芯の上に光を足す
    hot.renderOrder = 2

    const made: Slot = { hot, ball, blobs: blobMeshes, core, fireball, smoke, shards }
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
    radialSpriteHandle(mesh.material as THREE.Material)!.setOpacity(opacity)
    mesh.visible = true
  }

  /** 火の玉の板を置く。向きと near 面の扱いは `place` と同じ */
  function placeBall(
    ball: NonNullable<Slot['ball']>,
    position: THREE.Vector3,
    radius: number,
    state: FireballState,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void {
    const mesh = ball.mesh
    if (state.opacity <= 0.001 || radius <= 0) {
      hideBall(ball)
      return
    }
    const depth = scratch.subVectors(position, cameraPosition).dot(cameraForward)
    const clamped = clampRadiusToNear(depth, radius)
    if (clamped <= 0) {
      hideBall(ball)
      return
    }
    mesh.position.copy(position)
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(cameraPosition, position, THREE.Object3D.DEFAULT_UP),
    )
    mesh.scale.setScalar(clamped * 2)
    ball.sprite.setState(state)
    mesh.visible = true
    // 火の層は煤の層と同じ所に置く
    ball.fire.position.copy(mesh.position)
    ball.fire.quaternion.copy(mesh.quaternion)
    ball.fire.scale.copy(mesh.scale)
    ball.fire.visible = true
  }

  function hideBall(ball: BallMeshes): void {
    ball.mesh.visible = false
    ball.fire.visible = false
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
        // **火の玉の板があれば、赤い芯と外側の炎はそちらが担う**（段 29b）
        const useBall = s.ball !== null
        if (s.ball !== null) {
          const heat = fireballHeat(age)
          placeBall(
            s.ball,
            center,
            radius * FIREBALL_BODY_SCALE * (1 + FIREBALL_SWELL * (1 - heat)),
            {
              opacity: fireballBodyOpacity(age) * explosion.strength,
              heat,
              // 爆発ごとに形を変える。起きたフレームから決めるので決定論
              seed: (explosion.frame % 997) * 0.173,
              age,
            },
            cameraPosition,
            cameraForward,
          )
          // 子の火の玉。**プリセットが下がったら先頭から使う**（枠は作ったときの数を持つ）
          const used = Math.min(blobs, s.blobs.length)
          for (let k = 0; k < s.blobs.length; k++) {
            const blob = s.blobs[k]!
            const t = blobAge(age, k)
            if (k >= used || t <= 0) {
              hideBall(blob)
              continue
            }
            const shard = explosion.shards[k % explosion.shards.length]!
            const blobHeat = fireballHeat(t)
            blobCenter
              .set(shard.direction.x, shard.direction.y, shard.direction.z)
              .multiplyScalar(blobOffset(radius, t))
              .add(center)
            placeBall(
              blob,
              blobCenter,
              radius * BLOB_SCALE * blobSize(k) * FIREBALL_BODY_SCALE * (1 + FIREBALL_SWELL * (1 - blobHeat)),
              {
                opacity: fireballBodyOpacity(t) * explosion.strength,
                heat: blobHeat,
                // 子ごとに形を変える
                seed: (explosion.frame % 997) * 0.173 + (k + 1) * 1.37,
                age: t,
              },
              cameraPosition,
              cameraForward,
            )
          }
        }
        // 不透明な芯。**通常合成なので色が残る。**加算の火球だけだと
        // 露出 6 倍と AgX で白い靄になる（実測）
        place(
          s.core,
          center,
          radius * CORE_SCALE,
          // **芯は別の不透明度。**fireballOpacity だと 0.14 秒で 0.61 に
          // なり、4 割が背景と混ざって白い靄になる（実測）
          useBall ? 0 : coreOpacity(age) * explosion.strength,
          cameraPosition,
          cameraForward,
        )
        // 白く飛んだ芯。**加算。**出始めだけ（`hotCoreOpacity`）
        place(
          s.hot,
          center,
          radius * HOT_CORE_SCALE,
          hotCoreOpacity(age) * explosion.strength,
          cameraPosition,
          cameraForward,
        )
        // 外側の炎。**加算を弱くする。**強いと芯を覆って白い靄になる
        place(
          s.fireball,
          center,
          radius * FIREBALL_SCALE,
          useBall ? 0 : fireballOpacity(age) * explosion.strength * FIREBALL_ADDITIVE,
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
        s.hot.visible = false
        if (s.ball !== null) hideBall(s.ball)
        for (const blob of s.blobs) hideBall(blob)
        s.core.visible = false
        s.fireball.visible = false
        s.smoke.visible = false
        for (const shard of s.shards) shard.visible = false
      }
      drawn = count
    },

    setQuality(next) {
      sprites = next.explosionSprites
      blobs = next.explosionBlobs
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
