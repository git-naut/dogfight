/**
 * ミッションの勝敗。
 *
 * **状態は sim が持つ。**キャプチャモードは `sync()` が 1 回しか走らないので、
 * 描画側に置くと何も出ない（`combat.ts` と同じ理由）。
 *
 * `Combat` に混ぜない。あちらは既に発射管制と当たり判定で 600 行を超えていて、
 * コメントにも「`World.step()` に並べると読めなくなるので分けた」とある。
 * 勝敗の判定はさらに別の関心なので、もう 1 段分ける。
 */

/**
 * ミッションの決着。
 *
 * `running` のあいだだけ時計が進む。決着したら二度と変わらない。
 */
export type MissionOutcome =
  /** 進行中 */
  | 'running'
  /** 成功。敵が全滅した */
  | 'cleared'
  /** 失敗。制限時間を使い切った */
  | 'timeout'
  /** 失敗。敵に落とされた */
  | 'shotDown'
  /** 失敗。自分で落ちた（地形への衝突、失速からの回復失敗） */
  | 'crashed'

/** 決着したか。`running` 以外はすべて決着 */
export function isSettled(outcome: MissionOutcome): boolean {
  return outcome !== 'running'
}

/** 成功したか */
export function isCleared(outcome: MissionOutcome): boolean {
  return outcome === 'cleared'
}

export interface MissionSpec {
  /**
   * 制限時間 フレーム。
   *
   * **秒ではなくフレームで持つ。**`World.time` は `frame * FIXED_DT` の
   * 浮動小数なので、`time >= 180.0` の境界がフレームによって揺れる。
   * `frame >= limitFrames` なら整数の比較で揺れない。`Combat` も同じ流儀で
   * 経過秒を持たずフレームを受け取る。
   */
  readonly limitFrames: number
}

/**
 * ミッションが見る世界の断面。
 *
 * **`World` を丸ごと受け取らない。**`World` が `Mission` を持ち、`Mission` が
 * `World` を知ると相互に依存する。判定に要るのはこの 5 つだけなので、
 * それだけを渡す。テストも組みやすい。
 */
export interface MissionView {
  /** いまのフレーム */
  readonly frame: number
  /** 生きている敵の数 */
  readonly enemiesAlive: number
  /**
   * 自機が敵に落とされた回数。
   *
   * **地形への衝突は入らない。**`Combat` は敵の機銃とミサイルしか見ておらず、
   * 山にぶつかっても増えない（`combat.ts` の `losses`）。
   */
  readonly playerLosses: number
  /**
   * 自機が落ちたか。
   *
   * 地形への衝突でも耐久ゼロでも立つ（`aircraft.ts`）。**`playerLosses` と
   * 両方を見ないと、山にぶつかった失敗を取りこぼす。**
   */
  readonly playerCrashed: boolean
}

/**
 * ミッションの状態。
 *
 * `World` が持ち、`step()` の末尾で 1 回評価する。
 */
export class Mission {
  readonly spec: MissionSpec

  private _outcome: MissionOutcome = 'running'
  private _endedFrame = -1

  constructor(spec: MissionSpec) {
    this.spec = spec
  }

  get outcome(): MissionOutcome {
    return this._outcome
  }

  /** 決着したフレーム。`running` のあいだは −1 */
  get endedFrame(): number {
    return this._endedFrame
  }

  /**
   * 残り時間 フレーム。決着していたらそこで止まる。
   *
   * 0 より下へは行かない。
   */
  remainingFrames(frame: number): number {
    const at = this._endedFrame >= 0 ? this._endedFrame : frame
    return Math.max(0, this.spec.limitFrames - at)
  }

  /**
   * 判定する。毎ステップ呼ぶ。
   *
   * **決着したら二度と変わらない。**成功のあとに時間切れで上書きされたり、
   * 落ちたあとに敵が全滅して成功になったりしない。
   *
   * 順序に意味がある。**成功を先に見る。**最後の 1 機を落とした瞬間に自分も
   * 落ちる相打ちは成功にする。撃墜が先に成立しているため。
   */
  update(view: MissionView): void {
    if (this._outcome !== 'running') return

    if (view.enemiesAlive === 0) {
      this.settle('cleared', view.frame)
      return
    }
    if (view.playerLosses > 0) {
      this.settle('shotDown', view.frame)
      return
    }
    if (view.playerCrashed) {
      this.settle('crashed', view.frame)
      return
    }
    if (view.frame >= this.spec.limitFrames) {
      this.settle('timeout', view.frame)
    }
  }

  private settle(outcome: MissionOutcome, frame: number): void {
    this._outcome = outcome
    this._endedFrame = frame
  }
}
