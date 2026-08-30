import { FIXED_DT } from './loop'
import { Rng } from './rng'
import { Quat } from './quat'
import { Vec3 } from './vec3'
import { Aircraft, type AircraftSample, type StepOptions } from './aircraft'
import { ReplayPlayer, spawnFromSpec, type ReplayScript } from './replay'
import { Target, type TargetSample, type TargetSpec } from './target'
import { Countermeasures, type Flare } from './weapons/flare'
import { Enemy, type EnemySpec } from './enemy'
import type { Combatant } from './combatant'
import type { DamageSmokeSource } from './damage'
import { Combat } from './combat'
import {
  Catapult,
  LAUNCH_THROTTLE,
  LAUNCH_DISTANCE,
  LAUNCH_PITCH,
  type LaunchSpec,
} from './launch'
import { catapultLaunch } from './carrierDeck'
import type { InputState } from './input'
import { defaultTerrain, type Terrain } from './terrain'
import { Mission, type MissionSpec } from './mission'

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
   * ミッション。渡さなければ勝敗を判定しない。
   *
   * **自由飛行と台本の再生では要らない。**基準画像を撮る台本が制限時間で
   * 打ち切られると困るので、既定は「ミッションなし」にしてある。
   */
  mission?: MissionSpec
  /**
   * カタパルト射出。渡さなければ空中から始まる。
   *
   * **既定は「射出なし」。**基準画像を撮る台本も、性能を測る台本も、
   * 空中から始まる前提で書いてある。
   */
  launch?: LaunchSpec
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
  /**
   * 描画へ渡すフレア。自機のぶんと敵のぶんを並べる。
   *
   * **自機のフレアは追従カメラでは映りにくい。**実測で 0.7 秒で視界から
   * 抜ける（後方 23 m から前を向くカメラなので）。前方の敵が撒くぶんが
   * 絵になる。
   */
  get flares(): readonly Flare[] {
    return [
      ...this.countermeasures.flares,
      ...this.enemies.flatMap((enemy) => enemy.countermeasures.flares),
    ]
  }

  /** 交戦の処理。発射管制と当たり判定はここが持つ */
  readonly combat: Combat
  /**
   * 自機の囮。フレアを持つ。
   *
   * **敵は持たない**（Phase 6.5 の範囲）。敵の投下判断は AI の状態を
   * もう 1 つ増やすことになる。
   */
  readonly countermeasures = new Countermeasures()
  /** 地形。描画側も同じものを読んで、当たる山と見える山を一致させる */
  readonly terrain: Terrain
  /**
   * ミッション。勝敗を判定する。台本に指定がなければ null。
   *
   * **`Combat` には混ぜない。**あちらは発射管制と当たり判定で手一杯で、
   * 勝敗はさらに別の関心（`mission.ts`）
   */
  readonly mission: Mission | null

  /**
   * カタパルト。台本が射出を要求していなければ null。
   *
   * **状態は sim が持つ。**描画側に置くとキャプチャモード（`sync()` が
   * 1 回だけ）で動かない
   */
  readonly catapult: Catapult | null

  private readonly stepOptions: StepOptions
  private _frame = 0

  constructor(options: WorldOptions) {
    this.seed = options.seed
    this.rng = new Rng(options.seed)
    this.terrain = options.terrain ?? defaultTerrain()
    this.mission = options.mission ? new Mission(options.mission) : null
    this.catapult = options.launch ? new Catapult(options.launch, FIXED_DT) : null
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

    /**
     * 射出があるなら甲板の上へ移す。
     *
     * **敵を作ったあとに移す。**標的と敵の位置は自機のスポーン地点からの
     * 相対で、台本は空中の高度を書いている。先に甲板（海面から 20 m）へ
     * 移すと、敵が海面すれすれに並ぶ。
     *
     * `spawn` は高度と速度しか持たず水平位置は常に原点なので、台本側で
     * 甲板の位置を指定する手段がない。ここで移す。
     */
    /**
     * 射出がなければ時計はフレーム 0 から。
     *
     * **`update()` の自動開始に任せない。**`step()` は `_frame++` の
     * あとに `mission.update()` を呼ぶので、最初の呼び出しは frame 1 に
     * なる。1 フレームぶん短くなり、実測で `hud-mission` の基準画像が
     * 156 画素動いた（時計の数字が 1 秒ずれた）。
     */
    if (this.catapult === null) this.mission?.start(0)

    if (this.catapult !== null) {
      this.catapult.hold(this.player.position, this.player.velocity)
      // **スロットルも甲板の値にする。**`spawnFromSpec` が台本の速度から
      // トリムを求めるが、射出の台本は `speed: 0` を書く（甲板で止まって
      // いるので）。速度 0 の釣り合いは存在しない
      this.player.throttle = 0
      this.player.syncFromLaunch(this.catapult.spec.direction, LAUNCH_PITCH)
    }

    this.combat = new Combat({
      rng: this.rng,
      targets: this.combatants,
      player: this.player,
      // 敵の機銃。進めるのと当たり判定は Combat の仕事
      incoming: this.enemies.map((enemy) => enemy.gun),
      // 敵のミサイルも同じ。撃つかどうかだけ AI が決める
      incomingMissiles: this.enemies.flatMap((enemy) => enemy.missiles),
      // 自機の囮。敵のミサイルのシーカーが見る
      decoys: this.countermeasures.burning,
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
    // **フレアは機体を動かす前に進める。**投下の位置は前のステップの姿勢で
    // 決まる。動かしたあとだと、押した瞬間に見えていた位置とずれる
    this.countermeasures.step(
      FIXED_DT,
      input.deployFlare,
      this.player.position,
      this.player.velocity,
      this.player.orientation,
    )

    /**
     * カタパルト。
     *
     * **`Aircraft.step()` を呼ばない。**位置と速度を直接書く。加速の
     * 積分を 2 か所に書かないため（`launch.ts`）。
     *
     * 甲板で待っているあいだは操縦を受け付けない。押しても動かないのは
     * 演出として正しく、`fireGun` などが通ると甲板の上で撃ってしまう。
     */
    if (this.catapult !== null && this.catapult.phase !== 'airborne') {
      // **スロットルは入力をそのまま入れる。**`Aircraft.step()` を通らない
      // ので追従の時定数は掛からない。実機は全開で射出されるので、
      // HUD の THR が 0% のままだと嘘になる
      this.player.throttle = input.throttle
      if (this.catapult.phase === 'onDeck') {
        this.catapult.hold(this.player.position, this.player.velocity)
        // スロットルを開けたら射出する。**専用のキーを増やさない**
        if (input.throttle > LAUNCH_THROTTLE) this.catapult.fire(this._frame)
      } else {
        // false を返したら `airborne` へ移った。**`phase` を見に行かない。**
        // TypeScript は `else` の中で `launching` に絞り込んでいて、
        // `update()` の中で変わることを知らない
        const stillLaunching = this.catapult.update(
          this._frame,
          this.player.position,
          this.player.velocity,
        )
        // **甲板で待っている時間と射出の 2.4 秒は制限時間に入れない。**
        // 次のフレームが起点になる
        if (!stillLaunching) this.mission?.start(this._frame + 1)
      }
      this.player.syncFromLaunch(this.catapult.spec.direction, LAUNCH_PITCH)
      for (const target of this.targets) target.step(FIXED_DT)
      for (const enemy of this.enemies) enemy.step(FIXED_DT, this.player, this.rng)
      this._frame++
      return
    }

    this.player.step(input, FIXED_DT, this.stepOptions)
    for (const target of this.targets) target.step(FIXED_DT)
    for (const enemy of this.enemies) enemy.step(FIXED_DT, this.player, this.rng)
    this.combat.step(input, this.player, FIXED_DT, this._frame)
    this._frame++

    // **フレームを進めたあとに判定する。**制限時間は `frame >= limitFrames`
    // で見るので、進める前だと 1 フレーム早く切れる
    this.mission?.update({
      frame: this._frame,
      enemiesAlive: this.enemiesAlive,
      playerLosses: this.combat.losses,
      playerCrashed: this.player.crashed,
    })
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
    // 秒からフレームへ直す。判定側は整数で比べる（`mission.ts`）
    ...(script.missionSeconds !== undefined
      ? { mission: { limitFrames: Math.round(script.missionSeconds / FIXED_DT) } }
      : {}),
    // **台本に座標を書き写さない。**空母の配置と原本の座標から計算する
    ...(script.launchFrom !== undefined && script.carrier !== undefined
      ? { launch: catapultLaunch(script.carrier, script.launchFrom, LAUNCH_DISTANCE) }
      : {}),
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
