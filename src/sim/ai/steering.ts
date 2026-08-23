import { Vec3 } from '../vec3'
import type { Quat } from '../quat'
import { AIRCRAFT, clamp, gLimitedPitchRate } from '../flightModel'
import { GRAVITY } from '../isa'
import type { TerrainSampler } from '../aircraft'

/**
 * 加速度の指令を操縦の入力へ写す。
 *
 * 飛行機は横へ押されて曲がるのではなく、**揚力の向きを変えて曲がる。**だから
 * 「この方向へ加速したい」を機体の操縦に写すには 2 段が要る。
 *
 * まずロールで揚力の向きを合わせ、それからピッチで引く。実機の操縦と同じ
 * 順序。真横へ引こうとしても機体は横に曲がらない。
 *
 * ## ロール
 *
 * 目標のバンク角は、必要な横加速度から出す。定常旋回のつり合いと同じ式。
 *
 *   φ_target = atan2(a_h, a_v + g·v̂_y)
 *
 * `a_h` は指令の水平横成分、`a_v` は指令の鉛直成分。`v̂` は速度に垂直な面の
 * 「上」向きで、水平飛行では真上。**分母に重力が入るのが要点。**水平飛行では
 * 揚力が 1 G を支えているので、そこへ横 5 m/s² を足すなら 28 度倒せばよい。
 *
 * **指令の向きの角度を参照にしてはいけない。**機体座標での `atan2(b.x, b.y)` は
 * 指令が小さいと小さな数どうしの比になり、向きが定まらない。実測で、真後ろ
 * 3,000 m の相手を追って機軸の誤差が 0.5〜0.9 度しかない状態のまま、バンクが
 * ±47 度を 1 秒ごとに往復した。**姿勢の制御が発振したのではなく、参照そのものが
 * 暴れていた。**分母に g を入れると指令の大きさに対して滑らかになる。
 *
 * 比例だけだと行き過ぎる。ロールの指令は角速度の指令で、機体側の時定数が
 * 0.12 秒ある。角速度に比例した項を引いて減衰させる。
 *
 * ピッチ側の符号は座標系から追える。前方軸は −Z で、右ロールは `setBodyRates`
 * が角速度 z を負にする向き、つまり −Z まわりの正回転。右手系で n = (0,0,−1)、
 * v = (0,1,0) とすると n × v = (1,0,0) なので、+Y は +X へ向かう。
 *
 * ## ピッチ
 *
 * 指令の「機体の上」成分を、機体が出せる旋回率で割る。
 *
 *   ω_desired = b.y / v        （加速度を速度で割ると角速度）
 *   pitch = ω_desired / ω_max
 *
 * ω_max は G 制限から決まる `gLimitedPitchRate(v)` と舵の上限の小さいほう。
 * **こう割ると指令が自動で正規化される。**固定の基準加速度で割ると、速度に
 * よって効きが変わる（高速では同じ G でも角速度が小さい）。
 *
 * 押す側は 0.3 までに絞る。実機の操縦者は持続的な負 G を避ける。ロールで
 * 向きを合わせるほうが速い。
 *
 * ## 要求が小さいときは経路角の保持へ寄せる
 *
 * ピッチの指令は角速度なので、0 では姿勢が保たれるだけで経路は重力で沈む。
 * 実測で 24 秒に 20 m（−0.8 m/s）落ちた。要求が小さいほど「経路角を 0 に
 * 保つ」指令へ滑らかに混ぜる。閾値で切り替えると境界で跳ねる。
 */

/** ロールの指令が飽和する角度誤差 rad。34.4 度 */
export const ROLL_BAND = 0.6
/**
 * ロールの減衰の時定数 s。
 *
 * 機体のロールの時定数（`AIRCRAFT.rollTau` = 0.12 s）と同じ程度に取る。
 * 小さすぎると行き過ぎ、大きすぎると鈍くなる。
 */
