import { Vec3 } from './vec3'
import type { Rng } from './rng'
import { TrailRing } from './trail'

/**
 * 爆発。
 *
 * **sim が「いつ・どこで・どの強さで起きたか」を持つ。**描画は経過秒から
 * 絵を作るだけ。描画側に状態を置くとキャプチャモードでは `sync()` が 1 回
 * しか走らないので何も出ない。翼端渦の履歴を sim に置いたのと同じ理由。
 *
 * 破片の向きは `Rng` から引く。同じシードと同じ入力からは同じ絵になる。
 *
 * 固定長のリングで、寿命が尽きたら古いものから上書きする。爆発が同時に
 * 何個も起きるのは撃墜が重なったときくらいなので、8 個あれば足りる。
 */

/** 同時に持てる爆発の数 */
export const EXPLOSION_POOL = 8

/** 1 発あたりの破片の数 */
export const SHARD_COUNT = 12

/**
 * 爆発の寿命 秒。
 *
 * 火球は 0.4 秒ほどで消え、煙が数秒残る。描画側が経過秒から不透明度と
 * 大きさを決めるので、ここは長いほうに合わせる。
 */
export const EXPLOSION_LIFETIME = 3.5

/**
 * 火球が膨らみ切るまでの秒数。
 *
 * 実際の爆発は数十ミリ秒で膨らむが、それだと 120Hz でも数フレームしか
 * 映らない。見えるように伸ばした。**選んだ値。**
 */
export const FIREBALL_GROWTH = 0.35

/** 破片が飛ぶ速さの範囲 m/s。選んだ値 */
const SHARD_SPEED_MIN = 40
const SHARD_SPEED_MAX = 120

/** 破片 1 個 */
export interface Shard {
  /** 爆発の中心からの向き（単位ベクトル） */
  readonly direction: Vec3
  /** 飛ぶ速さ m/s */
  speed: number
}

/** 爆発 1 個 */
export interface Explosion {
  /** 起きた位置 */
  readonly position: Vec3
  /**
   * 起きた瞬間の速度 m/s。
   *
   * 火球は撃墜された機体の速度を引き継いで流れる。止まった球にすると、
   * 250 m/s で飛ぶ機体から爆発だけが取り残されて見える。
   */
  readonly velocity: Vec3
  /** 強さ 0..1。機銃とミサイルで変える */
  strength: number
  /** 起きたフレーム。経過秒はここから出す */
  frame: number
  /** 破片 */
  readonly shards: Shard[]
}

function createExplosion(): Explosion {
  return {
    position: new Vec3(),
    velocity: new Vec3(),
    strength: 0,
    frame: -1,
    shards: Array.from({ length: SHARD_COUNT }, () => ({
      direction: new Vec3(0, 1, 0),
      speed: 0,
    })),
  }
}

/** 爆発を読む側が要る最小限。描画は Effects の型に縛られない */
export interface ExplosionSource {
  /** 記録済みの爆発の数。生きているかは経過秒で見る */
  readonly length: number
  /** 新しい順に i 番目。0 が最新 */
  explosionAt(index: number): Explosion
}

export class Effects implements ExplosionSource {
  private readonly pool = new TrailRing<Explosion>(EXPLOSION_POOL, createExplosion)
  /** 起こした爆発の総数 */
  private spawned = 0

  explosionAt(index: number): Explosion {
    return this.pool.at(index)
  }

  /** 起こした爆発の総数 */
  get explosionCount(): number {
    return this.spawned
  }

  /**
   * いま生きている爆発の数。
   *
   * 寿命の判定はフレーム番号でやる。**経過秒を持ち回らない。**`time += dt`
   * の積算は禁止（`CLAUDE.md`）なので、起きたフレームとの差から毎回出す。
   */
  aliveAt(frame: number, fixedDt: number): number {
    let alive = 0
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool.at(i)
      if (e.frame < 0) continue
      if ((frame - e.frame) * fixedDt < EXPLOSION_LIFETIME) alive++
    }
    return alive
  }

  /** 記録済みの爆発の数。プールの大きさで頭打ち */
  get length(): number {
    return this.pool.length
  }

  /**
   * 爆発を起こす。
   *
   * @param strength 0..1。機銃の撃墜は小さく、ミサイルは大きく
   */
  spawn(position: Vec3, velocity: Vec3, strength: number, frame: number, rng: Rng): void {
    const e = this.pool.push()
    e.position.copy(position)
    e.velocity.copy(velocity)
    e.strength = strength
    e.frame = frame

    for (const shard of e.shards) {
      // 球面上に一様な向き。z を一様に取って緯度を決めるのが正しい。
      // 極角を一様に取ると極に偏る
      const z = rng.range(-1, 1)
      const angle = rng.range(0, Math.PI * 2)
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      shard.direction.set(r * Math.cos(angle), z, r * Math.sin(angle))
      shard.speed = rng.range(SHARD_SPEED_MIN, SHARD_SPEED_MAX) * (0.5 + strength * 0.5)
    }
    this.spawned++
  }

  reset(): void {
    this.pool.clear()
    this.spawned = 0
  }
}

