import { Vec3 } from './vec3'
import { Quat } from './quat'
import { airDensity } from './isa'
import { trimCondition } from './flightModel'
import { Aircraft, type AircraftSample, type StepOptions } from './aircraft'
import { AIRCRAFT_INTENSITY } from './combatant'
import type { Combatant, Tracked } from './combatant'
import { FighterAi, type AiState } from './ai/fighter'
import { Gun, ENEMY_BULLET_POOL, MUZZLE_OFFSET } from './weapons/gun'
import { Missile } from './weapons/missile'
import { Countermeasures } from './weapons/flare'
import { ENEMY_MISSILE_COUNT, MISSILE_INTERVAL_SECONDS } from './ai/fighter'
import type { Rng } from './rng'
import { DamageSmoke, damageControl, damageSmoke } from './damage'

/**
 * 敵機。
 *
 * **`Aircraft` を保有する。継承しない。**継承すると AI の状態が飛行状態と
 * 混ざり、`AircraftSample` の意味も曖昧になる。撃たれる側としての口は
 * `Combatant` で、飛ばすための口は `aircraft` 越しに触る。
 *
 * `Target`（決められた軌跡を飛ぶ剛体）との違いは、失速もするし墜落もする
 * ところ。**引きすぎれば速度を失い、低空で引けば地面に当たる。**「旋回すると
 * 速度が落ちる」という空戦の核が敵の挙動に出るのはこれのおかげで、代わりに
 * 「AI が自滅しない」ことを検証しないといけなくなる。
 *
 * 操縦は `FighterAi` が決める。`decide()` が返す `InputState` を毎ステップ
 * `Aircraft.step` へ渡す。**接続点は自機と同じ。**
 */

/**
 * 敵機の耐久。20mm 弾 1 発を 1 とする。
 *
 * 標的機（`TARGET_INTEGRITY` = 60）と同じ値から始める。手ごたえの調整は
 * 敵が撃ち返してくるようになってから、決着時間を測って決める。
 */
export const ENEMY_INTEGRITY = 60

/** 敵機の初期条件。台本に数値だけで書けるようにする */
export interface EnemySpec {
  /** 自機のスポーン地点からの相対初期位置 m。前方が −Z、右が +X、上が +Y */
  offset: Vec3
  /** 対気速度 m/s */
  speed: number
  /**
   * 機首方位 rad。0 が自機と同じ向き（−Z）、正が右回り。
   *
   * 真後ろから追わせるなら 0、正面から来させるなら π。
   */
  heading?: number
  /**
   * 初期の耐久。省略すると満タン（`ENEMY_INTEGRITY`）。
   *
   * **傷ついた状態から始めたい台本のために持つ。**煙や舵の効きの低下を絵で
   * 見るのに、毎回うまく当てるのを待つのは当てにならない。実測で、後方
   * 260 m から 0.35 秒撃っても 1 発も当たらなかった（機首が迎角ぶん上を
   * 向くので弾が 7 m 上を通る）。
   */
  integrity?: number
  /**
   * 積むミサイルの数。省略すると `ENEMY_MISSILE_COUNT`。
   *
   * **0 を渡せば機銃だけの敵になる。**機銃の挙動を測る台本とテストは、
   * ミサイルが混ざると読めない。実測で、1,500 m から始めると敵は開始
   * 直後に撃ち、6 秒で自機が落ちた。機銃は 1 発も出ていない。
   */
  missiles?: number
  /**
   * 積むフレアの数。省略すると `FLARE_CAPACITY`。
   *
   * **0 を渡せば撒かない敵になる。**回避に入るとフレアを撒くので、煙や
   * 曳光弾を見る台本では絵に混ざる。実測で `damage-smoke` の基準画像が
   * 1,250 画素動いた。
   */
  flares?: number
}

/** 世界の上方向。方位はこの軸まわり */
const WORLD_UP = new Vec3(0, 1, 0)

// 発射のたびに使う一時変数。使い回してゴミを出さない
const muzzle = new Vec3()
const nose = new Vec3()
const right = new Vec3()
const up = new Vec3()
/** 機体座標の右方向。迎角はこの軸まわり */
const BODY_RIGHT = new Vec3(1, 0, 0)