export const ROLL_DAMP = 0.15
/** 押す側の上限。負 G を避ける */
export const PUSH_LIMIT = 0.3
/**
 * 操縦へ切り替わる横方向の要求 m/s²。
 *
 * これを下回ると水平飛行の保持へ寄る。0.5 G。**1 G より小さくしないと、
 * 重力を打ち消すぶんの縦の要求で常に「操縦する」側へ入ってしまう。**
 */
export const STEER_THRESHOLD = 4.9
/** 経路角の誤差を詰める時定数 s */
export const GAMMA_TAU = 1.5

export interface Steering {
  pitch: number
  roll: number
}

/**
 * 操縦される側。`Aircraft` が構造的に満たす。
 *
 * テストから素のオブジェクトを渡せるように、必要な項目だけの形にしてある。
 */
export interface Flyer {
  readonly orientation: Quat
  readonly velocity: Vec3
  /** バンク角 rad。右が正 */
  readonly bank: number
  /** 対気速度 m/s */
  readonly speed: number
  /** body 座標系の角速度 rad/s */
  readonly angularVelocity: Vec3
}

/** 世界の上方向 */
const WORLD_UP = new Vec3(0, 1, 0)

// 一時変数。使い回してゴミを出さない
const forward = new Vec3()
const perp = new Vec3()
const body = new Vec3()
const lateral = new Vec3()
const upward = new Vec3()

/** 右ロールの角速度 rad/s。`setBodyRates` が z を負にしているので反転する */
export function rollRateOf(flyer: Flyer): number {
  return -flyer.angularVelocity.z
}

/** 速度ベクトルから上昇角 rad。上向きが正 */
export function climbAngleOf(velocity: Vec3): number {
  const speed = velocity.length()
  if (speed < 1e-6) return 0
  return Math.asin(clamp(velocity.y / speed, -1, 1))
}

/** 機体が出せるピッチ率の上限 rad/s */
export function pitchCap(speed: number): number {
  return Math.min(AIRCRAFT.maxPitchRate, gLimitedPitchRate(Math.max(speed, 1)))
}

/**
 * 降下から引き起こすのに要る高度 m。
 *
 * 2 つの足し算。
 *
 * **引き起こしの円弧。**全力で引いたときの旋回半径は R = v / ω_max。降下角 γ
 * から水平へ戻すまでに失う高度はその円弧の垂直方向の分で Δh = R (1 − cos γ)。
 *
 * **翼を水平へ戻すあいだの降下。**バンクが残っていると引いても機首は上がらない
 * （`levelAndClimb` が cos(bank) で割り引く）。戻すのに掛かる時間は
 * |φ| / ω_roll + τ_roll で、そのあいだ v sin|γ| で沈み続ける。
 *
 * **固定値の下限では足りない。**実測で、高度 8,000 m から 400 m/s で
 * 5,000 m 下の相手へ降りたとき、対地 800 m の固定値では 2.6 秒で地面に
 * 当たった。400 m/s の R は 2,195 m で、48 度の降下から戻すのに 730 m 要る。
 *
 * **円弧だけでも足りない。**バンクの項を入れる前は、36 通りの走査で最低
 * 対地高度が 124 m まで落ちた条件があった。旋回中に降下へ入ると、翼を戻す
 * あいだの沈みが乗る。
 *
 * 上昇中（γ ≥ 0）は 0。
 */
export function pulloutAltitude(speed: number, climbAngle: number, bank = 0): number {
  if (climbAngle >= 0) return 0
  const v = Math.max(speed, 1)
  const arc = (v / pitchCap(speed)) * (1 - Math.cos(climbAngle))
  const rollTime = Math.abs(bank) / AIRCRAFT.maxRollRate + AIRCRAFT.rollTau
  const sink = v * Math.sin(-climbAngle) * rollTime
  return arc + sink
}

/**
 * 前方の地形との余裕 m。
 *
 * **真下の対地高度では足りない。**斜面は正面から来る。実測で、対地 927 m を
 * 20 度で上昇していた敵機が、3.5 秒後に地面へ当たった。そのあいだに地形が
 * 28 m から 1,332 m へ立ち上がっていた。傾斜は 44 度で、400 m/s では上昇率
 * 137 m/s に対して地形の立ち上がりが 373 m/s。上昇では逃げられない。
 *
 * いまの速度でまっすぐ飛んだ経路の上で、地形からの余裕がいちばん小さい点を
 * 返す。海面（高さ 0 未満の地形）は 0 として扱う。`Aircraft` の墜落判定と
 * 同じ約束。
 *
 * @param horizon 何秒先まで見るか
 * @param samples 何点で見るか。1 点あたり双三次補間 16 タップ
 */
