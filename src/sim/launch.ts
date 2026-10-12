import { Vec3 } from './vec3'

/**
 * カタパルト射出。
 *
 * **飛行モデルには触らない。**射出中は `Aircraft.step()` を呼ばず、位置と
 * 速度を直接書く。`airborne` へ移る瞬間に速度を引き渡す。Phase 5 で
 * 「弾の物理は 1 か所に置く」と決めたのと同じ理由で、加速の積分を 2 か所に
 * 書かない。
 *
 * **等加速度で計算する。**Ford の EMALS は閉ループで牽引力を保つ。設計の要求は
 * 山と平均の比 1.05 以下（Doyle ほか 1995、表 I）なので、一定と置いてよい。
 * 位置と速度は閉じた式で出せるので、frame から導出できて決定論も保たれる
 * （`time += dt` の積算をしない）。Phase 9 の段 3 までは Nimitz の C-13（蒸気式）の値だった。
 *
 * 出典は Doyle, Samuel, Conway, Klimowski "Electromagnetic Aircraft Launch System – EMALS",
 * IEEE Transactions on Magnetics 31(1), 1995。米海軍レイクハースト（NAWC）の設計の論文で、
 * 原文の PDF で表 I（終端速度 28〜103 m/s、山と平均の比 1.05、エネルギー 122 MJ）を確かめた。
 */

/** 射出の状態 */
export type LaunchPhase = 'onDeck' | 'launching' | 'airborne'

/**
 * 終端速度 m/s。
 *
 * 150 kt。**カタパルトの性能ではなく機体の側の値**で、F/A-18 の離陸に足りる速度として
 * C-13 のときから据え置いた。EMALS の要求の範囲（28〜103 m/s、Doyle ほか 1995）に入る。
 * F/A-18E の射出の終端速度の公表値は見つけていない（推測）
 */
export const LAUNCH_END_SPEED = 150 * 0.514444

/**
 * 行程 m。
 *
 * EMALS のリニアモーターの長さ 300 ft（91.44 m）。出典は Wikipedia の本文（典拠は EDN 誌
 * 2002-04-11 の記事 "How It Works"）。1995 年の設計の論文は power stroke を 103 m と
 * 書いていて、値が 2 つある。**ユーザーの判断（2026-10-06）で、実機に近い年代の 91 m を
 * 採った。**発進に使う cat-4 の帯は甲板の塗装で 103.5 m あり、内側に 12 m の余裕が残る。
 */
export const LAUNCH_DISTANCE = 300 * 0.3048

/**
 * 加速度 m/s²。
 *
 * `v² = 2as` から `a = v²/(2s)` = 77.17² / (2×91.44) = 32.56。3.32 G
 */
export const LAUNCH_ACCEL = (LAUNCH_END_SPEED * LAUNCH_END_SPEED) / (2 * LAUNCH_DISTANCE)

/** 所要時間 秒。`t = v/a` = 2.37 */
export const LAUNCH_SECONDS = LAUNCH_END_SPEED / LAUNCH_ACCEL

/**
 * 射出を始めるスロットル。
 *
 * **専用のキーを増やさない。**甲板で待っているときスロットルを開ければ
 * 射出が始まる。実機の手順（出力を上げてから射出する）にも合う。
 * `keyboard.ts` の初期スロットルが 0.6 なので、それより上に取る。
 */
export const LAUNCH_THROTTLE = 0.9

