import { Vec3 } from '../vec3'
import { clamp } from '../flightModel'
import { FIXED_DT } from '../loop'
import { proportionalNavigation } from '../weapons/missile'
import type { Aircraft } from '../aircraft'
import type { Tracked } from '../combatant'
import type { Rng } from '../rng'
import { bulletTimeToRange } from '../weapons/gun'
import { neutralInput, type InputState } from '../input'
import {
  climbAngleOf,
  levelAndClimb,
  pulloutAltitude,
  steerToward,
  terrainClearance,
  type Steering,
} from './steering'
import type { TerrainSampler } from '../aircraft'

/**
 * 敵機の AI。
 *
 * ステートマシン。`decide()` が毎ステップ `InputState` を返し、`Enemy` が
 * それを `Aircraft.step` へ渡す。**接続点は自機と同じ。**キーボードとリプレイに
 * 次ぐ 3 番目の入力の作り手になる。
 *
 * | 状態 | 入る条件 | やること |
 * | `pursue` | 既定 | 比例航法で先回りして詰める |
 * | `attack` | 距離が機銃の射程内、機軸が合っている | 機銃を撃つ |
 * | `evade` | 撃たれている、または相手が後方至近 | 高 G の旋回で外す |
 * | `recover` | 失速した、対地高度が低い、速度が落ちた | 機首を戻して速度を回復する |
 *
 * この段では `pursue` と `recover` だけ。`attack` と `evade` は次の段。
 *
 * **`recover` が要るのは `Aircraft` を使うから。**運動学の `Target` なら失速も
 * 墜落もしないが、本物の飛行モデルは引きすぎれば失速し、低空で引けば地面に
 * 当たる。「AI が自滅しないこと」がテストの主題になる。
 *
 * G 制限と失速の回避は持たせない。`applyAoaLimiter` と `gLimitedPitchRate` が
 * すでに `Aircraft` の中で効いているので、フルに引いても機体側が絞る。
 * AI は「引きたい量」を出すだけでよい。
 */

export type AiState = 'pursue' | 'attack' | 'evade' | 'recover'

/**
 * 比例航法の航法定数。
 *
 * ミサイルは 3.5（`missile.ts`）。機体は G の上限が 7.5 でミサイルの 30 より
 * ずっと低いので、大きくしても出せない。同じ 3.5 を使う。
 */
export const NAV_CONSTANT = 3.5

/**
 * 機軸の誤差を詰める時定数 s。
 *
 * **比例航法だけでは相手を機首に乗せられない。**指令の大きさが視線の回転率に
 * 比例するので、遠距離では幾何が崩れていても指令がほとんど出ない。同速で
 * 真横にいる相手には相対速度がほぼ 0 なので指令が出ず、真後ろの相手にも
 * 反応しない（比例航法の既知の性質）。機首を相手へ向ける成分を足す。
 *
 * 大きさは 機軸からの角度 / この時定数 × 速度。角度が 0 なら 0 になるので、
 * 合ったあとは比例航法の先回りだけが残り、`steerToward` の保持側へ寄る。
 *
 * **1 − cos(角度) では効かない。**小角では θ²/2 なので、20 度の誤差でも
 * 0.06 しか出ない。実測で機軸の誤差が 11.5 度から 31.7 度へ開き続け、G は
 * 1.4 から 2.0 しか出ていなかった。角度そのものを使うと 20 度で 4.4 G。
 *
 * 0.7 秒は振って決めた。3 つの構図で 500 m まで詰める時間と、そのときの
 * 機軸の誤差を測った（相手は旋回率 0.04 rad/s か直進、自機と同速）。
 *
 * | τ | 旋回する相手（後方 3 km） | 直進する相手 | 真横 2 km |
 * | 0.4 s | 30.8 s / 3.2° | 32.1 s / 0.8° | 25.3 s / 4.9° |
 * | 0.6 s | 29.9 s / 5.7° | 31.9 s / 1.1° | 18.4 s / 6.2° |
 * | 0.7 s | 29.6 s / 6.5° | 31.9 s / 0.6° | 13.8 s / 7.0° |
 * | 0.8 s | 29.4 s / 7.2° | 31.9 s / 0.8° | 11.1 s / 17.5° |
 * | 2.0 s | 28.2 s / 14.4° | 31.8 s / 0.2° | 9.6 s / 39.4° |
 * | 5.0 s | 27.3 s / 23.4° | 31.8 s / 0.4° | 9.2 s / 45.1° |
 *
 * 詰める速さはほとんど変わらないのに、指向は τ で大きく変わる。0.8 秒から
 * 真横の構図が 17.5 度へ崩れ、0.6 秒では真横の接近が 18.4 秒へ延びる。
 *
 * **角度で重みを付けるのはやめた。**「機軸が合っているあいだは比例航法だけに
 * する」ほうが理屈は通るが、実測では指向が 37.7 度まで崩れて詰める時間は
 * 1.5 秒しか縮まなかった。常に効かせる。
 */
