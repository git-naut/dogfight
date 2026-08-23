import { Vec3 } from './vec3'
import type { Rng } from './rng'
import type { Aircraft, TerrainSampler } from './aircraft'
import type { Combatant } from './combatant'
import type { InputState } from './input'
import { Gun, MUZZLE_OFFSET, type Bullet, type BulletSource } from './weapons/gun'
import {
  boundingRadius,
  createHitResult,
  sweptHitsAircraft,
  type HitResult,
} from './weapons/hitbox'
import { Lock } from './weapons/lock'
import { Missile, type SmokeSource } from './weapons/missile'
import { Effects, type ExplosionSource } from './effects'
import { createDlz, solveDlz, type Dlz } from './weapons/dlz'

/**
 * 搭載するミサイルの数。
 *
 * F/A-18C のモデルには Sidewinder が 6 発付いている。同時に飛ばせる数と
 * 搭載数は別だが、Phase 5 では区別しないでプールも同じ数にする。
 */
export const MISSILE_COUNT = 6

/**
 * 発射の間隔 秒。
 *
 * 押しっぱなしで全弾が 1 フレームに出るのを防ぐ。押しっぱなしでは 1 発しか
 * 出さないので二重の歯止めになるが、離して押し直す速さには上限が要る。
 */
export const MISSILE_INTERVAL = 0.8

/** ミサイル 1 発が与えるダメージ。標的の耐久 20 を 1 発で削り切る */
const MISSILE_DAMAGE = 100

/**
 * 爆発の強さ 0..1。
 *
 * ミサイルの弾頭は 9 kg 前後（AIM-9M の公表値）で、20mm 弾 1 発とは桁が違う。
 * 撃墜そのものは同じでも、絵の大きさを変える。**どちらも選んだ値。**
 */
const KILL_BLAST = 1
const MISSILE_BLAST = 0.75

/**
 * DLZ を解き直す間隔 秒。
 *
 * 前方積分は 60 秒ぶんを 0.1 秒刻みで回すので 600 歩 × 2 通り。毎ステップ
 * （120Hz）だと無駄が大きい。0.1 秒ごとで十分で、その間に距離は 50 m しか
 * 変わらない（接近速度 490 m/s でも）。
 */
