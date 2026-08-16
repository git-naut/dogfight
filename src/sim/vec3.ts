/**
 * 3次元ベクトル。
 *
 * three.js の Vector3 を使わないのは、sim 層を描画から切り離すため。
 * ただし API は Vector3 に意図的に合わせてある。render 層で three の
 * Vector3 へ写すときに読み替えが要らないし、three のドキュメントが
 * そのまま参考になる。
 *
 * メソッドは this を破壊的に更新して this を返す。毎フレーム何百個も
 * 生成するとゴミが増えるので、使い回しを基本にする。新しい値が要るときは
 * clone() を明示的に呼ぶ。
 */
export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  copy(v: Vec3): this {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z)
  }

  add(v: Vec3): this {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }

  /** this += v * s。力の積算で最も使う形なので専用に持つ。 */
  addScaledVector(v: Vec3, s: number): this {
    this.x += v.x * s
    this.y += v.y * s
    this.z += v.z * s
    return this
  }

  sub(v: Vec3): this {
    this.x -= v.x
    this.y -= v.y
    this.z -= v.z
    return this
  }

  /** this = a - b */
  subVectors(a: Vec3, b: Vec3): this {
    this.x = a.x - b.x
    this.y = a.y - b.y
    this.z = a.z - b.z
    return this
  }

  multiplyScalar(s: number): this {
    this.x *= s
    this.y *= s
    this.z *= s
    return this
  }

  negate(): this {
    this.x = -this.x
    this.y = -this.y
    this.z = -this.z
    return this
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z
  }

  /** this = a × b。自分自身を引数に渡しても壊れないよう一時変数に退避する。 */
  crossVectors(a: Vec3, b: Vec3): this {
    const ax = a.x
    const ay = a.y
    const az = a.z
    const bx = b.x
    const by = b.y
    const bz = b.z
    this.x = ay * bz - az * by
    this.y = az * bx - ax * bz
    this.z = ax * by - ay * bx
    return this
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }

  length(): number {
    return Math.sqrt(this.lengthSq())
  }

  /** 長さを 1 にする。ゼロベクトルはゼロのまま返す（NaN を出さない）。 */
  normalize(): this {
    const len = this.length()
    if (len > 0) this.multiplyScalar(1 / len)
    return this
  }

  /** 長さを max で頭打ちにする。加速度の上限などに使う。 */
  clampLength(max: number): this {
    const lenSq = this.lengthSq()
    if (lenSq > max * max && lenSq > 0) {
      this.multiplyScalar(max / Math.sqrt(lenSq))
    }
    return this
  }

  distanceToSq(v: Vec3): number {
    const dx = this.x - v.x
    const dy = this.y - v.y
    const dz = this.z - v.z
    return dx * dx + dy * dy + dz * dz
  }

  distanceTo(v: Vec3): number {
    return Math.sqrt(this.distanceToSq(v))
  }

  /** this を v の方へ t だけ寄せる。横滑り抑制やカメラ追従で使う。 */
  lerp(v: Vec3, t: number): this {
    this.x += (v.x - this.x) * t
    this.y += (v.y - this.y) * t
    this.z += (v.z - this.z) * t
    return this
  }

  /** 誤差を許した一致判定。テスト用。 */
  approxEquals(v: Vec3, epsilon = 1e-6): boolean {
    return (
      Math.abs(this.x - v.x) <= epsilon &&
      Math.abs(this.y - v.y) <= epsilon &&
      Math.abs(this.z - v.z) <= epsilon
    )
  }

  isFinite(): boolean {
    return (
      Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z)
    )
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z]
  }

  static readonly ZERO: Readonly<Vec3> = new Vec3(0, 0, 0)
  /** ワールドの上方向。座標系は右手系・Y up（CLAUDE.md 参照）。 */
  static readonly UP: Readonly<Vec3> = new Vec3(0, 1, 0)
  /** 機首方向の基準。three のカメラと揃えて -Z を前とする。 */
  static readonly FORWARD: Readonly<Vec3> = new Vec3(0, 0, -1)
  static readonly RIGHT: Readonly<Vec3> = new Vec3(1, 0, 0)
}
