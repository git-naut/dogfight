/**
 * シード付き擬似乱数。
 *
 * Math.random() を使うと同じ入力から同じ結果が出なくなり、リプレイ検証も
 * スクリーンショット回帰も成立しない。sim 層とエフェクトの乱数はすべて
 * ここを通す。
 *
 * アルゴリズムは mulberry32。32bit の状態ひとつで済み、周期は 2^32、
 * 分布も実用上十分。ゲームの用途では暗号強度は要らない。
 */
export class Rng {
  private state: number

  constructor(seed: number) {
    // >>> 0 で符号なし 32bit に丸める。負のシードを渡されても壊れない。
    this.state = seed >>> 0
  }

  /** [0, 1) の一様乱数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** [min, max) の一様乱数 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** [min, max] の整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** -1 か +1 */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1
  }

  /**
   * 現在の状態を保ったまま複製する。
   * 「この時点から先の乱数列」を本流を汚さずに試したいときに使う。
   */
  clone(): Rng {
    const copy = new Rng(0)
    copy.state = this.state
    return copy
  }

  /** 現在の内部状態。デバッグとテストの比較用。 */
  get snapshot(): number {
    return this.state
  }
}