const DLZ_INTERVAL = 0.1

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
  /**
   * 撃たれる側。World が作ったものを借りる。
   *
   * 型は `Combatant` なので、計測用の `Target`（決められた軌跡を飛ぶ剛体）と
   * Phase 6 の敵機（`Aircraft` を保有する）が同じ列に並ぶ。
   */
  targets: readonly Combatant[]
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
  /** シーカーの捕捉。ミサイルの発射条件になる */
  readonly lock = new Lock()
  /**
   * DLZ。いま撃ったら当たるかを距離で示す。
   *
   * ロックしていないときは 0 のまま。HUD はロックの状態を見てから読む。
   */
  readonly dlz: Dlz = createDlz()
  /** 前回 DLZ を解いてからの経過 秒 */
  private sinceDlz = DLZ_INTERVAL
  /** 爆発。sim が「いつ・どこで・どの強さで」を持ち、描画は経過秒で絵を作る */
  readonly effects = new Effects()
  /** ミサイル。撃った順に使い、飛び終われば器を再利用する */
  readonly missiles: readonly Missile[] = Array.from(
    { length: MISSILE_COUNT },
    () => new Missile(),
  )

  /** 残ミサイル */
  missilesLeft = MISSILE_COUNT
  /** 撃ったミサイルの総数 */
  missilesFired = 0
  /** 前回の発射からの経過 秒。間隔の判定に使う */
  private sinceLaunch = MISSILE_INTERVAL
  /** 前ステップで引き金が押されていたか。押しっぱなしで連射しない */
  private missileHeld = false

  /** 命中した弾の数 */
  hits = 0
  /** 撃墜した数 */
  kills = 0

  /**
   * いまのフレーム。爆発の寿命の判定に使う。
   *
   * **経過秒を持ち回らない。**`time += dt` の積算は禁止（`CLAUDE.md`）なので、
   * 起きたフレームとの差から毎回出す。
   */
  private frame = 0

  private readonly rng: Rng
  private readonly targets: readonly Combatant[]
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
  step(input: InputState, player: Aircraft, dt: number, frame: number): void {
    this.frame = frame
    this.gun.advance(dt, this.groundLimit, this.terrain)
    this.resolveHits()
    this.fireGun(input, player, dt)

    // ロックは当たり判定のあと。落とした相手を掴み続けない
    if (player.crashed) this.lock.release()
    else {
      this.lock.step(
        player.position,
        player.velocity,
        player.orientation,
        this.targets,
        dt,
      )
    }

    this.advanceMissiles(dt)
    this.fireMissile(input, player, dt)
    this.updateDlz(player, dt)
  }

  /**
   * DLZ を解き直す。
   *
   * ロックしているときだけ。**渡すのはミサイルから見た目標の速さを組める
   * 材料で、自機との接近速度と目標の速度の両方が要る。**片方だけだと
   * 二重に数える（`dlz.ts` の説明）。
   */
  private updateDlz(player: Aircraft, dt: number): void {
    this.sinceDlz += dt
    const target = this.lockedTarget
    if (this.lock.state === 'none' || target === null) {
      this.dlz.rMax = 0
      this.dlz.rNe = 0
      this.dlz.rMin = 0
      return
    }
    if (this.sinceDlz < DLZ_INTERVAL) return
    this.sinceDlz = 0

    solveDlz(
      {
        launchSpeed: player.speed,
        altitude: player.altitude,
        targetSpeed: target.speed,
        closingSpeed: this.lock.closingSpeed,
      },
      this.dlz,
    )
  }

  /**
   * ミサイルを進めて、起爆したものを片づける。
   *
   * 相手は `targetIndex` で引く。**シーカーが見失っても添字は残す。**
   * 近接信管は失探後も働くので、判定のために相手を渡し続ける必要がある。
   */
  private advanceMissiles(dt: number): void {
    for (const missile of this.missiles) {
      if (missile.state !== 'flying') continue
      const target = this.targets[missile.targetIndex] ?? null
      if (!missile.step(dt, target) || target === null) continue

      this.hits++
      // 弾頭の炸裂。起爆した位置に出す
      this.effects.spawn(
        missile.detonation,
        missile.velocity,
        MISSILE_BLAST,
        this.frame,
        this.rng,
      )
      if (target.damage(MISSILE_DAMAGE)) {
        this.kills++
        this.effects.spawn(
          target.position,
          target.velocity,
          KILL_BLAST,
          this.frame,
          this.rng,
        )
      }
    }
  }

  /**
   * ミサイルの発射。
   *
   * ロックが立っているときだけ出す。押しっぱなしでは 1 発しか出さず、
   * 離して押し直すか間隔が空くのを待つ。
   */
  private fireMissile(input: InputState, player: Aircraft, dt: number): void {
    this.sinceLaunch += dt
    const pressed = input.fireMissile && !player.crashed
    const edge = pressed && !this.missileHeld
    this.missileHeld = pressed

    if (!edge) return
    if (this.lock.state !== 'locked') return
    if (this.missilesLeft <= 0) return
    if (this.sinceLaunch < MISSILE_INTERVAL) return

    const missile = this.missiles.find((m) => m.state !== 'flying')
    if (missile === undefined) return

    // パイロンの位置は入れていない。翼下 3 m の差は誘導に効かない
    missile.launch(player.position, player.velocity, player.orientation, this.lock.index)
    this.missilesLeft--
    this.sinceLaunch = 0
    this.missilesFired++
  }

  /** 飛んでいるミサイルの数 */
  get missilesInFlight(): number {
    let count = 0
    for (const missile of this.missiles) if (missile.state === 'flying') count++
    return count
  }

  /** 煙を読む口。描画へ渡す */
  get smokeSources(): readonly SmokeSource[] {
    return this.missiles
  }

  /** 爆発を読む口。描画へ渡す */
  get explosions(): ExplosionSource {
    return this.effects
  }

  /** 生きている爆発の数。寿命の判定はフレーム番号で行う */
  explosionsAliveAt(frame: number, fixedDt: number): number {
    return this.effects.aliveAt(frame, fixedDt)
  }

  /** 起こした爆発の総数 */
  get explosionCount(): number {
    return this.effects.explosionCount
  }

  /** ロックしている標的。捉えていなければ null */
  get lockedTarget(): Combatant | null {
    if (this.lock.index < 0) return null
    return this.targets[this.lock.index] ?? null
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
        if (target.damage(1)) {
          this.kills++
          // 撃墜の火球は機体の位置に、機体の速度を引き継いで出す
          this.effects.spawn(
            target.position,
            target.velocity,
            KILL_BLAST,
            this.frame,
            this.rng,
          )
        }
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
    this.lock.release()
    for (const missile of this.missiles) missile.reset()
    this.effects.reset()
    this.dlz.rMax = 0
    this.dlz.rNe = 0
    this.dlz.rMin = 0
    this.sinceDlz = DLZ_INTERVAL
    this.missilesLeft = MISSILE_COUNT
    this.missilesFired = 0
    this.sinceLaunch = MISSILE_INTERVAL
    this.missileHeld = false
    this.hits = 0
    this.kills = 0
  }
}

export type { Bullet }
