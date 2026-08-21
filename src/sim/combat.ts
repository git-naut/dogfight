import { Vec3 } from './vec3'
import type { Rng } from './rng'
import type { Aircraft, TerrainSampler } from './aircraft'
import type { Target } from './target'
import type { InputState } from './input'
import { Gun, MUZZLE_OFFSET, type Bullet, type BulletSource } from './weapons/gun'
import {
  boundingRadius,
  createHitResult,
  sweptHitsAircraft,
  type HitResult,
} from './weapons/hitbox'

/**
 * 交戦の処理。
 *
 * `World.step()` に発射管制と当たり判定を並べると読めなくなるので、ここへ
 * 分けてある。`World` は組み立てと呼び出しだけを持つ。
 *
 * 弾もミサイルも爆発も、状態は sim が持つ。描画は読むだけ。キャプチャモードは
 * `sync()` が 1 回しか走らないので、描画側に状態を置くと何も出ない。
 */

export interface CombatOptions {
  /** 散布に使う。同じシードからは同じ弾道になる */
  rng: Rng
  /** 標的。World が作ったものを借りる */
  targets: readonly Target[]
  /** 地形。渡さなければ海面（高度 0）で弾が消える */
  terrain?: TerrainSampler
  /**
   * この高度を下回った弾だけ地形を引く m。
   *
   * 地形の最高点でよい。全部の弾で毎ステップ双三次補間（16 タップ）を払うのは
   * 無駄で、Phase 3.5 で海面の板が同じ無駄をしていた。
   */
  groundLimit: number
}

// 一時変数。使い回してゴミを出さない
const muzzle = new Vec3()
const nose = new Vec3()
const right = new Vec3()
const up = new Vec3()
const toTarget = new Vec3()
const midpoint = new Vec3()
const hit: HitResult = createHitResult()

export class Combat {
  readonly gun = new Gun()

  /** 命中した弾の数 */
  hits = 0
  /** 撃墜した数 */
  kills = 0

  private readonly rng: Rng
  private readonly targets: readonly Target[]
  private readonly terrain: TerrainSampler | undefined
  private readonly groundLimit: number
  /**
   * 機体の当たり判定の外接半径 m。粗い早期打ち切りに使う。
   *
   * **module スコープで `boundingRadius()` を呼んではいけない。**vitest の
   * node 環境では通るが、バンドラがモジュールの評価順を変えると
   * `AIRCRAFT_CAPSULES` の初期化前に読んで
   * `Cannot access 'm' before initialization` で起動ごと落ちる。実際に踏んだ。
   * **単体テストは 514 件すべて通ったまま、ビルドした本番だけが死ぬ。**
   */
  private readonly hitBound = boundingRadius()

  constructor(options: CombatOptions) {
    this.rng = options.rng
    this.targets = options.targets
    this.terrain = options.terrain
    this.groundLimit = options.groundLimit
  }

  /** 生きている標的の数 */
  get targetsAlive(): number {
    let alive = 0
    for (const target of this.targets) if (target.alive) alive++
    return alive
  }

  /**
   * 1 ステップ進める。
   *
   * 順番に意味がある。**先に弾を進めてから当たり判定を取る。**発射と同じ
   * ステップで判定すると、銃口の位置にいる標的にしか当たらない。
   */
  step(input: InputState, player: Aircraft, dt: number): void {
    this.gun.advance(dt, this.groundLimit, this.terrain)
    this.resolveHits()
    this.fireGun(input, player, dt)
  }

  /** 発射。機体の姿勢から銃口の位置と向きを出す */
  private fireGun(input: InputState, player: Aircraft, dt: number): void {
    if (player.crashed) {
      this.gun.fire(dt, false, muzzle, nose, right, up, player.velocity, this.rng)
      return
    }
    player.orientation.forward(nose)
    player.orientation.right(right)
    player.orientation.up(up)
    player.orientation.rotate(MUZZLE_OFFSET, muzzle)
    muzzle.add(player.position)

    this.gun.fire(dt, input.fireGun, muzzle, nose, right, up, player.velocity, this.rng)
  }

  /**
   * 弾と標的の当たり判定。
   *
   * 総当たりの前に球で弾く。弾の線分の中点から標的までの距離が
   * 「外接半径 + 線分の半分」を超えていればカプセルを見るまでもない。
   */
  private resolveHits(): void {
    for (let i = 0; i < this.gun.bulletCapacity; i++) {
      const bullet = this.gun.bulletAt(i)
      if (bullet.life <= 0) continue

      midpoint.copy(bullet.previous).lerp(bullet.position, 0.5)
      const half = bullet.previous.distanceTo(bullet.position) * 0.5
      const reach = this.hitBound + half

      for (const target of this.targets) {
        if (!target.alive) continue
        if (toTarget.subVectors(target.position, midpoint).lengthSq() > reach * reach) {
          continue
        }
        sweptHitsAircraft(
          bullet.previous,
          bullet.position,
          target.position,
          target.orientation,
          0,
          undefined,
          hit,
        )
        if (!hit.hit) continue

        this.hits++
        // 20mm 弾 1 発で耐久 1
        if (target.damage(1)) this.kills++
        // 当たった弾は消える。貫通させない
        bullet.life = 0
        break
      }
    }
  }

  /** 弾を読む口。描画へ渡す */
  get bullets(): BulletSource {
    return this.gun
  }

  /** 生きている弾の数 */
  get bulletsInFlight(): number {
    return this.gun.bulletsInFlight
  }

  /** 残弾 */
  get rounds(): number {
    return this.gun.rounds
  }

  /** 撃った弾の総数 */
  get roundsFired(): number {
    return this.gun.roundsFired
  }

  reset(): void {
    this.gun.reset()
    this.hits = 0
    this.kills = 0
  }
}

export type { Bullet }
