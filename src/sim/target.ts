import { Vec3 } from './vec3'
import { Quat } from './quat'
import { GRAVITY, airDensity } from './isa'
import { trimCondition } from './flightModel'
import type { Combatant } from './combatant'

/**
 * 標的機。
 *
 * **飛行モデルは載せない。**`Aircraft` を流用すると空力と操縦の全部が乗るし、
 * 操縦する主体が要る。Phase 5 で必要なのは「決められた軌跡を飛ぶ剛体」だけで、
 * ロックオンと比例航法と当たり判定を成立させるにはそれで足りる。
 *
 * Phase 6 の敵機はこれを置き換えない。**撃たれる側の口は `Combatant` に
 * 切り出したので、両方が同じ列に並ぶ。**計測用の台本（弾道・DLZ・視線回転率）
 * は決められた軌跡を飛ぶ相手のほうが読みやすいので、こちらを使い続ける。
 *
 * 力学はないが運動学は正しく組む。定常旋回のバンク角は速度と旋回率から
 * 導く（下の `steadyTurnBank`）。旋回する的がないと視線の回転率がほぼ 0 に
 * なり、比例航法が「まっすぐ追う」のと区別が付かなくなる。**この 1 点の
 * ために標的機を入れている。**
 */

/** 世界の上方向。旋回はこの軸まわり */
const WORLD_UP = new Vec3(0, 1, 0)
/** 機体座標の右方向。迎角はこの軸まわり */
const BODY_RIGHT = new Vec3(1, 0, 0)
/** 機体座標の前方向。バンクはこの軸まわり */
const BODY_FORWARD = new Vec3(0, 0, -1)

/**
 * 標的機の初期条件。
 *
 * 台本に書けるよう数値だけで表す。位置は自機のスポーン地点からの相対で、
 * 自機は必ず原点に湧く（`replay.ts` の `spawnFromSpec`）ので、そのまま
 * 「前方 4 km・右 300 m」のような読み方ができる。
 */
export interface TargetSpec {
  /** 自機のスポーン地点からの相対初期位置 m。前方が -Z、右が +X、上が +Y */
  offset: Vec3
  /** 対気速度 m/s。旋回しても落ちない（推力は問わない） */
  speed: number
  /**
   * 定常旋回率 rad/s。正が右旋回。0 なら直進。
   *
   * 右ヨーが +Y まわりの負回転なので、内部では符号を反転して掛ける。
   * 座標系の符号は `aircraft.ts` の `setBodyRates` と同じ約束にそろえてある。
   */
  turnRate?: number
}

/**
 * 標的の耐久。20mm 弾 1 発を 1 とする。
 *
 * **実弾で何発当てれば落ちるかの公表値はない。**戦闘機に対する 20mm HEI の
 * 必要弾数は資料でも幅がある。ここは手触りの値。
 *
 * 20 から 60 へ上げた。**20 では当てた実感が出る前に終わる。**実測で
 * `gun-pass`（300 m から当て続ける）の撃墜が 0.50 秒だった。曳光弾が相手に
 * 入ってから落ちるまでが目で追えない。耐久は撃墜時間に線形に効く。
 *
 * | 耐久 | 撃墜 | 使う弾 |
 * | 20 | 0.50 s | 50 発 |
 * | 40 | 0.72 s | 72 発 |
 * | 60 | 0.95 s | 95 発 |
 * | 80 | 1.18 s | 118 発 |
 *
 * 60 を採った。携行 578 発（5.78 秒ぶん）に対して 6 機ぶんの弾薬が残る。
 * 80 だと 4 機ぶんしかなく、Phase 7 のミッション（敵 8 機撃墜）で足りない。
 *
 * ミサイルはこれを超えるダメージを与えて 1 発で落とす。
 */
export const TARGET_INTEGRITY = 60

/** 描画とデバッグ表示に渡す読み取り用の状態 */
export interface TargetSample {
  position: Vec3
  orientation: Quat
  speed: number
  altitude: number
  /** バンク角 rad。右が正 */
  bank: number
  /** 生きているか。落ちたら描画から消す */
  alive: boolean
  /** 残りの耐久 0..TARGET_INTEGRITY */
  integrity: number
}

export function createTargetSample(): TargetSample {
  return {
    position: new Vec3(),
    orientation: new Quat(),
    speed: 0,
    altitude: 0,
    bank: 0,
    alive: true,
    integrity: TARGET_INTEGRITY,
  }
}

/**
 * 定常旋回のバンク角 rad。
 *
 * 水平旋回では、揚力の水平成分が向心力を、垂直成分が重量を支える。
 *
 *   L sin φ = m v ω   （向心力。旋回率 ω = v / R なので m v²/R と同じ）
 *   L cos φ = m g
 *
 * 割ると tan φ = v ω / g。質量も揚力も消えるので、速度と旋回率だけで決まる。
 * だからバンクを台本の入力にする必要がない。
 */
export function steadyTurnBank(speed: number, turnRate: number): number {
  return Math.atan2(speed * turnRate, GRAVITY)
}

/**
 * sin(x) / x。x → 0 で 1。
 *
 * 弧の長さに対する弦の長さの比。旋回率が 0 のときに 0/0 にならないよう、
 * 倍精度で 1 と区別が付かなくなる範囲は 1 で返す。
 */
function sinc(x: number): number {
  return Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x
}