export const ALIGN_TAU = 0.7

/**
 * 水平飛行でも確保する対地高度 m。
 *
 * 降下していないときの下限。降下しているぶんは `pulloutAltitude` が足す。
 *
 * **固定値だけでは足りない。**実測で 36 通りの初期条件を 60 秒回したとき、
 * 800 m の固定値では高度 8,000 m・400 m/s の 2 条件が地面に当たった。
 * 立て直しに入ってから衝突までが 2.6 秒しかなかった。
 */
export const HARD_FLOOR = 400
/**
 * 引き起こし高度に掛ける余裕。
 *
 * 舵が効き始めるまでの遅れ（`AIRCRAFT.pitchTau` = 0.12 s）と、姿勢が
 * 変わってから経路が追いつくまでの遅れを見込む。
 */
export const PULLOUT_MARGIN = 2
/**
 * 立て直しから抜ける対地高度 m。
 *
 * 入る条件は降下角で動くが、抜ける条件は固定にする。**同じ式で往復させると
 * 立て直しで機首が上がった瞬間に条件が消えて、また降下に戻る。**
 */
export const RESUME_AGL = 1200

/**
 * 立て直しに入る対気速度 m/s。
 *
 * 高度 3,000 m の失速速度は 71.6 m/s、7.5 G を出せるコーナー速度は 196.1 m/s
 * （実測。CLmax 1.899 から）。150 m/s を下回ると旋回率が目に見えて落ちるので、
 * ここで機首を下げて速度を戻す。
 */
export const RECOVER_SPEED = 150
/** 立て直しから抜ける対気速度 m/s。コーナー速度の手前まで戻す */
export const RESUME_SPEED = 190

/** 低空から離れるときの目標上昇角 rad。20 度 */
export const CLIMB_OUT = (20 * Math.PI) / 180
/**
 * 余裕が尽きかけたときの目標上昇角 rad。45 度。
 *
 * 20 度では斜面から逃げられない。実測で 44 度の傾斜へ 400 m/s で入り、
 * 上昇率 137 m/s に対して地形が 373 m/s で立ち上がった。推力重量比が 0.96 
 * なので 45 度は短時間なら保てる。
 */
export const STEEP_CLIMB = (45 * Math.PI) / 180
/**
 * 前方の地形を何秒先まで見るか。
 *
 * 400 m/s なら 2,400 m 先。**引き起こしに要る時間より長く取る。**45 度まで
 * 起こすのに 400 m/s では 0.785 / 0.182 = 4.3 秒かかる。
 */
export const TERRAIN_HORIZON = 6
/** 前方の地形を何点で見るか。1 点あたり双三次補間 16 タップ */
export const TERRAIN_SAMPLES = 6
/** 速度を戻すときの目標上昇角 rad。−12 度 */
export const DIVE_OUT = (-12 * Math.PI) / 180
/**
 * 格闘の間合いで狙う対気速度 m/s。
 *
 * **速すぎると曲がれない。**7.5 G の旋回半径は速度の 2 乗で伸びる。高度
 * 3,000 m での実測は 200 m/s で 549 m、250 m/s で 857 m、400 m/s で 2,195 m。
 * 全開のままにすると 60 秒で 446 m/s まで加速し、旋回率が 0.165 rad/s まで
 * 落ちる。
 *
 * 高度 3,000 m の失速速度は 71.6 m/s、7.5 G を出せるコーナー速度は 196.1 m/s
 * （実測）。その 1.4 倍を狙う。余裕を持たせないと、少し引いた瞬間に
 * コーナー速度を割って旋回率が落ちる。
 */
