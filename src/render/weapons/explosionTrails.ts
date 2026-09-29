import * as THREE from 'three'
import { EXPLOSION_LIFETIME, SHARD_COUNT, fireballRadius, type ExplosionSource } from '../../sim/effects'
import { FIXED_DT } from '../../sim/loop'
import { Ribbon, type RibbonParams, type RibbonSource } from '../ribbon'
import type { QualitySettings } from '../quality'

/**
 * 爆発の白い煙の尾（段 29f）。
 *
 * 参考画像の爆発は、燃える破片が散りながら白い煙の筋を長く引く。破片ごとに 1 本の
 * リボンを張る。**sim の状態は増やさない。**破片の向きと速さは `Explosion.shards` を
 * 流用し、軌道も煙の点も経過秒から毎回出す。キャプチャモードでも同じ絵になる。
 *
 * 向きは `shards` の**末尾から**使う。子の火の玉（`explosions.ts`）が先頭から使うので、
 * 同じ向きに火の玉と尾が重ならない。
 *
 * 煙は放った所に残る。点 i は i × `SECONDS_PER_POINT` 秒前に放った煙で、その時刻の
 * 破片の位置に置く。リボンは点の経過秒で濃さと太さを決めるので、古い所ほど薄く
 * 太くなる（`ribbon.ts`）。
 *
 * **爆発の組（`explosions.object`）の子にする。**node 経路では爆発を霞の後ろの
 * 別のパスで重ねるので（段 29c）、場面のパスで描くと尾が火の玉と煙に覆われ、輪郭の
 * 外に出た先だけが小さな白い塊に見えた。同じパスで描き、帯ごとに火の玉との前後を
 * 決める（`TRAIL_FRONT_ORDER`）。
 *
 * **near 面の終端は `Ribbon.update()` が必ず通す。**
 */

/** 履歴 1 本ぶんの秒数。30 Hz で煙を放つ */
export const SECONDS_PER_POINT = 4 * FIXED_DT
/** 煙を放ち続ける秒数。破片が燃え尽きる */
export const TRAIL_EMIT_SECONDS = 2.0
/**
 * 1 本の点の数。**爆発の寿命ぶん持つ。**放ち終えたあとの点は濃さ 0 で並べる。
 * 新しい端を飛ばすと、リボンは残った古い点を生まれたばかりと読んで（点の経過秒を
 * 添字から出すため）細く濃く描く
 */
const TRAIL_POINTS = Math.ceil(EXPLOSION_LIFETIME / SECONDS_PER_POINT) + 1

/**
 * 破片の減速の時定数 秒。空気抵抗で速さが指数で落ちる。
 *
 * 破片の速さは 40〜120 m/s（`effects.ts`）に `TRAIL_SPEED_SCALE` を掛ける。時定数
 * 1.2 秒なら止まるまでに 72〜216 m 飛ぶ。**最初は 0.8 秒・等倍で 32〜96 m にしたら、
 * 煙の玉（半径およそ 40 m）の外へほとんど出なかった**
 */
export const TRAIL_DRAG_TIME = 1.2
/** 破片の速さに掛ける倍率。火の玉の破片の表示（`explosions.ts`）より速く飛ばす */
export const TRAIL_SPEED_SCALE = 1.5

/**
 * 火の玉の手前に描く尾の描画順。火の層（0.5）と赤い芯（1）より後、白い芯（2）より前。
 * 奥へ向かう尾は `TRAIL_BACK_ORDER` で煙（−1）より先に描く
 */
export const TRAIL_FRONT_ORDER = 1.5
export const TRAIL_BACK_ORDER = -2

/**
 * 尾を薄くする範囲。煙の点と**いまの火の玉の中心**との距離が、いまの火の玉の半径の
 * この倍率のあいだで 0 から 1 へ上げる。**火の芯の上に白い煙を乗せない。**
 *
 * 破片が進んだ距離で見てはいけない。火の玉は機体の速度を引き継いで流れ、煙は放った
 * 所に残るので、古い煙ほど火の玉から後ろに離れる（最初の版はこれを取り違えた）
 */
export const TRAIL_ROOT_FADE = { from: 0.7, to: 1.3 }
/**
 * 破片の落ちる加速度 m/s²。**重力の 9.8 より小さい。**破片は空気抵抗で落下の速さも
 * 頭打ちになる。2 秒で 8 m 落ちる
 */
export const TRAIL_FALL = 4

/**
 * 経過 t 秒の破片の、爆発の中心からのずれ m。
 *
 * 向き × 速さ × 時定数 ×（1 − e^(−t/時定数)）で減速しながら飛び、y は落ちる。
 * 爆発の中心そのものの流れ（機体の速度を引き継ぐ）は呼ぶ側が足す
 */