export class Enemy implements Combatant {
  /** 熱の強さ。機体の排気を 1 とする */
  readonly intensity = AIRCRAFT_INTENSITY

  readonly aircraft: Aircraft
  integrity: number

  readonly ai = new FighterAi()
  /**
   * 機銃。**弾を進めるのと当たり判定は `Combat` の仕事。**ここは撃つだけ。
   *
   * プールは自機の 272 より小さい 160。敵は連射しないので足りる。
   */
  readonly gun = new Gun(ENEMY_BULLET_POOL)
  /**
   * ダメージの煙の履歴。
   *
   * 描画が読む。**傷ついていないあいだも記録する。**濃さ 0 の点が並ぶので、
   * 描画側はそこを先細りの起点にできる。止めると、傷ついた瞬間に古い位置から
   * 現在まで 1 本の直線が張られる。
   */
  readonly smoke = new DamageSmoke()
  /**
   * ミサイル。**進めるのと当たり判定は `Combat` の仕事。**ここは撃つだけ。
   *
   * 機銃と同じ作法。弾の物理を 2 か所に書くと、抗力や地形の扱いが片方
   * だけ直る（`docs/decisions/0007-enemy.md`）。
   */
  /**
   * 囮。**自機のミサイルを外すために撒く。**
   *
   * 当初は「敵はフレアを持たない」と決めていたが、実測で覆した。自機の
   * フレアは追従カメラ（後方 23 m から前を向く）では 0.7 秒で視界から
   * 抜ける。旋回しても視線角 155〜173 度のままで映らない。**絵の見張りを
   * 作れない。**前方の敵が撒くフレアなら正面に写る。
   */
  readonly countermeasures: Countermeasures

  readonly missiles: readonly Missile[]
  /** 残りのミサイル */
  missilesLeft: number
  /** 撃った総数。テストと計器が読む */
  missilesFired = 0
  /** 前回の発射からの経過 秒 */
  private sinceLaunch = MISSILE_INTERVAL_SECONDS

  /** トリムのスロットル。AI が全開にしないときの下地 */
  private readonly trimThrottle: number
  private readonly stepOptions: StepOptions & { controlFactor?: number }

  constructor(spec: EnemySpec, origin: Vec3, options: StepOptions = {}) {
    this.stepOptions = { ...options }

    const position = new Vec3().copy(origin).add(spec.offset)
    const heading = spec.heading ?? 0
    // 水平定常飛行のトリム。開始直後に沈んだり浮いたりしない
    const { alpha, throttle } = trimCondition(spec.speed, airDensity(position.y))

    // 方位ぶん回した −Z が進行方向。右ヨーは +Y まわりの負回転
    const orientation = new Quat().setFromAxisAngle(WORLD_UP, -heading)
    const velocity = new Vec3()
    orientation.forward(velocity)
    velocity.multiplyScalar(spec.speed)
    // 機首は速度より迎角ぶん上を向く
    orientation.multiply(new Quat().setFromAxisAngle(BODY_RIGHT, alpha))

    this.aircraft = new Aircraft({ position, velocity, orientation, throttle })
    this.trimThrottle = throttle
    this.integrity = spec.integrity ?? ENEMY_INTEGRITY

    const missileCount = spec.missiles ?? ENEMY_MISSILE_COUNT
    this.missiles = Array.from({ length: missileCount }, () => new Missile())
    this.missilesLeft = missileCount
    this.countermeasures = new Countermeasures(spec.flares)
  }

  get position(): Vec3 {
    return this.aircraft.position
  }

  get velocity(): Vec3 {
    return this.aircraft.velocity
  }

  get orientation(): Quat {
    return this.aircraft.orientation
  }

  get speed(): number {
    return this.aircraft.speed
  }

  /** 高度 m（海抜） */
  get altitude(): number {
    return this.aircraft.altitude
  }

  /** 残りの耐久の割合 0..1 */
  get integrityRatio(): number {
    return Math.max(0, this.integrity) / ENEMY_INTEGRITY
  }