export const FIGHT_SPEED = 275
/** この距離まで詰めたら格闘の速度へ落とす m */
export const FIGHT_RANGE = 500
/** 距離 1 m あたり目標速度をどれだけ上げるか m/s */
export const CHASE_SPEED_PER_METER = 0.06
/** 追い込みの上限速度 m/s */
export const MAX_CHASE_SPEED = 420
/**
 * 速度の誤差 1 m/s あたりのスロットル。
 *
 * 0.02 なら誤差 25 m/s で飽和する。中立を 0.5 に置くので、目標より 25 m/s
 * 遅ければ全開、25 m/s 速ければ絞り切る。
 */
export const THROTTLE_GAIN = 0.02

/**
 * 機銃で撃ちに入る距離 m。
 *
 * 弾の寿命は 2.5 秒で、そのあいだに 1,589 m 飛ぶ（`gun.ts` の実測）。それより
 * 遠くから撃っても当たらない。**1,200 m まで詰めてから撃ち始める。**
 */
export const GUN_ENGAGE_RANGE = 1200
/**
 * 射撃中に機軸の誤差を詰める時定数 s。
 *
 * 追尾の `ALIGN_TAU`（0.7 s）より短く取る。**追尾と同じ緩さでは当たらない。**
 * 機銃の散布は 3 mrad（0.17 度）なので、機軸が 0.5 度ずれていれば 500 m で
 * 4.4 m 外れる。機体の幅は 11.6 m しかない。
 *
 * 振って決めた。相手は自機で、直進と緩い右旋回（roll 0.2 / pitch 0.12）の
 * 2 通り。40 秒で撃った弾と当たった弾を数えた。
 *
 * | τ | 直進する自機 | 緩く旋回する自機 | 発射時の誤差の中央値 |
 * | 0.15 s | 3.3% | 3.4% | 1.27° / 0.73° |
 * | 0.25 s | 5.6% | 2.7% | 1.23° / 0.76° |
 * | 0.30 s | 8.3% | 0.8% | 0.85° / 1.20° |
 * | 0.35 s | 6.6% | 0.5% | 0.39° / 1.25° |
 * | **0.40 s** | **13.2%** | **1.9%** | **0.37° / 1.11°** |
 * | 0.45 s | 11.5% | 0.0% | 0.31° / 0.96° |
 * | 0.50 s | 8.3% | 1.9% | 0.43° / 0.81° |
 * | 0.70 s | 1.4% | 0.0% | 0.59° / 1.31° |
 *
 * 0.4 秒が頂点。**短くしすぎると悪くなる。**0.25 秒以下では発射時の誤差の
 * 中央値が 1.2 度台まで戻る。利得が大きすぎて追尾の輪が振れるため。
 *
 * この値で、直進していると 60 発当たって自機が落ちる。緩く旋回していれば
 * 8 発しか当たらない。**まっすぐ飛べば落ちる、機動すれば生き残る。**
 */
export const ATTACK_TAU = 0.4
/** 機銃を撃つのをやめる距離 m。至近では衝突を避けて離れる */
export const GUN_BREAK_RANGE = 120
/**
 * 引き金を引く機軸の誤差 rad。2 度。
 *
 * 機銃の散布は 3 mrad（0.17 度）なので、2 度ずれていれば 300 m で 10 m
 * 外れる。**それでも撃つ。**当たらない弾も曳光弾として見えるほうが、撃たれて
 * いることが伝わる。命中率の調整は手ごたえの段で決着時間を測ってから。
 */
export const FIRE_CONE = (2 * Math.PI) / 180
/**
 * 1 回のバーストの長さ 秒と、次のバーストまでの間隔 秒。
 *
 * 押しっぱなしにすると弾がすぐ尽きる（携行 578 発 = 5.78 秒）。実機も
 * 短い連射で撃つ。
 */
export const BURST_SECONDS = 0.6
export const BURST_GAP_SECONDS = 1.2

/**
 * 回避に入る距離 m。
 *
 * 相手が後方この距離まで詰めてきたら振り切りにかかる。機銃の射程
 * （1,589 m）より内側で、こちらが撃たれ始める間合い。
 */
export const EVADE_RANGE = 900
/** 回避に入る、相手の方位の後方からの角度 rad。60 度 */
export const EVADE_CONE = (60 * Math.PI) / 180
/**
 * 回避を続ける最短の時間 秒。
 *
 * **短いと出入りを繰り返す。**ブレイクターンは 1 周するのに 7.5 G・250 m/s で
 * 21.5 秒かかるので、少なくとも 4 分の 1 周ぶんは続ける。
 */