export function terrainClearance(
  position: Vec3,
  velocity: Vec3,
  terrain: TerrainSampler,
  horizon: number,
  samples: number,
): number {
  let worst = Infinity
  for (let i = 1; i <= samples; i++) {
    const t = (horizon * i) / samples
    const ground = terrain.heightAt(
      position.x + velocity.x * t,
      position.z + velocity.z * t,
    )
    const clearance = position.y + velocity.y * t - (ground > 0 ? ground : 0)
    if (clearance < worst) worst = clearance
  }
  return worst
}

/**
 * 指令加速度から操縦の入力を出す。
 *
 * @param command ワールド座標の指令加速度 m/s²
 */
export function steerToward(command: Vec3, flyer: Flyer, out: Steering): Steering {
  const speed = flyer.velocity.length()
  if (speed < 1) {
    out.pitch = 0
    out.roll = 0
    return out
  }

  // 速度に沿った成分は推力と抗力の話。旋回には使えないので落とす
  forward.copy(flyer.velocity).multiplyScalar(1 / speed)
  perp.copy(command).addScaledVector(forward, -command.dot(forward))
  const demand = perp.length()

  // 機体座標へ回す
  flyer.orientation.rotateInverse(perp, body)

  const rate = rollRateOf(flyer)
  const cap = pitchCap(speed)

  // 速度に垂直な面を、水平の右向きと、その面内の上向きで張る
  lateral.crossVectors(forward, WORLD_UP)
  if (lateral.lengthSq() < 1e-12) {
    // 真上か真下へ飛んでいる。水平面が定まらないので機体の右を使う
    flyer.orientation.right(lateral)
  }
  lateral.multiplyScalar(1 / lateral.length())
  upward.crossVectors(lateral, forward)

  // 定常旋回のつり合いから目標のバンク角。分母に重力が入る
  const bankTarget = Math.atan2(
    perp.dot(lateral),
    perp.dot(upward) + GRAVITY * upward.y,
  )
  out.roll = clamp((bankTarget - flyer.bank - ROLL_DAMP * rate) / ROLL_BAND, -1, 1)

  // ピッチは機体の上成分。要求が小さいほど経路角の保持へ寄せる
  const steerPitch = body.y / speed / cap
  const holdPitch =
    ((-climbAngleOf(flyer.velocity) / GAMMA_TAU) * Math.cos(flyer.bank)) / cap
  const w = clamp(demand / STEER_THRESHOLD, 0, 1)
  out.pitch = clamp(w * steerPitch + (1 - w) * holdPitch, -PUSH_LIMIT, 1)
  return out
}

/**
 * 翼を水平に戻しつつ、目標の上昇角へ向ける。
 *
 * 立て直しに使う。バンクが残っていると引いても機首は上がらないので、
 * **ピッチをバンクの余弦で割り引く。**背面（バンク 180 度）では余弦が −1 に
 * なり、押す指令になる。背面で押すのは世界座標では上向きなので、これで
 * 正しい向きに逃げる。
 *
 * @param targetClimb 目標の上昇角 rad
 * @param tau 上昇角の誤差を詰める時定数 s
 */
export function levelAndClimb(
  flyer: Flyer,
  targetClimb: number,
  tau: number,
  out: Steering,
): Steering {
  const rate = rollRateOf(flyer)
  out.roll = clamp((-flyer.bank - ROLL_DAMP * rate) / ROLL_BAND, -1, 1)

  const cap = pitchCap(flyer.speed)
  const climb = climbAngleOf(flyer.velocity)
  const want = ((targetClimb - climb) / tau) * Math.cos(flyer.bank)
  out.pitch = clamp(want / cap, -PUSH_LIMIT, 1)
  return out
}