  /** 煙の濃さ 0..1。耐久の割合から決まる */
  get smokeStrength(): number {
    return this.alive ? damageSmoke(this.integrityRatio) : 0
  }

  /**
   * 生きているか。
   *
   * **墜落も撃墜と同じに扱う。**AI が地面に当たったら、そこから先は的として
   * 数えない。ロックも当たり判定も外れる。
   */
  get alive(): boolean {
    return this.integrity > 0 && !this.aircraft.crashed
  }

  /**
   * ダメージを与える。落ちた瞬間だけ true を返す。
   *
   * 落ちたあとの弾で撃墜数を二重に数えないため、返り値で遷移を見分ける。
   * すでに墜落しているものへ当てても false。
   */
  damage(amount: number): boolean {
    if (!this.alive) return false
    this.integrity -= amount
    return this.integrity <= 0
  }

  /** AI の状態。描画とテストが読む */
  get aiState(): AiState {
    return this.ai.state
  }

  /**
   * 1 ステップ進める。
   *
   * 順番に意味がある。**AI が決めてから撃ち、そのあと機体を動かす。**機体を
   * 先に動かすと、AI が見た姿勢と弾が出る姿勢が 1 ステップずれる。
   *
   * @param player 追う相手。AI が位置と速度と姿勢を読む
   * @param rng 散布に使う。同じシードからは同じ弾道になる
   */
  step(dt: number, player: Tracked, rng: Rng): void {
    const input = this.ai.decide(
      this.aircraft,
      player,
      this.trimThrottle,
      this.stepOptions.terrain,
      rng,
    )
    this.fire(dt, input.fireGun, rng)
    this.launchMissile(dt, input.fireMissile)
    // フレアは機体を動かす前に進める。投下の位置は前のステップの姿勢で決まる
    this.countermeasures.step(
      dt,
      input.deployFlare,
      this.position,
      this.velocity,
      this.orientation,
    )
    // ダメージで舵が鈍る。効きの係数は毎ステップ作り直す
    this.stepOptions.controlFactor = damageControl(this.integrityRatio)
    this.aircraft.step(input, dt, this.stepOptions)
    // 煙は機体を動かしたあとに記録する。排気口の位置は姿勢から出る
    this.smoke.record(this.position, this.orientation, this.smokeStrength)
  }

  /**
   * ミサイルを撃つ。
   *
   * **撃つ判断は AI、進めるのは `Combat`。**ここは器を選んで初期条件を
   * 与えるだけ。`targetIndex` は使わない（相手は常に自機なので、`Combat`
   * 側が固定で渡す）。
   */
  private launchMissile(dt: number, firing: boolean): void {
    this.sinceLaunch += dt
    if (!firing || !this.alive) return
    if (this.missilesLeft <= 0) return
    if (this.sinceLaunch < MISSILE_INTERVAL_SECONDS) return

    const missile = this.missiles.find((m) => m.state !== 'flying')
    if (missile === undefined) return

    const craft = this.aircraft
    missile.launch(craft.position, craft.velocity, craft.orientation, 0)
    this.missilesLeft--
    this.missilesFired++
    this.sinceLaunch = 0
  }

  /** 機銃を撃つ。機体の姿勢から銃口の位置と向きを出す */
  private fire(dt: number, firing: boolean, rng: Rng): void {
    const craft = this.aircraft
    if (!this.alive) {
      this.gun.fire(dt, false, muzzle, nose, right, up, craft.velocity, rng)
      return
    }
    craft.orientation.forward(nose)
    craft.orientation.right(right)
    craft.orientation.up(up)
    craft.orientation.rotate(MUZZLE_OFFSET, muzzle)
    muzzle.add(craft.position)
    this.gun.fire(dt, firing, muzzle, nose, right, up, craft.velocity, rng)
  }

  /** 撃った弾の総数。命中率を出すのに使う */
  get roundsFired(): number {
    return this.gun.roundsFired
  }

  /** 描画用に前ステップと現ステップを補間した状態を書き込む */
  sample(alpha: number, out: AircraftSample): AircraftSample {
    return this.aircraft.sample(alpha, out)
  }
}