export const EVADE_MIN_SECONDS = 5

/** 上昇角の誤差を詰める時定数 s */
export const GAMMA_TAU = 1.5

/**
 * 立て直しに入る対地高度 m。
 *
 * 水平飛行の下限に、いまの降下から引き起こすのに要る高度を足す。速度が
 * 上がるほど、降下が急なほど深くなる。
 *
 * | 速度 | 降下角 | バンク | 引き起こし | 下限 |
 * | 250 m/s | 水平 | 0° | 0 m | 400 m |
 * | 250 m/s | −30° | 0° | 130 m | 660 m |
 * | 250 m/s | −30° | 70° | 174 m | 749 m |
 * | 400 m/s | −48° | 0° | 766 m | 1,932 m |
 */
export function recoverFloor(speed: number, climbAngle: number, bank = 0): number {
  return HARD_FLOOR + pulloutAltitude(speed, climbAngle, bank) * PULLOUT_MARGIN
}

/**
 * 距離から目標の対気速度 m/s を出す。
 *
 * 遠ければ速く（追い込む）、近ければコーナー速度寄り（曲がれる）。
 */
export function chaseSpeed(range: number): number {
  const want = FIGHT_SPEED + (range - FIGHT_RANGE) * CHASE_SPEED_PER_METER
  return clamp(want, FIGHT_SPEED, MAX_CHASE_SPEED)
}

/** 目標速度へ寄せるスロットル 0..1 */
export function throttleFor(speed: number, want: number): number {
  return clamp(0.5 + (want - speed) * THROTTLE_GAIN, 0, 1)
}

/**
 * 機銃の先行点を出す。
 *
 * 弾は機体の速度を引き継ぐので、地面から見た初速は `機体速度 + 初速`。
 * 相手までの飛行時間 t のあいだに相手は `相対速度 × t` だけ動く。
 *
 *   t = 距離 / (初速 + 接近速度)
 *   先行点 = 相手の位置 + (相手の速度 − 自機の速度) × t
 *
 * 抗力を入れた飛行時間は `bulletTimeToRange` が閉形式で持っている。1 回だけ
 * 反復する。300 m での飛行時間は 0.30 秒で、そのあいだに 250 m/s の相手は
 * 75 m 動く。**先行を入れないと当たらない。**
 */
export function gunLeadPoint(self: Aircraft, target: Tracked, out: Vec3): Vec3 {
  const range = out.subVectors(target.position, self.position).length()
  const flight = bulletTimeToRange(Math.max(range, 1))
  out.copy(target.position)
  out.addScaledVector(target.velocity, flight)
  out.addScaledVector(self.velocity, -flight)
  return out
}

/** 世界の上方向。水平の旋回面を作るのに使う */
const WORLD_UP = new Vec3(0, 1, 0)

// 一時変数。使い回してゴミを出さない
const command = new Vec3()
const los = new Vec3()
const forward = new Vec3()
const perp = new Vec3()
const horizontal = new Vec3()
const lead = new Vec3()
const nose = new Vec3()
const toLead = new Vec3()

/**
 * 追尾の指令加速度を組む。
 *
 * 比例航法に、機軸の誤差を詰める成分を足したもの。どちらも速度に垂直な
 * 加速度で、`steerToward` が操縦へ写す。
 *
 * @param out 書き込み先。ワールド座標の加速度 m/s²
 */