/**
 * 射出中の機首上げ rad。
 *
 * **実機の F/A-18C は前脚を伸ばして機首上げ姿勢で射出される。**車輪が
 * 甲板に接したまま機首だけ上がるのは、そのための装置がある。
 *
 * 水平のままだと射出直後に沈む。実測で、終端速度 77.2 m/s（150 kt）の
 * まま水平で放すと海面まで落ちた（`catapult-launch` の台本、f600 で
 * 高度 4.4 m）。この速度で水平飛行に必要な迎角は 17.3 度あり、機首が
 * 水平だと揚力が足りない。
 *
 * 10 度は実機の射出姿勢に近い。**これでも足りないぶんはパイロットが
 * 引く。**実艦では艦速 30 kt と向かい風が対気速度に乗るが、このモデルは
 * 艦も風も動かないので、そのぶんは出ない。
 *
 * **甲板で待つあいだは 0 で、射出の最後の 25% でこの角度まで起こす**（2026-10-13。
 * `LAUNCH_ROTATE_SHARE`）。待つあいだも 10 度にしていたら前輪が約 1 m 浮いて見えた
 */
export const LAUNCH_PITCH = (10 * Math.PI) / 180

/**
 * 車輪の下端から機体原点までの高さ m。
 *
 * **原点を甲板面に置くと機体が甲板へめり込む。**F/A-18E の原本
 * （`assets/upstream/f18e/scene.gltf`）で降着装置の頂点を測ると、当方の座標で
 * Y −1.659 まで下がる。この値だけ持ち上げると車輪が甲板に接する。
 *
 * `tests/sim/launch.test.ts` が原本を読んで突き合わせるので、機体を
 * 差し替えたときに片方だけ古くならない。**C 型のときは 1.786 だった。**
 * 差し替えで 0.13 m 浮くところだったが、突き合わせの相手を C 型の `.ac` の
 * まま残していたので検査は通っていた。**読む原本も一緒に替える。**
 */
export const GEAR_HEIGHT = 1.659

/**
 * 主輪の接地点の前後位置 m（機体原点から後ろ、+Z）。
 *
 * **機首を起こすときの回転の中心。**原点まわりに回すと、10 度で主輪が甲板へ 0.1 m
 * 沈み、前輪が約 1 m 浮いた（2026-10-13 のユーザーの指摘「前輪が浮いた状態で配置
 * されている」）。主輪の接地点を中心に回せば主輪は甲板に残る。原本の主輪 2 つの
 * 車軸の下（前後 0.29〜1.21 m の中ほど）を測った値
 */
export const MAIN_WHEEL_Z = 0.75

/**
 * 射出の行程のうち、機首を起こすのに使う後ろの割合。
 *
 * **甲板で待つあいだは機首を水平に置く**（2026-10-13、ユーザーの判断）。水平なら前輪も
 * 主輪も甲板に接する（前輪の下端は主輪より 4 cm 高いだけ）。射出の最後の 25%
 * （約 0.6 秒）で `LAUNCH_PITCH` まで滑らかに起こし、離れるときの姿勢は以前と同じにする
 */
export const LAUNCH_ROTATE_SHARE = 0.25

/** 射出の経過 `t` 秒の機首上げ rad。甲板で待つあいだ（`t` ≤ 0）は 0 */
export function launchPitchAt(t: number): number {
  const start = LAUNCH_SECONDS * (1 - LAUNCH_ROTATE_SHARE)
  const u = Math.min(1, Math.max(0, (t - start) / (LAUNCH_SECONDS - start)))
  return LAUNCH_PITCH * u * u * (3 - 2 * u)
}

/**
 * 機首上げ `pitch` のとき、甲板から機体原点までの高さ m。主輪の接地点が甲板に残る
 * よう、接地点（原点から下 `GEAR_HEIGHT`・後ろ `MAIN_WHEEL_Z`）を中心に回した高さ
 */
export function originHeightAt(pitch: number): number {
  return GEAR_HEIGHT * Math.cos(pitch) + MAIN_WHEEL_Z * Math.sin(pitch)
}

/**
 * 射出の設定。空母の位置と向きから決まる。
 *
 * 位置は世界座標。**自機との相対にしない。**空母は動かないものなので、
 * 相対で書くと自機の位置に依存してしまう。
 */
