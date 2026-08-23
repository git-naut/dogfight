import { Vec3 } from '../vec3'
import { clamp } from '../flightModel'
import { proportionalNavigation } from '../weapons/missile'
import type { Aircraft } from '../aircraft'
import type { Tracked } from '../combatant'
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

/** 世界の上方向。水平の旋回面を作るのに使う */
const WORLD_UP = new Vec3(0, 1, 0)

// 一時変数。使い回してゴミを出さない
const command = new Vec3()
const los = new Vec3()
const forward = new Vec3()
const perp = new Vec3()
const horizontal = new Vec3()

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

export class FighterAi {
  state: AiState = 'pursue'

  private readonly input: InputState = neutralInput()
  private readonly steering: Steering = { pitch: 0, roll: 0 }

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

    const next = this.nextState(self)
    if (next !== this.state) {
      this.state = next
      this.frames = 0
    } else {
      this.frames++
    }

    this.input.fireGun = false
    this.input.fireMissile = false
    this.input.yaw = 0
    this.input.throttle = throttle

    if (this.state === 'recover') this.recover(self)
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
  private nextState(self: Aircraft): AiState {
    if (this.state === 'recover') {
      const safe =
        this.clearance > RESUME_AGL && self.speed > RESUME_SPEED && !self.stalled
      return safe ? 'pursue' : 'recover'
    }
    if (self.stalled || self.speed < RECOVER_SPEED) return 'recover'
    if (this.clearance < recoverFloor(self.speed, climbAngleOf(self.velocity), self.bank)) {
      return 'recover'
    }
    return 'pursue'
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
