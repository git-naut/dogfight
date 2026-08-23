import type { Vec3 } from './vec3'
import type { Quat } from './quat'

/**
 * 撃たれる側。
 *
 * 機銃・ロックオン・ミサイル・当たり判定が相手に求めるものは、これだけ。
 * 実測で確かめた内訳を書いておく。
 *
 * | 使う側 | 読むもの |
 * | `Combat.resolveHits` | `position` `orientation` `alive` `damage()` |
 * | `Lock.pick` / `Lock.measure` | `position` `velocity` `alive` |
 * | `Missile.guide` / `checkFuze` | `position` `velocity` `orientation` `alive` |
 * | `Combat.updateDlz` | `speed` |
 *
 * `hitbox.sweptHitsAircraft` は位置と姿勢を生で取るので、もともと型に依らない。
 *
 * **`Target` を直に参照していたのを、この型に置き換える。**Phase 6 の敵機は
 * `Aircraft` を保有する別の形になるが、撃たれる側としては区別が要らない。
 * 計測用の台本は `Target`（決められた軌跡を飛ぶ剛体）を使い続けるので、
 * 両方が同じ列に並ぶ必要がある。
 *
 * 姿勢が要るのは当たり判定のため。カプセルは機体座標で置いてあるので、
 * 弾の線分を機体座標へ回すのに `orientation` の逆回転を使う。
 */
export interface Combatant {
  /** 位置 m（ワールド） */
  readonly position: Vec3
  /** 速度 m/s（ワールド） */
  readonly velocity: Vec3
  /** 姿勢。当たり判定のカプセルを機体座標へ戻すのに使う */
  readonly orientation: Quat
  /** 対気速度 m/s。DLZ が目標の速さとして読む */
  readonly speed: number
  /** 生きているか。落ちたらロックも当たり判定も外す */
  readonly alive: boolean
  /**
   * ダメージを与える。**落ちた瞬間だけ true を返す。**
   *
   * 落ちたあとの弾で撃墜数を二重に数えないため、返り値で遷移を見分ける。
   */
  damage(amount: number): boolean
}
