/**
 * 履歴のリングバッファ。
 *
 * 軌跡を引くものが共通して使う。**履歴は sim が持つ。**描画側にリングを置くと、
 * キャプチャモードは `sync()` が 1 回しか走らないので何も記録されず、絵が
 * 出ない。履歴は sim の状態なので、リプレイにも後の Phase の AI にも使える。
 *
 * 器は最初に作りきって使い回す。毎ステップ器を作ると、決定論とは無関係に
 * GC でフレーム時間が揺れる。読むときも内部の器そのものを返して写さない。
 * 毎フレーム 768 本をコピーするのは無駄なので、読む側の作法として決めておく。
 *
 * 中身の型は保有者が決める。機体は翼端の水蒸気とスロットルと海抜を持つが、
 * ミサイルの煙は別の駆動量を持つ。リングが知る必要はない。
 */
export class TrailRing<T> {
  private readonly slots: T[]
  /** 記録した通し番号。リングの位置と本数を出すのに使う */
  private written = 0

  /**
   * @param capacity 保持する点の数。超えたら古いほうから上書きする
   * @param create 器を作る。capacity 個ぶん最初に呼ぶ
   */
  constructor(
    readonly capacity: number,
    create: () => T,
  ) {
    this.slots = Array.from({ length: capacity }, create)
  }

  /** 記録済みの点の数。capacity で頭打ち */
  get length(): number {
    return Math.min(this.written, this.capacity)
  }

  /**
   * 次に書き込む器を返して 1 つ進める。
   *
   * 返すのは内部の器そのもの。呼び出し側がその場で値を詰める。
   */
  push(): T {
    const slot = this.slots[this.written % this.capacity]!
    this.written++
    return slot
  }

  /**
   * 新しい順に index 番目。0 が最新。
   *
   * 返すのは内部の器そのもの。保持せずその場で使う。
   *
   * 範囲外は端へ丸める。まだ 1 点も記録していないときは初期状態の器が返る。
   * 呼び出し側が `length` を見てから読むのが前提だが、境界で例外を投げても
   * 描画の役には立たない。
   */
  at(index: number): T {
    const length = this.length
    const clamped = index < 0 ? 0 : index >= length ? length - 1 : index
    // written - 1 - clamped は最小で -capacity になる。2 倍足して負を避ける
    const slot = (this.written - 1 - clamped + this.capacity * 2) % this.capacity
    return this.slots[slot]!
  }
}

/**
 * 履歴を読む側が要る最小限。
 *
 * 描画は保有者（`Aircraft` や `Missile`）の型に縛られない。リボンを張る側は
 * 本数と「新しい順に i 番目」だけを知っていれば足りる。
 */
export interface TrailSource<T> {
  /** 記録済みの点の数 */
  readonly trailLength: number
  /** 新しい順に i 番目。0 が最新 */
  trailPoint(index: number): T
}