/**
 * 火球の半径 m。
 *
 * 立ち上がりは速く、そのあとゆっくり広がる。`FIREBALL_GROWTH` までに
 * 8 割まで膨らみ、以降は寿命まで緩やかに伸びる。
 *
 * @param age 経過秒
 * @param strength 0..1
 */
export function fireballRadius(age: number, strength: number): number {
  if (age < 0) return 0
  const peak = 6 + strength * 14
  const t = Math.min(1, age / FIREBALL_GROWTH)
  // 1 − (1−t)² で立ち上げる。t=1 で 1
  const rise = 1 - (1 - t) * (1 - t)
  const late = Math.max(0, age - FIREBALL_GROWTH) * 0.6
  return peak * (0.2 + 0.8 * rise) + late
}

/**
 * 火球の不透明度 0..1。
 *
 * 膨らみ切る前は濃く、そのあと急に薄れる。煙のほうが長く残るので、
 * 描画は火球と煙を別に描く。
 *
 * @param age 経過秒
 */
export function fireballOpacity(age: number): number {
  if (age < 0) return 0
  if (age >= EXPLOSION_LIFETIME) return 0
  // 立ち上がりの 0.05 秒で 1 まで、そのあと指数で落とす
  const rise = Math.min(1, age / 0.05)
  const decay = Math.exp(-age / 0.28)
  return rise * decay
}

/**
 * 芯の不透明度 0..1。
 *
 * **火球より長く 1.0 を保つ。**芯は不透明でないと意味がない。実測で、
 * `fireballOpacity` をそのまま使うと経過 0.14 秒で 0.61 になり、4 割が
 * 背景と混ざって白い靄に見えた。
 *
 * 立ち上がりの 0.03 秒で 1 まで上げ、`CORE_HOLD` 秒はそのまま保ち、
 * そのあと急に消す。**芯が残り続けると火球より長生きして不自然になる。**
 */
export function coreOpacity(age: number): number {
  if (age < 0 || age >= EXPLOSION_LIFETIME) return 0
  const rise = Math.min(1, age / 0.03)
  if (age <= CORE_HOLD) return rise
  // 保持のあとは 0.12 秒で消す
  return Math.max(0, 1 - (age - CORE_HOLD) / 0.12)
}

/** 芯が不透明のまま保たれる秒数。**選んだ値。**絵で決める */
export const CORE_HOLD = 0.18

/**
 * 煙の不透明度 0..1。
 *
 * 火球より遅れて出て、長く残る。寿命の終わりで 0 になる。
 */
export function smokeOpacity(age: number): number {
  if (age < 0 || age >= EXPLOSION_LIFETIME) return 0
  // **火球が消えてから濃くする。**実物の爆発は火球が先で煙は後から立つ。
  // 立ち上がりを 0.15 秒にしていたら、経過 0.14 秒で不透明度 0.74 の
  // 灰色の膜（半径 24 m）が空を覆って、火球が靄に沈んでいた（実測）
  const rise = Math.min(1, Math.max(0, age - SMOKE_DELAY) / SMOKE_RISE)
  const t = age / EXPLOSION_LIFETIME
  // 寿命の終わりへ向けて smoothstep で落とす
  const fade = 1 - t * t * (3 - 2 * t)
  return rise * fade * 0.8
}

/** 煙が立ち始めるまでの秒数。火球が膨らみ切るころ */
export const SMOKE_DELAY = 0.3
/** 煙が濃さの最大へ達するまでの秒数 */
export const SMOKE_RISE = 0.5
