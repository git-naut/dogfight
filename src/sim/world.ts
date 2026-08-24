import { FIXED_DT } from './loop'
import { Rng } from './rng'
import { Quat } from './quat'
import { Vec3 } from './vec3'
import { Aircraft, type AircraftSample, type StepOptions } from './aircraft'
import { ReplayPlayer, spawnFromSpec, type ReplayScript } from './replay'
import { Target, type TargetSample, type TargetSpec } from './target'
import { Enemy, type EnemySpec } from './enemy'
import type { Combatant } from './combatant'
import type { DamageSmokeSource } from './damage'
import { Combat } from './combat'
import type { InputState } from './input'
import { defaultTerrain, type Terrain } from './terrain'

export type { InputState } from './input'
export { neutralInput, makeInput } from './input'

export interface WorldOptions {
  /** 乱数シード。同じシードと同じ入力からは常に同じ結果が出る。 */
  seed: number
  /** 自機の初期状態。省略すると高度 1500 m を 250 m/s で水平飛行 */
  aircraft?: {
    position?: Vec3
    velocity?: Vec3
    orientation?: Quat
    throttle?: number
  }
  step?: StepOptions
  /**
   * 標的機の配置。自機のスポーン地点からの相対。
   *
   * 飛行モデルは載せず、決められた軌跡を飛ぶ剛体として扱う。弾道や DLZ や
   * 視線回転率を測る台本はこちらを使う。相手が勝手に機動しないほうが読める。
   */
  targets?: TargetSpec[]
  /**
   * 敵機の配置。自機のスポーン地点からの相対。
   *
   * こちらは `Aircraft` を持つので失速も墜落もする。空戦の台本はこちら。
   */
  enemies?: EnemySpec[]
  /**
   * 地形。省略すると共有の既定地形を使う。
   *
   * 地形のシードはワールドのシードとは分けて固定してある。スクリプトごとに
   * 地形が変わると、スクリーンショット回帰で「同じ入力から同じピクセル」を
   * 見ている意味が薄れる。
   */
  terrain?: Terrain
}

/** 既定の初期条件。高度 1500 m、真北（-Z）へ 250 m/s。 */
export const DEFAULT_SPAWN = {
  altitude: 1500,
  speed: 250,
} as const

/**
 * シミュレーション世界。
 *
 * 自機と標的機を持つ。武装（弾・ミサイル・爆発）は Phase 5 の後続の段で
 * `Combat` としてここにぶら下げる。`step()` が並べる処理を増やしすぎない。
 */
export class World {
  readonly rng: Rng
  readonly seed: number
  readonly player: Aircraft
  /** 標的機。台本に配置が書かれていなければ空 */
  readonly targets: readonly Target[]
  /** 敵機。台本に配置が書かれていなければ空 */
  readonly enemies: readonly Enemy[]
  /**
   * 撃たれる側の全部。標的機と敵機を 1 本の列に並べたもの。
   *
   * **`Combat` はこれを見る。**弾もロックもミサイルも、相手が剛体か
   * 飛行モデル付きかを区別しない。添字はこの列の順で、標的機が先に来る。
   */
  readonly combatants: readonly Combatant[]
  /** 交戦の処理。発射管制と当たり判定はここが持つ */
  readonly combat: Combat
  /** 地形。描画側も同じものを読んで、当たる山と見える山を一致させる */
  readonly terrain: Terrain

  private readonly stepOptions: StepOptions
  private _frame = 0

