/**
 * すれ違いの判定（Phase 10 の段 B11d、ADR 0040）。**純粋な状態だけ。**
 *
 * 敵機が自機の近くをすれ違った瞬間に、通過の音を鳴らす。音の層は sim の増えていくだけの数の差を見て
 * 鳴らす（`audio/events.ts`）ので、判定もここに置いて `World` が数える。キャプチャモード（決まった
 * フレームまで一気に進める）でも数えられる。時刻は呼ぶ側が `frame * FIXED_DT` で渡す
 */

/** すれ違いとみなす距離 m（推測、ユーザーの決定） */
export const FLYBY_RANGE = 300
/** 同じ相手のすれ違いの音を鳴らしてから、次に鳴らせるまでの秒 */
export const FLYBY_COOLDOWN = 5

/**
 * すれ違いの判定。相手ごとに前の距離を覚え、`FLYBY_RANGE` の内で近づくから遠ざかるに変わったとき
 * （いちばん近づいた直後）に 1 回だけ true を返す。同じ相手は `FLYBY_COOLDOWN` 秒あける
 */
export class FlybyTracker {
  private readonly previous = new Map<number, number>()
  private readonly approaching = new Map<number, boolean>()
  private readonly lastAt = new Map<number, number>()

  /** 相手 `id` の今の距離 `distance` m と時刻 `now` 秒。すれ違った瞬間に true */
  update(id: number, distance: number, now: number): boolean {
    const prev = this.previous.get(id)
    this.previous.set(id, distance)
    if (prev === undefined) return false
    const wasApproaching = this.approaching.get(id) ?? false
    const nowApproaching = distance < prev
    this.approaching.set(id, nowApproaching)
    if (!wasApproaching || nowApproaching || prev > FLYBY_RANGE) return false
    const last = this.lastAt.get(id) ?? -Infinity
    if (now - last < FLYBY_COOLDOWN) return false
    this.lastAt.set(id, now)
    return true
  }

  /** 相手が消えたら忘れる */
  forget(id: number): void {
    this.previous.delete(id)
    this.approaching.delete(id)
    this.lastAt.delete(id)
  }
}
