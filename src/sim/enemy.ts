import { Vec3 } from './vec3'
import { Quat } from './quat'
import { airDensity } from './isa'
import { trimCondition } from './flightModel'
import { Aircraft, type AircraftSample, type StepOptions } from './aircraft'
import { neutralInput, type InputState } from './input'
import type { Combatant, Tracked } from './combatant'

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
 * この段では AI を載せない。水平定常飛行のトリムで直進するだけ。追尾と回避は
 * 後の段で `decide()` を差し替える形で入れる。
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
}

/** 世界の上方向。方位はこの軸まわり */
const WORLD_UP = new Vec3(0, 1, 0)
/** 機体座標の右方向。迎角はこの軸まわり */
const BODY_RIGHT = new Vec3(1, 0, 0)

export class Enemy implements Combatant {
  readonly aircraft: Aircraft
  integrity = ENEMY_INTEGRITY

  private readonly input: InputState = neutralInput()
  private readonly stepOptions: StepOptions

  constructor(spec: EnemySpec, origin: Vec3, options: StepOptions = {}) {
    this.stepOptions = options

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
    this.input.throttle = throttle
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

  /**
   * 1 ステップ進める。
   *
   * @param _player 自機。AI が読む。この段では使わない
   */
  step(dt: number, _player: Tracked): void {
    this.aircraft.step(this.decide(), dt, this.stepOptions)
  }

  /**
   * 操縦入力を決める。
   *
   * この段では中立のまま。トリムのスロットルだけ入れて直進する。
   */
  private decide(): InputState {
    return this.input
  }

  /** 描画用に前ステップと現ステップを補間した状態を書き込む */
  sample(alpha: number, out: AircraftSample): AircraftSample {
    return this.aircraft.sample(alpha, out)
  }
}