  constructor(options: WorldOptions) {
    this.seed = options.seed
    this.rng = new Rng(options.seed)
    this.terrain = options.terrain ?? defaultTerrain()
    // 地形は毎ステップ Aircraft が引くので stepOptions に混ぜて渡す
    this.stepOptions = { ...(options.step ?? {}), terrain: this.terrain }

    const spawn = options.aircraft ?? {}
    this.player = new Aircraft({
      position: spawn.position ?? new Vec3(0, DEFAULT_SPAWN.altitude, 0),
      velocity: spawn.velocity ?? new Vec3(0, 0, -DEFAULT_SPAWN.speed),
      ...(spawn.orientation ? { orientation: spawn.orientation } : {}),
      ...(spawn.throttle !== undefined ? { throttle: spawn.throttle } : {}),
    })

    // 標的と敵の位置は自機のスポーン地点からの相対。自機を作ったあとに読む
    this.targets = (options.targets ?? []).map(
      (spec) => new Target(spec, this.player.position),
    )
    this.enemies = (options.enemies ?? []).map(
      (spec) => new Enemy(spec, this.player.position, this.stepOptions),
    )
    this.combatants = [...this.targets, ...this.enemies]

    this.combat = new Combat({
      rng: this.rng,
      targets: this.combatants,
      player: this.player,
      // 敵の機銃。進めるのと当たり判定は Combat の仕事
      incoming: this.enemies.map((enemy) => enemy.gun),
      terrain: this.terrain,
      // 地形の最高点より上では、弾が地面を引く必要がない
      groundLimit: this.terrain.stats.max,
    })
  }

  get frame(): number {
    return this._frame
  }

  /**
   * シム内の経過秒。
   *
   * time += dt と積算せず、毎回 frame から計算し直す。浮動小数点の
   * 加算を何万回も繰り返すと誤差が蓄積して、同じフレーム数でも実行ごとに
   * 時刻がずれる。掛け算1回なら誤差は乗らない。
   */
  get time(): number {
    return this._frame * FIXED_DT
  }

  /** 1ステップ進める。呼び出しは必ず FixedStepDriver 経由にする。 */
  step(input: InputState): void {
    this.player.step(input, FIXED_DT, this.stepOptions)
    for (const target of this.targets) target.step(FIXED_DT)
    for (const enemy of this.enemies) enemy.step(FIXED_DT, this.player, this.rng)
    this.combat.step(input, this.player, FIXED_DT, this._frame)
    this._frame++
  }

  /** 描画用に補間した自機の状態を書き込む。 */
  samplePlayer(alpha: number, out: AircraftSample): AircraftSample {
    return this.player.sample(alpha, out)
  }

  /**
   * 描画用に補間した標的機の状態を書き込む。
   *
   * 器は呼び出し側が使い回す。標的の数だけ渡すこと。
   */
  sampleTargets(alpha: number, out: TargetSample[]): void {
    for (let i = 0; i < this.targets.length && i < out.length; i++) {
      this.targets[i]!.sample(alpha, out[i]!)
    }
  }

  /**
   * 描画用に補間した敵機の状態を書き込む。
   *
   * 敵は `Aircraft` を持つので器も `AircraftSample`。自機と同じ形なので、
   * 舵面も軌跡も同じ経路で描ける。
   */
  sampleEnemies(alpha: number, out: AircraftSample[]): void {
    for (let i = 0; i < this.enemies.length && i < out.length; i++) {
      this.enemies[i]!.sample(alpha, out[i]!)
    }
  }

  /**
   * ダメージの煙を読む口。描画へ渡す。
   *
   * 生きている敵だけではなく全機ぶん返す。落ちた機の煙もしばらく残る。
   */
  get damageSmokeSources(): readonly DamageSmokeSource[] {
    return this.enemies.map((enemy) => enemy.smoke)
  }

  /** 生きている敵機の数 */
  get enemiesAlive(): number {
    let alive = 0
    for (const enemy of this.enemies) if (enemy.alive) alive++
    return alive
  }
}

/** 入力スクリプトの初期条件から World を作り、再生器と組にして返す。 */
export function createWorldFromScript(script: ReplayScript): {
  world: World
  player: ReplayPlayer
} {
  const spawn = spawnFromSpec(script.spawn)
  const world = new World({
    seed: script.seed,
    aircraft: {
      position: spawn.position,
      velocity: spawn.velocity,
      orientation: spawn.orientation,
      throttle: spawn.throttle,
    },
    ...(script.targets ? { targets: script.targets } : {}),
    ...(script.enemies ? { enemies: script.enemies } : {}),
  })
  return { world, player: new ReplayPlayer(script) }
}

/**
 * スクリプトを指定フレーム数だけ再生した World を返す。
 *
 * 実時間を使わないので、テストからもキャプチャモードからも同じ結果になる。
 */
export function runScript(script: ReplayScript, frames: number): World {
  const { world, player } = createWorldFromScript(script)
  for (let i = 0; i < frames; i++) {
    world.step(player.at(i))
  }
  return world
}
