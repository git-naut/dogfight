import { Vec3 } from './vec3'

/**
 * 単位クォータニオンによる姿勢。
 *
 * three.js の Quaternion を使わないのは sim 層を描画から切り離すため。
 * API は意図的に three へ寄せてあるので、render 層で写すときに読み替えが要らない。
 *
 * オイラー角を経由しないのでジンバルロックが原理的に起きない。機首が真上を
 * 向いても破綻しないことは飛行ゲームでは必須になる。
 *
 * 姿勢は body → world の変換を表す。rotate() に body 座標のベクトルを渡すと
 * ワールド座標が返る。
 */
export class Quat {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
    return this
  }

  copy(q: Quat): this {
    this.x = q.x
    this.y = q.y
    this.z = q.z
    this.w = q.w
    return this
  }

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w)
  }

  identity(): this {
    return this.set(0, 0, 0, 1)
  }

  /**
   * 軸まわりの回転。axis は正規化済みであること。
   * 半角を使うのはクォータニオンが回転を二重被覆するため。
   */
  setFromAxisAngle(axis: Vec3, angle: number): this {
    const half = angle * 0.5
    const s = Math.sin(half)
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(half))
  }

  /** this = this * q。body 座標系での回転を重ねるときはこちら。 */
  multiply(q: Quat): this {
    return this.multiplyQuaternions(this, q)
  }

  /** this = q * this。ワールド座標系での回転を重ねるときはこちら。 */
  premultiply(q: Quat): this {
    return this.multiplyQuaternions(q, this)
  }

  multiplyQuaternions(a: Quat, b: Quat): this {
    const { x: ax, y: ay, z: az, w: aw } = a
    const { x: bx, y: by, z: bz, w: bw } = b
    this.x = aw * bx + ax * bw + ay * bz - az * by
    this.y = aw * by - ax * bz + ay * bw + az * bx
    this.z = aw * bz + ax * by - ay * bx + az * bw
    this.w = aw * bw - ax * bx - ay * by - az * bz
    return this
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w
  }

  length(): number {
    return Math.sqrt(this.lengthSq())
  }

  /**
   * 単位長に戻す。
   *
   * 積分を繰り返すと数値誤差で長さが 1 からずれ、回転にスケールが混ざる。
   * 姿勢を更新したら毎ステップ呼ぶ。長さがゼロなら単位元へ倒して NaN を避ける。
   */
  normalize(): this {
    const len = this.length()
    if (len === 0) return this.identity()
    const inv = 1 / len
    this.x *= inv
    this.y *= inv
    this.z *= inv
    this.w *= inv
    return this
  }

  /** 逆回転。単位クォータニオンなら共役と一致する。 */
  invert(): this {
    this.x = -this.x
    this.y = -this.y
    this.z = -this.z
    return this
  }

  dot(q: Quat): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w
  }

  /**
   * ベクトルを回す。out に書いて返す（out は v と同じ実体でもよい）。
   *
   * 行列に展開せず v + 2w(q×v) + 2q×(q×v) の形で計算する。
   * 掛け算の回数が少なく、クォータニオンからの経路も短い。
   */
  rotate(v: Vec3, out: Vec3 = new Vec3()): Vec3 {
    const { x: qx, y: qy, z: qz, w: qw } = this
    const { x: vx, y: vy, z: vz } = v

    // t = 2 * (q_vec × v)
    const tx = 2 * (qy * vz - qz * vy)
    const ty = 2 * (qz * vx - qx * vz)
    const tz = 2 * (qx * vy - qy * vx)

    // out = v + w*t + q_vec × t
    out.x = vx + qw * tx + qy * tz - qz * ty
    out.y = vy + qw * ty + qz * tx - qx * tz
    out.z = vz + qw * tz + qx * ty - qy * tx
    return out
  }

  /** ワールド座標のベクトルを body 座標へ戻す。 */
  rotateInverse(v: Vec3, out: Vec3 = new Vec3()): Vec3 {
    const { x: qx, y: qy, z: qz, w: qw } = this
    const { x: vx, y: vy, z: vz } = v

    // 共役で回す。符号だけ反転させて同じ式を使う。
    const tx = 2 * (-qy * vz + qz * vy)
    const ty = 2 * (-qz * vx + qx * vz)
    const tz = 2 * (-qx * vy + qy * vx)

    out.x = vx + qw * tx - qy * tz + qz * ty
    out.y = vy + qw * ty - qz * tx + qx * tz
    out.z = vz + qw * tz - qx * ty + qy * tx
    return out
  }

  /** 機首方向。座標系の規約により body の -Z（CLAUDE.md 参照）。 */
  forward(out: Vec3 = new Vec3()): Vec3 {
    return this.rotate(FORWARD, out)
  }

  /** 機体上方向。body の +Y。 */
  up(out: Vec3 = new Vec3()): Vec3 {
    return this.rotate(UP, out)
  }

  /** 機体右方向。body の +X。 */
  right(out: Vec3 = new Vec3()): Vec3 {
    return this.rotate(RIGHT, out)
  }

  /**
   * 球面線形補間。描画の補間に使う。
   *
   * 内積が負なら片方を反転してから補間する。クォータニオンは q と -q が
   * 同じ回転を表すため、反転しないと遠回りの経路を通ってしまう。
   */
  slerp(q: Quat, t: number): this {
    if (t === 0) return this
    if (t === 1) return this.copy(q)

    let cos = this.dot(q)
    let bx = q.x
    let by = q.y
    let bz = q.z
    let bw = q.w

    if (cos < 0) {
      cos = -cos
      bx = -bx
      by = -by
      bz = -bz
      bw = -bw
    }

    // ほぼ同じ向きなら線形補間で足りる。sin がゼロに近く割り算が壊れるため。
    if (cos > 0.9995) {
      this.x += (bx - this.x) * t
      this.y += (by - this.y) * t
      this.z += (bz - this.z) * t
      this.w += (bw - this.w) * t
      return this.normalize()
    }

    const theta = Math.acos(cos)
    const sinTheta = Math.sin(theta)
    const a = Math.sin((1 - t) * theta) / sinTheta
    const b = Math.sin(t * theta) / sinTheta

    this.x = this.x * a + bx * b
    this.y = this.y * a + by * b
    this.z = this.z * a + bz * b
    this.w = this.w * a + bw * b
    return this
  }

  /**
   * body 座標系の角速度で dt 秒ぶん回す。
   *
   * 微小回転を近似せず、軸角（指数写像）で厳密に合成する。角速度が大きい
   * フレームでも姿勢が伸び縮みしない。body 軸まわりなので右から掛ける。
   */
  integrateBodyRate(omegaBody: Vec3, dt: number, scratch = new Quat()): this {
    const mag = omegaBody.length()
    if (mag < 1e-9) return this

    const inv = 1 / mag
    scratch.setFromAxisAngle(
      TMP_AXIS.set(omegaBody.x * inv, omegaBody.y * inv, omegaBody.z * inv),
      mag * dt,
    )
    return this.multiply(scratch).normalize()
  }

  approxEquals(q: Quat, epsilon = 1e-6): boolean {
    // q と -q は同じ回転なので、内積の絶対値で比べる。
    return Math.abs(Math.abs(this.dot(q)) - 1) <= epsilon
  }

  isFinite(): boolean {
    return (
      Number.isFinite(this.x) &&
      Number.isFinite(this.y) &&
      Number.isFinite(this.z) &&
      Number.isFinite(this.w)
    )
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w]
  }
}

// 回転の基準となる body 軸。使い回して割り当てを避ける。
const FORWARD = new Vec3(0, 0, -1)
const UP = new Vec3(0, 1, 0)
const RIGHT = new Vec3(1, 0, 0)
const TMP_AXIS = new Vec3()