export function trailOffset(
  direction: { x: number; y: number; z: number },
  speed: number,
  t: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (t <= 0) return out.set(0, 0, 0)
  const travel = trailTravel(speed, t)
  return out.set(
    direction.x * travel,
    direction.y * travel - 0.5 * TRAIL_FALL * t * t,
    direction.z * travel,
  )
}

/** 経過 t 秒に破片が向きへ進んだ距離 m */
export function trailTravel(speed: number, t: number): number {
  if (t <= 0) return 0
  return speed * TRAIL_SPEED_SCALE * TRAIL_DRAG_TIME * (1 - Math.exp(-t / TRAIL_DRAG_TIME))
}

/**
 * 尾の濃さの係数 0..1。火の玉の中（半径の `TRAIL_ROOT_FADE.from` 倍より内）は 0
 *
 * @param distance 煙の点と、いまの火の玉の中心との距離 m
 * @param radius いまの火の玉の半径 m
 */
export function trailRootFade(distance: number, radius: number): number {
  if (radius <= 0) return 1
  const x = (distance / radius - TRAIL_ROOT_FADE.from) / (TRAIL_ROOT_FADE.to - TRAIL_ROOT_FADE.from)
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

/**
 * カメラの近くで尾を薄くする範囲 m（段 29g）。煙の点とカメラとの距離がこのあいだで
 * 0 から 1 へ上げる。
 *
 * **近い撃墜で、太い白い筋がカメラの手前を横切って HUD の中央まで覆った**（段 29f の
 * `hud-mission-failed`、48,567 画素）。描き方の誤りではない（GLSL 経路の深度テストでも
 * 尾は自機より手前を通った）が、戦闘中の視界を塞ぐ
 */
export const TRAIL_CAMERA_FADE = { from: 20, to: 60 }

/** カメラとの距離 m に対する尾の濃さの係数 0..1 */
export function trailCameraFade(distance: number): number {
  const x = (distance - TRAIL_CAMERA_FADE.from) / (TRAIL_CAMERA_FADE.to - TRAIL_CAMERA_FADE.from)
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

/**
 * 煙を放つ強さ 0..1。放ち始めは強く、燃え尽きに向けて薄くする
 *
 * @param t 放った時刻（爆発からの経過秒）
 */
export function trailEmission(t: number): number {
  if (t < 0 || t > TRAIL_EMIT_SECONDS) return 0
  return 1 - t / TRAIL_EMIT_SECONDS
}

/**
 * 濃さの上限。**白い煙なので空との差が小さい。**翼端渦（0.09）やミサイルの
 * 煙（0.16）より濃くする。値は絵で決める
 */
const TRAIL_OPACITY = 0.6

const TRAIL_PARAMS: RibbonParams = {
  // 燃える破片の煙。**最初の 1.5 m・毎秒 1.5 倍・上限 6 倍は太すぎた。**見かけの長さに
  // 対して幅が勝ち、筋ではなく白い塊がとぎれとぎれに並んだ
  halfWidth: 0.9,
  spreadPerSecond: 1.0,
  spreadLimit: 4,
  // 爆発の寿命まで残す
  lifetime: EXPLOSION_LIFETIME,
  secondsPerPoint: SECONDS_PER_POINT,
  decayHold: 0.3,
  taperPoints: 6,
  taperWidthFloor: 0.2,
}

export interface ExplosionTrails {
  readonly object: THREE.Object3D
  update(
    source: ExplosionSource,
    frame: number,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: ExplosionTrails = {
  object: new THREE.Group(),
  update() {},
  setQuality() {},
  dispose() {},
}

const offset = new THREE.Vector3()
const toCamera = new THREE.Vector3()
const point = new THREE.Vector3()

/** 1 本の尾を、リボンから見て点の列に見せる */
class TrailSource implements RibbonSource {
  count = 0
  private cx = 0
  private cy = 0
  private cz = 0
  private vx = 0
  private vy = 0
  private vz = 0
  private age = 0
  private direction = { x: 0, y: 1, z: 0 }
  private speed = 0
  private strength = 0
  private radius = 0
  private camera = new THREE.Vector3()

  bind(
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    speed: number,
    strength: number,
    age: number,
    camera: THREE.Vector3,
  ): void {
    this.camera.copy(camera)
    this.cx = position.x
    this.cy = position.y
    this.cz = position.z
    this.vx = velocity.x
    this.vy = velocity.y
    this.vz = velocity.z
    this.direction = direction
    this.speed = speed
    this.strength = strength
    this.age = age
    this.radius = fireballRadius(age, strength)
    // 爆発から今までの点。放ち終えたあとの点は濃さ 0（`trailEmission`）
    this.count = Math.min(Math.floor(age / SECONDS_PER_POINT) + 1, TRAIL_POINTS)
  }

  /** 点 index を放った時刻（爆発からの経過秒） */
  private emittedAt(index: number): number {
    return this.age - index * SECONDS_PER_POINT
  }

  positionAt(index: number, out: THREE.Vector3): void {
    this.pointAt(index, out)
  }

  /** 点 index の世界座標 */
  private pointAt(index: number, out: THREE.Vector3): void {
    const t = Math.max(0, this.emittedAt(index))
    trailOffset(this.direction, this.speed, t, offset)
    // 放った時刻の爆発の中心（機体の速度を引き継いで流れる）に足す
    out.set(this.cx + this.vx * t, this.cy + this.vy * t, this.cz + this.vz * t).add(offset)
  }

  strengthAt(index: number): number {
    const t = this.emittedAt(index)
    // 煙の点と、いまの火の玉の中心（放った時刻から 経過秒 − t だけ流れた所）との距離
    trailOffset(this.direction, this.speed, Math.max(0, t), offset)
    const lag = this.age - Math.max(0, t)
    const dx = offset.x - this.vx * lag
    const dy = offset.y - this.vy * lag
    const dz = offset.z - this.vz * lag
    this.pointAt(index, point)
    return (
      trailEmission(t) *
      trailRootFade(Math.hypot(dx, dy, dz), this.radius) *
      trailCameraFade(point.distanceTo(this.camera)) *
      this.strength *
      TRAIL_OPACITY
    )
  }
}

/**
 * 尾の材質の作り手。**node 経路は差し替える。**爆発と同じ霞の後ろのパスで描くので、
 * 場面の物に隠される判定が要る（`sceneOcclusion.ts`）
 */
export type TrailMaterialFactory = () => THREE.Material

export function createGlTrailMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    // 奥行きは書かない。リボンどうしが順序で欠けるのを避ける（`missileSmoke.ts` と同じ）
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: true,
  })
}

export function createExplosionTrails(
  capacity: number,
  quality: QualitySettings,
  makeMaterial: TrailMaterialFactory = createGlTrailMaterial,
): ExplosionTrails {
  let perExplosion = quality.explosionSmokeTrails
  const most = Math.max(perExplosion, 0)
  if (most === 0) return NOT_ENABLED

  const material = makeMaterial()

  const group = new THREE.Group()
  group.frustumCulled = false

  // 器は作ったときの本数だけ持つ。プリセットが下がったら先頭から使う
  const total = capacity * most
  const ribbons = Array.from({ length: total }, () => new Ribbon(TRAIL_POINTS))
  const sources = Array.from({ length: total }, () => new TrailSource())
  const meshes = ribbons.map((ribbon) => {
    const mesh = new THREE.Mesh(ribbon.geometry, material)
    mesh.frustumCulled = false
    group.add(mesh)
    return mesh
  })
  const cameraView = { position: new THREE.Vector3(), forward: new THREE.Vector3() }

  return {
    object: group,

    update(source, frame, cameraPosition, cameraForward) {
      cameraView.position.copy(cameraPosition)
      cameraView.forward.copy(cameraForward)
      const used = Math.min(perExplosion, most)
      let r = 0
      const available = Math.min(source.length, capacity)
      for (let i = 0; i < available; i++) {
        const explosion = source.explosionAt(i)
        if (explosion.frame < 0) continue
        const age = (frame - explosion.frame) * FIXED_DT
        if (age < 0 || age >= EXPLOSION_LIFETIME) continue
        for (let k = 0; k < most; k++) {
          const ribbon = ribbons[r]!
          const trail = sources[r]!
          r++
          if (k >= used) {
            ribbon.clear()
            continue
          }
          // 末尾から使う。子の火の玉が先頭から使う
          const shard = explosion.shards[(SHARD_COUNT - 1 - k) % explosion.shards.length]!
          trail.bind(
            explosion.position,
            explosion.velocity,
            shard.direction,
            shard.speed,
            explosion.strength,
            age,
            cameraPosition,
          )
          if (trail.count < 2) {
            ribbon.clear()
            continue
          }
          ribbon.update(trail, cameraView, TRAIL_PARAMS)
          // カメラへ向かう尾は火の玉の手前、奥へ向かう尾は奥に描く
          toCamera.set(
            cameraPosition.x - explosion.position.x,
            cameraPosition.y - explosion.position.y,
            cameraPosition.z - explosion.position.z,
          )
          const d = shard.direction
          meshes[r - 1]!.renderOrder =
            d.x * toCamera.x + d.y * toCamera.y + d.z * toCamera.z > 0
              ? TRAIL_FRONT_ORDER
              : TRAIL_BACK_ORDER
        }
      }
      for (; r < ribbons.length; r++) ribbons[r]!.clear()
    },

    setQuality(next) {
      perExplosion = next.explosionSmokeTrails
      group.visible = perExplosion > 0
    },

    dispose() {
      for (const ribbon of ribbons) ribbon.dispose()
      material.dispose()
    },
  }
}