export function pursueCommand(self: Aircraft, target: Tracked, out: Vec3): Vec3 {
  proportionalNavigation(
    self.position,
    self.velocity,
    target.position,
    target.velocity,
    NAV_CONSTANT,
    out,
  )

  const speed = self.speed
  if (speed < 1) return out

  los.subVectors(target.position, self.position)
  const range = los.length()
  if (range < 1e-6) return out
  los.multiplyScalar(1 / range)

  forward.copy(self.velocity).multiplyScalar(1 / speed)
  const cos = clamp(los.dot(forward), -1, 1)
  const angleOff = Math.acos(cos)

  if (cos < 0) {
    // **相手が 3/9 ラインの後ろ。水平の旋回で向き直る。**
    //
    // 視線の垂直成分をそのまま使うと垂直の反転になり、エネルギーを使い切る。
    // 実測で、真後ろ 1,500 m の相手に対して 7.2 G で引き起こし、高度 3,000 m
    // から 4,215 m まで昇って速度が 250 から 141 m/s へ落ちた。そこから
    // 立て直しに入り、相手を 6,000 m 先へ見失った。
    //
    // 水平面内で速度に垂直な向きを取り、相手のいる側へ回る。7.5 G・250 m/s の
    // 旋回半径は 857 m なので、半周に 10.8 秒かかるが速度を失わない。
    horizontal.crossVectors(forward, WORLD_UP)
    const len = horizontal.length()
    if (len > 1e-6) {
      horizontal.multiplyScalar(1 / len)
    } else {
      // 真上か真下へ飛んでいる。水平面が定まらないので機体の右を使う
      self.orientation.right(horizontal)
    }
    if (los.dot(horizontal) < 0) horizontal.multiplyScalar(-1)
    return out.addScaledVector(horizontal, (angleOff / ALIGN_TAU) * speed)
  }

  // 視線の、速度に垂直な成分
  perp.copy(los).addScaledVector(forward, -cos)
  const len = perp.length()
  if (len < 1e-6) return out
  perp.multiplyScalar(1 / len)
  return out.addScaledVector(perp, (angleOff / ALIGN_TAU) * speed)
}

/**
 * 射撃の指令加速度を組む。
 *
 * **機首を先行点へ向ける。**追尾（`pursueCommand`）は速度の向きを相手へ
 * 寄せる指令だったが、機銃は機首から出る。機首は迎角のぶん速度より上を
 * 向いているので、速度を合わせただけでは弾が下を通る。
 *
 * 誤差は機首から先行点までの角度で測り、向きは速度に垂直な成分から取る。
 * 加速度で変えられるのは速度の向きだけなので、そこは追尾と同じ。
 *
 * @param out 書き込み先。ワールド座標の加速度 m/s²
 */
export function attackCommand(self: Aircraft, target: Tracked, out: Vec3): Vec3 {
  gunLeadPoint(self, target, lead)
  toLead.subVectors(lead, self.position)
  const range = toLead.length()
  if (range < 1e-6 || self.speed < 1) return out.set(0, 0, 0)
  toLead.multiplyScalar(1 / range)

  // 誤差は機首から測る
  self.orientation.forward(nose)
  const noseError = Math.acos(clamp(toLead.dot(nose), -1, 1))

  // 向きは速度に垂直な成分
  forward.copy(self.velocity).multiplyScalar(1 / self.speed)
  const cos = clamp(toLead.dot(forward), -1, 1)
  perp.copy(toLead).addScaledVector(forward, -cos)
  const len = perp.length()
  if (len < 1e-6) return out.set(0, 0, 0)
  perp.multiplyScalar(1 / len)

  return out.copy(perp).multiplyScalar((noseError / ATTACK_TAU) * self.speed)
}

/**
 * 機首から先行点までの角度 rad。射撃の判定に使う。
 *
 * `attackCommand` の中でも同じものを出しているが、判定側からも読めるように
 * 分けてある。テストが撃つ条件を検査できる。
 */
export function gunTrackError(self: Aircraft, target: Tracked): number {
  gunLeadPoint(self, target, lead)
  toLead.subVectors(lead, self.position)
  const range = toLead.length()
  if (range < 1e-6) return 0
  toLead.multiplyScalar(1 / range)
  self.orientation.forward(nose)
  return Math.acos(clamp(toLead.dot(nose), -1, 1))
}

/**
 * 相手が自分の後方にいるか。回避の判定に使う。
 *
 * 自分の速度の向きから見て、相手が真後ろから `EVADE_CONE` の内側にいるか。
 * 距離も見る。
 */
export function threatFromBehind(self: Aircraft, target: Tracked): boolean {
  if (self.speed < 1) return false
  los.subVectors(target.position, self.position)
  const range = los.length()
  if (range > EVADE_RANGE || range < 1e-6) return false
  forward.copy(self.velocity).multiplyScalar(1 / self.speed)
  // 真後ろは cos = −1。EVADE_CONE の内側は cos < −cos(EVADE_CONE)
  return los.dot(forward) / range < -Math.cos(EVADE_CONE)
}

