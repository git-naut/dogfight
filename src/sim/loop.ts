/**
 * 固定ステップのシミュレーション駆動。
 *
 * 描画のフレームレートは環境によって 30 にも 144 にもなるが、物理を実時間の
 * 差分で進めると結果が環境ごとに変わってしまう。同じ入力から同じ結果を出す
 * ためにシムは常に FIXED_DT 秒ずつ進め、余った時間は次フレームへ繰り越す。
 *
 * 描画側は alpha（次ステップまでの進み具合）を受け取って前後の状態を補間し、
 * 120Hz 未満の描画でも滑らかに見せる。
 */

/** シムの1ステップ。120Hz。高速な機動と高速なミサイルを扱うので粗くしない。 */
export const FIXED_DT = 1 / 120

/**
 * 1回の描画フレームで進めるステップ数の上限。
 *
 * タブが裏に回った直後などに巨大な realDelta が来ると、追いつこうとして
 * 何百ステップも回り、さらに遅れて雪だるま式に破綻する（spiral of death）。
 * 上限で打ち切り、遅れた分は捨てる。ゲーム内時間は遅れるが停止はしない。
 *
 * 10 は 1/12 秒ぶんの追いつき余地。描画が 30fps まで落ちても 1 フレームは
 * 4 ステップなので、軽い引っかかりを吸収してなお余る。
 */
export const MAX_STEPS_PER_FRAME = 10

export class FixedStepDriver {
  /** まだ消化していない実時間の残り。 */
  private accumulator = 0

  /** 上限に当たって捨てたステップ数の累計。性能問題の検知に使う。 */
  private dropped = 0

  constructor(
    private readonly dt: number = FIXED_DT,
    private readonly maxSteps: number = MAX_STEPS_PER_FRAME,
  ) {}

  /**
   * 実時間の経過分だけ step を呼ぶ。
   *
   * @param realDelta 前フレームからの経過秒
   * @param step 1 ステップ進める処理
   * @returns alpha。次ステップまでどれだけ進んだか [0, 1)
   */
  advance(realDelta: number, step: () => void): number {
    // 負の delta や NaN が来ても壊さない。
    if (!Number.isFinite(realDelta) || realDelta < 0) realDelta = 0

    this.accumulator += realDelta

    let steps = 0
    while (this.accumulator >= this.dt) {
      if (steps >= this.maxSteps) {
        // 消化しきれない分は捨てる。繰り越すと次フレームがさらに重くなる。
        const lost = Math.floor(this.accumulator / this.dt)
        this.dropped += lost
        this.accumulator = 0
        break
      }
      this.accumulator -= this.dt
      step()
      steps++
    }

    return this.accumulator / this.dt
  }

  /** 捨てたステップ数の累計。 */
  get droppedSteps(): number {
    return this.dropped
  }

  /** 蓄積をリセットする。ポーズ明けや capture モードの開始時に呼ぶ。 */
  reset(): void {
    this.accumulator = 0
  }
}