// 毎ステップの一時変数。使い回してゴミを出さない
const tmpQuat = new Quat()
const tmpForward = new Vec3()

export class Target implements Combatant {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()

  readonly speed: number
  readonly turnRate: number
  /** 定常旋回のバンク角 rad。速度と旋回率から決まる */
  readonly bank: number

  /**
   * 迎角 rad。
   *
   * 力学は解かないが、機首が経路より少し上を向いていないと絵が嘘になる。
   * 自機と同じ水平定常飛行のトリムから引く（`trimCondition`）。旋回で
   * 増えるぶんは見ない。バンク 45 度でも 1.4 倍なので絵には出ない。
   */
  readonly angleOfAttack: number

  /**
   * 残りの耐久。20mm 弾 1 発で 1 減る。
   *
   * ダメージの表現（煙を引く、操縦が鈍る）は Phase 6 の担当。ここは
   * 落ちるか落ちないかだけを持つ。
   */
  integrity = TARGET_INTEGRITY

  /** 積算した機首方位 rad。右旋回で増える */
  private heading = 0

  // 描画補間用に前ステップの状態を持つ。自機と同じ作法
  private readonly prevPosition = new Vec3()
  private readonly prevOrientation = new Quat()

  constructor(spec: TargetSpec, origin: Vec3) {
    this.speed = spec.speed
    this.turnRate = spec.turnRate ?? 0
    this.bank = steadyTurnBank(this.speed, this.turnRate)
    this.angleOfAttack = trimCondition(
      this.speed,
      airDensity(origin.y + spec.offset.y),
    ).alpha

    this.position.copy(origin).add(spec.offset)
    this.updatePose()
    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)
  }

  /** 高度 m（海抜） */
  get altitude(): number {
    return this.position.y
  }

  /** 生きているか */
  get alive(): boolean {
    return this.integrity > 0
  }

  /**
   * ダメージを与える。落ちた瞬間だけ true を返す。
   *
   * 返り値で「いま落ちた」を見分けられるようにしてある。落ちたあとの弾で
   * 撃墜数を二重に数えないため。
   */
  damage(amount: number): boolean {
    if (this.integrity <= 0) return false
    this.integrity -= amount
    return this.integrity <= 0
  }

  /**
   * 1 ステップ進める。
   *
   * **位置は速度 × dt では出さない。**旋回中の速度は向きが変わり続けるので、
   * 区間の始まりの向きへまっすぐ進めると円が外へ膨らむ。実測で、半径 4,000 m
   * を 4 分の 1 周しただけで 4,001.8 m へ育った（+0.045%）。回り続けるほど
   * 外へ逃げるので、標的が台本どおりの位置にいなくなる。
   *
   * 円弧なら厳密に積分できる。旋回率 ω が一定なら、区間 dt のあいだの変位は
   *
   *   Δ = ∫ v (sin h, 0, −cos h) ds       h = h₀ + ω s
   *     = (v/ω)(cos h₀ − cos h₁, 0, −(sin h₁ − sin h₀))
   *
   * 和積の公式で中点の方位 h_m = h₀ + ω dt/2 にまとめると
   *
   *   Δ = v · dt · sinc(ω dt/2) · (sin h_m, 0, −cos h_m)
   *
   * 「区間の中点の向きへ、弧ではなく弦の長さだけ進む」という形になる。
   * ω → 0 で sinc → 1 なので、直進も同じ式で扱えて分岐が要らない。
   */
  step(dt: number): void {
    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)
    // 落ちたら動かさない。**そのまま出すと残骸が空中で固まって見えるので、
    // 描画側は alive を見て隠す。**落下と爆発は爆発の段で入れる
    if (!this.alive) return

    const half = this.turnRate * dt * 0.5
    const mid = this.heading + half
    const chord = this.speed * dt * sinc(half)
    this.position.x += chord * Math.sin(mid)
    this.position.z -= chord * Math.cos(mid)

    this.heading += this.turnRate * dt
    this.updatePose()
  }

  /**
   * 描画用に前ステップと現ステップを補間した状態を書き込む。
   *
   * @param alpha 0 が前ステップ、1 が現ステップ
   */
  sample(alpha: number, out: TargetSample): TargetSample {
    out.position.copy(this.prevPosition).lerp(this.position, alpha)
    out.orientation.copy(this.prevOrientation).slerp(this.orientation, alpha)
    out.speed = this.speed
    out.altitude = out.position.y
    out.bank = this.bank
    out.alive = this.alive
    out.integrity = this.integrity
    return out
  }

  /**
   * 機首方位から速度と姿勢を組み直す。
   *
   * 姿勢は 方位 × 迎角 × バンク の順。バンクは機首軸まわりなので前方向を
   * 動かさず、迎角は機首だけを経路の上へ持ち上げる。だから速度は方位だけで
   * 決まり、水平のまま保たれる。
   */
  private updatePose(): void {
    // 右ヨーは +Y まわりの負回転。`setBodyRates` と同じ約束
    this.orientation.setFromAxisAngle(WORLD_UP, -this.heading)
    this.orientation.forward(tmpForward)
    this.velocity.copy(tmpForward).multiplyScalar(this.speed)

    this.orientation.multiply(tmpQuat.setFromAxisAngle(BODY_RIGHT, this.angleOfAttack))
    this.orientation.multiply(tmpQuat.setFromAxisAngle(BODY_FORWARD, this.bank))
  }
}