/**
 * ブレイクターンの指令加速度を組む。
 *
 * **水平面で全力で回る。**追われている側が取るのは、相手の照準を外し続ける
 * 機動。視線に垂直な向きへ最大の加速度を出せば相手から見た角速度が最大に
 * なるが、垂直に垂直な向きは複数あって、そのどれを選ぶかでエネルギーの
 * 使い方が変わる。
 *
 * **`視線 × 速度` をそのまま使ってはいけない。**相手が真後ろにいると視線と
 * 速度がほぼ平行になり、外積の向きがわずかな横ずれで決まる。実測で、
 * 前方 220 m の相手に対して垂直の上昇になり、2.5 秒で画面の外（画面上端から
 * 80 画素）まで昇った。追尾で踏んだのと同じ罠。
 *
 * 水平面内で速度に垂直な向きを取れば、旋回率を落とさずに速度を保てる。
 * 7.5 G・250 m/s の水平旋回は 857 m の半径で、相手から見た角速度は
 * 250 / 857 = 0.29 rad/s。
 *
 * 回る向きは入る瞬間に 1 回だけ決める。**途中で変えると照準を外し続けられ
 * ない。**乱数は `World.rng` から引くので、同じシードからは同じ向きになる。
 *
 * @param sign 回る向き。+1 で右、−1 で左
 */
export function evadeCommand(self: Aircraft, sign: number, out: Vec3): Vec3 {
  if (self.speed < 1) return out.set(0, 0, 0)
  forward.copy(self.velocity).multiplyScalar(1 / self.speed)

  horizontal.crossVectors(forward, WORLD_UP)
  if (horizontal.lengthSq() < 1e-12) {
    // 真上か真下へ飛んでいる。水平面が定まらないので機体の右を使う
    self.orientation.right(horizontal)
  }
  horizontal.multiplyScalar(1 / horizontal.length())

  // 全力。機体側の G 制限と迎角制限が絞る
  return out.copy(horizontal).multiplyScalar(sign * MAX_TURN_ACCEL)
}

/**
 * 全力の旋回として指令する加速度 m/s²。
 *
 * 構造の G 制限（7.5）を超える値を渡して、機体側の制限器に絞らせる。
 * **AI が制限を持たない**という約束をここでも通す。
 */
export const MAX_TURN_ACCEL = 200

export class FighterAi {
  state: AiState = 'pursue'

  private readonly input: InputState = neutralInput()
  private readonly steering: Steering = { pitch: 0, roll: 0 }

  /**
   * ブレイクターンの向き。+1 か −1。
   *
   * 回避に入る瞬間に 1 回だけ決める。**途中で変えると照準を外し続けられない。**
   */
  private breakSign = 1

  /** バーストの位相 秒。押しっぱなしを避けるのに使う */
  private burst = 0

  /**
   * 直近に測った前方の地形との余裕 m。
   *
   * 立て直しの判定と上昇角の決定で使う。計器とテストも読む。
   */
  clearance = Infinity

  /**
   * この状態に入ってからのフレーム数。
   *
   * **経過秒を積算しない。**`time += dt` は禁止（`CLAUDE.md`）なので、
   * フレームを数えて必要なときに `FIXED_DT` を掛ける。
   */
  private frames = 0

  /**
   * 操縦入力を決める。
   *
   * @param terrain 前方の地形を見るのに使う。渡さなければ海面だけを見る
   */
  decide(
    self: Aircraft,
    target: Tracked,
    throttle: number,
    terrain?: TerrainSampler,
    rng?: Rng,
  ): InputState {
    this.clearance =
      terrain === undefined
        ? self.agl
        : Math.min(
            self.agl,
            terrainClearance(
              self.position,
              self.velocity,
              terrain,
              TERRAIN_HORIZON,
              TERRAIN_SAMPLES,
            ),
          )

    const next = this.nextState(self, target)
    if (next !== this.state) {
      this.state = next
      this.frames = 0
      // 回る向きは入る瞬間に 1 回だけ決める。乱数は World.rng から引く
      if (next === 'evade') {
        this.breakSign = rng !== undefined && rng.next() < 0.5 ? -1 : 1
      }
    } else {
      this.frames++
    }

    this.input.fireGun = false
    this.input.fireMissile = false
    this.input.yaw = 0
    this.input.throttle = throttle

    if (this.state === 'recover') this.recover(self)
    else if (this.state === 'evade') this.evade(self)
    else if (this.state === 'attack') this.attack(self, target)
    else this.pursue(self, target)

    return this.input
  }