export interface LaunchSpec {
  /** 射出開始の位置 */
  readonly from: Vec3
  /** 射出方向の単位ベクトル。水平 */
  readonly direction: Vec3
}

export interface LaunchView {
  readonly phase: LaunchPhase
  /** 射出を始めてからの経過フレーム。`onDeck` のあいだは 0 */
  readonly frames: number
}

/**
 * カタパルト。
 *
 * **状態を `World` が持ち、`step()` の中で進める。**描画側に置くと
 * キャプチャモード（`sync()` が 1 回だけ）で動かない。
 */
export class Catapult {
  private phaseValue: LaunchPhase = 'onDeck'
  /** 射出を始めたフレーム。まだなら −1 */
  private startedFrame = -1
  private endFrame = 0
  /** 最後に置いた姿勢の機首上げ rad。`World` が姿勢を書くときに読む */
  private pitchValue = 0

  constructor(
    readonly spec: LaunchSpec,
    private readonly fixedDt: number,
  ) {
    this.endFrame = Math.ceil(LAUNCH_SECONDS / fixedDt)
  }

  get phase(): LaunchPhase {
    return this.phaseValue
  }

  /** いまの機首上げ rad。甲板で待つあいだは 0、射出の最後の 25% で `LAUNCH_PITCH` へ */
  get pitch(): number {
    return this.pitchValue
  }

  /** 射出にかかるフレーム数 */
  get durationFrames(): number {
    return this.endFrame
  }

  /**
   * 射出を始める。
   *
   * **二度目は無視する。**押しっぱなしで何度も呼ばれても、始めた
   * フレームが動くと位置が飛ぶ。
   */
  fire(frame: number): void {
    if (this.phaseValue !== 'onDeck') return
    this.phaseValue = 'launching'
    this.startedFrame = frame
  }

  /**
   * 1 ステップ進める。
   *
   * `launching` のあいだは位置と速度を書き換えて true を返す。呼ぶ側は
   * true のとき `Aircraft.step()` を飛ばす。
   */
  update(frame: number, position: Vec3, velocity: Vec3): boolean {
    if (this.phaseValue !== 'launching') return false

    const elapsed = frame - this.startedFrame
    if (elapsed >= this.endFrame) {
      // 終端の位置と速度を置いてから引き渡す
      this.applyAt(this.endFrame * this.fixedDt, position, velocity)
      this.phaseValue = 'airborne'
      return false
    }

    this.applyAt(elapsed * this.fixedDt, position, velocity)
    return true
  }

  /** 経過 `t` 秒の位置と速度。**閉じた式で出す**（積算しない） */
  private applyAt(t: number, position: Vec3, velocity: Vec3): void {
    const s = 0.5 * LAUNCH_ACCEL * t * t
    const v = LAUNCH_ACCEL * t
    this.pitchValue = launchPitchAt(t)
    position.set(
      this.spec.from.x + this.spec.direction.x * s,
      // **車輪の高さぶん上げる。**原点を甲板面に置くとめり込む。機首を起こすあいだは
      // 主輪の接地点を中心に回すので、そのぶんも上げる
      this.spec.from.y + originHeightAt(this.pitchValue) + this.spec.direction.y * s,
      this.spec.from.z + this.spec.direction.z * s,
    )
    velocity.set(
      this.spec.direction.x * v,
      this.spec.direction.y * v,
      this.spec.direction.z * v,
    )
  }

  /** 甲板の待機位置へ置く。射出前の毎ステップ呼ぶ */
  hold(position: Vec3, velocity: Vec3): void {
    this.pitchValue = 0
    position.set(this.spec.from.x, this.spec.from.y + GEAR_HEIGHT, this.spec.from.z)
    velocity.set(0, 0, 0)
  }

  view(frame: number): LaunchView {
    return {
      phase: this.phaseValue,
      frames: this.startedFrame < 0 ? 0 : Math.max(0, frame - this.startedFrame),
    }
  }
}