  /** この状態に入ってからのフレーム数。テストと計器が読む */
  get framesInState(): number {
    return this.frames
  }

  /**
   * 上昇角の目標 rad。余裕が尽きかけているほど立てる。
   *
   * 余裕が下限を割っているだけなら 20 度。**下限の半分まで詰まったら 45 度。**
   * 斜面から逃げるには上昇率が地形の立ち上がりを超えないといけない。
   */
  private climbOut(self: Aircraft): number {
    const floor = recoverFloor(self.speed, climbAngleOf(self.velocity), self.bank)
    if (floor <= 0) return CLIMB_OUT
    const t = clamp(1 - this.clearance / floor, 0, 1)
    return CLIMB_OUT + (STEEP_CLIMB - CLIMB_OUT) * t
  }

  /**
   * 次の状態。
   *
   * **どの状態からも `recover` へ抜けられる。**行き止まりを作らない。
   * 戻る条件はヒステリシスを持たせて、境界で往復させない。
   */
  private nextState(self: Aircraft, target: Tracked): AiState {
    // 立て直しがいちばん強い。飛べなくなったら戦えない
    if (this.state === 'recover') {
      const safe =
        this.clearance > RESUME_AGL && self.speed > RESUME_SPEED && !self.stalled
      return safe ? 'pursue' : 'recover'
    }
    if (self.stalled || self.speed < RECOVER_SPEED) return 'recover'
    if (this.clearance < recoverFloor(self.speed, climbAngleOf(self.velocity), self.bank)) {
      return 'recover'
    }

    // 相手が落ちていれば追わない
    if (!target.alive) return 'pursue'

    // 回避は始めたら最短の時間だけ続ける。出入りを繰り返させない
    if (this.state === 'evade' && this.frames * FIXED_DT < EVADE_MIN_SECONDS) {
      return 'evade'
    }
    if (threatFromBehind(self, target)) return 'evade'

    const range = self.position.distanceTo(target.position)
    if (range < GUN_ENGAGE_RANGE && range > GUN_BREAK_RANGE) return 'attack'
    return 'pursue'
  }

  /**
   * 射撃。機首を先行点へ向け、乗ったら短く撃つ。
   *
   * **押しっぱなしにしない。**携行 578 発は 5.78 秒ぶんしかない。0.6 秒
   * 撃って 1.2 秒休む。
   */
  private attack(self: Aircraft, target: Tracked): void {
    attackCommand(self, target, command)
    steerToward(command, self, this.steering)
    this.input.pitch = this.steering.pitch
    this.input.roll = this.steering.roll
    const range = self.position.distanceTo(target.position)
    this.input.throttle = throttleFor(self.speed, chaseSpeed(range))

    // バーストの位相。撃っているあいだ進み、休みが終わったら戻る
    const cycle = BURST_SECONDS + BURST_GAP_SECONDS
    this.burst = (this.burst + FIXED_DT) % cycle
    this.input.fireGun =
      this.burst < BURST_SECONDS && gunTrackError(self, target) < FIRE_CONE
  }

  /** 回避。相手の視線に垂直な面で全力で回る */
  private evade(self: Aircraft): void {
    evadeCommand(self, this.breakSign, command)
    steerToward(command, self, this.steering)
    this.input.pitch = this.steering.pitch
    this.input.roll = this.steering.roll
    // 全開。エネルギーを使い切っても振り切るほうを取る
    this.input.throttle = 1
  }

  private pursue(self: Aircraft, target: Tracked): void {
    pursueCommand(self, target, command)
    steerToward(command, self, this.steering)
    this.input.pitch = this.steering.pitch
    this.input.roll = this.steering.roll
    const range = self.position.distanceTo(target.position)
    this.input.throttle = throttleFor(self.speed, chaseSpeed(range))
  }

  /**
   * 立て直し。
   *
   * 対地高度が足りないほうを先に見る。**低空で速度も足りないときに機首を
   * 下げたら地面に当たる。**高度が先、速度があと。
   */
  private recover(self: Aircraft): void {
    const targetClimb = this.clearance < RESUME_AGL ? this.climbOut(self) : DIVE_OUT
    levelAndClimb(self, targetClimb, GAMMA_TAU, this.steering)
    this.input.pitch = this.steering.pitch
    this.input.roll = this.steering.roll
    this.input.throttle = 1
  }
}
