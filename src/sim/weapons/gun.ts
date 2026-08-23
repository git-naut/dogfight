import { Vec3 } from '../vec3'
import { GRAVITY, SEA_LEVEL_DENSITY, airDensity } from '../isa'
import type { Rng } from '../rng'

/**
 * 機銃。
 *
 * 実弾を飛ばす。hitscan にしない。弾道が落ちるのでリードを覚える必要が生まれ、
 * 書ける物理が残る。
 *
 * 諸元は F/A-18C の M61A1 Vulcan の公表値を出発点にした。**これは公表値で
 * あって当プロジェクトの実測ではない。**
 *
 * | 項目 | 値 | 出どころ |
 * | 口径 | 20 mm | 公表値 |
 * | 発射速度 | 6,000 発/分 = 100 発/秒 | 公表値 |
 * | 初速 | 1,030 m/s | 公表値 |
 * | 携行弾数 | 578 発 | 公表値 |
 * | 弾量 | 102 g（M56 HEI） | 公表値 |
 * | 抗力係数 | 0.3 | **公表値がない。**下の導出で置いた |
 *
 * 抗力係数の置き方。減速は a = ρv²·Cd·A / (2m) で、断面積 A = π(0.010)² =
 * 3.1416e-4 m²、弾量 0.102 kg なので A/m = 3.08e-3 m²/kg。海面で
 *
 *   a = 0.5 × 1.225 × v² × Cd × 3.08e-3 = 1.887e-3 · Cd · v²
 *
 * Cd = 0.3 なら初速で 600 m/s²。dv/dt = −k v²（k = 5.66e-4 /m）を解くと
 *
 *   v(t) = v₀ / (1 + k v₀ t)      x(t) = ln(1 + k v₀ t) / k
 *
 * 実測（この式を回した値）。
 *
 * | 経過 | 速度 | 飛距離 | 重力の落ち |
 * | 0.25 s | 899 m/s | 240 m | 0.3 m |
 * | 0.50 s | 798 m/s | 452 m | 1.2 m |
 * | 1.00 s | 651 m/s | 812 m | 4.9 m |
 * | 2.50 s | 419 m/s | 1,589 m | 30.6 m |
 *
 * 航空機砲の有効射程がその程度に収まるので、出発点としては妥当な範囲にある。
 * 300 m なら 0.32 秒で届き、落ちは 0.5 m。狙いの補正が要る大きさになる。
 */

/** 初速 m/s。公表値 */
export const MUZZLE_SPEED = 1030
/** 毎秒の発射数。6,000 発/分 */
export const ROUNDS_PER_SECOND = 100
/** 携行弾数。公表値 */
export const MAGAZINE = 578
/** 弾量 kg。M56 HEI の公表値 */
const BULLET_MASS = 0.102
/** 弾径 m */
const BULLET_DIAMETER = 0.020
/** 抗力係数。公表値がないので上の導出で置いた値 */
const BULLET_DRAG_COEFFICIENT = 0.3

/**
 * 抗力の係数 1/m。
 *
 * a = DRAG_K · (ρ/ρ₀) · v² になるようにまとめてある。海面で 5.659e-4 /m、
 * 初速 1,030 m/s での減速は 600 m/s²。
 */
export const DRAG_K =
  (0.5 *
    SEA_LEVEL_DENSITY *
    BULLET_DRAG_COEFFICIENT *
    Math.PI *
    (BULLET_DIAMETER / 2) ** 2) /
  BULLET_MASS

/**
 * 弾の寿命 秒。
 *
 * 2.5 秒で 1,589 m 飛ぶ。それより遠いところで当たっても、狙って当てたとは
 * 言えない。寿命 × 発射速度が同時に生きる弾の上限（250 発）を決める。
 */
export const BULLET_LIFETIME = 2.5

/** 弾のプールの大きさ。寿命 2.5 秒 × 100 発/秒 に余裕を足す */
export const BULLET_POOL = 272

/**
 * 敵機の弾のプールの大きさ。
 *
 * 敵は連射しない。1 回のバーストが `BURST_ROUNDS` 発で、前のバーストが
 * まだ飛んでいるうちに次を撃つことがあるので 2 回ぶん見込む。**足りないと
 * 古い弾を上書きして、曳光弾が途中で消える。**
 */
export const ENEMY_BULLET_POOL = 160

/** 何発に 1 発を曳光弾にするか */
export const TRACER_INTERVAL = 5

/**
 * 散布。機軸からのずれの標準的な大きさ rad。
 *
 * 実銃には数ミリラジアンの散布がある。0 にすると弾が 1 本の線に重なって
 * レーザーに見える。3 mrad なら 300 m で 0.9 m ばらける。乱数は `Rng` を
 * 通すので、同じ入力からは同じ散布になる。
 */
export const DISPERSION = 0.003

/**
 * 銃口の位置（機体座標）。
 *
 * M61 は機首の上側にある。機首は Z = −8.0、胴体の断面は Y −0.62..1.09 なので
 * その上寄り。**実機の正確な位置は測っていない。**300 m 先を狙うときの角度差は
 * 0.1 度に届かないので、照準の計算には効かない。
 */
export const MUZZLE_OFFSET = new Vec3(0, 0.55, -7.2)

export interface Bullet {
  /** 現ステップの位置 */
  readonly position: Vec3
  /** 前ステップの位置。掃引の当たり判定に使う */
  readonly previous: Vec3
  readonly velocity: Vec3
  /** 残り寿命 秒。0 以下なら死んでいる */
  life: number
  /** 曳光弾か。描画が光る筋にする */
  tracer: boolean
}

function createBullet(): Bullet {
  return {
    position: new Vec3(),
    previous: new Vec3(),
    velocity: new Vec3(),
    life: 0,
    tracer: false,
  }
}

/** 弾を読む側が要る最小限。描画は Gun の型に縛られない */
export interface BulletSource {
  /** プールの大きさ。生きているかは life で見る */
  readonly bulletCapacity: number
  bulletAt(index: number): Bullet
  /** 生きている弾の数 */
  readonly bulletsInFlight: number
}

// 一時変数。使い回してゴミを出さない
const tmpDir = new Vec3()
const tmpRight = new Vec3()
const tmpUp = new Vec3()

export class Gun {
  private readonly pool: Bullet[]
  /** プールの大きさ。自機は 272、敵は 160 */
  private readonly capacity: number
  /** 次に使う枠。埋まっていたら古いものを上書きする */
  private next = 0
  /** 発射の端数。1 ステップ 0.833 発なので持ち越す */
  private pending = 0
  /** 撃った通し番号。曳光弾の間隔に使う */
  private fired = 0

  /** 残弾 */
  rounds: number

  /**
   * @param capacity 弾のプールの大きさ
   * @param magazine 携行弾数
   */
  constructor(capacity = BULLET_POOL, magazine = MAGAZINE) {
    this.capacity = capacity
    this.magazine = magazine
    this.rounds = magazine
    this.pool = Array.from({ length: capacity }, createBullet)
  }

  private readonly magazine: number
  /**
   * 生きている弾の数。
   *
   * `advance` で数え直し、`spawn` で足す。古い枠を上書きしたときに二重に
   * 数える可能性があるが、上書きが起きるのはプールが埋まったとき（寿命 2.5 秒
   * × 100 発/秒 = 250 に対して枠は 272）だけなので、次の `advance` で戻る。
   */
  private live = 0

  get bulletCapacity(): number {
    return this.capacity
  }

  get bulletsInFlight(): number {
    return this.live
  }

  bulletAt(index: number): Bullet {
    return this.pool[index % this.capacity]!
  }

  /** 撃った弾の総数。命中率を出すのに使う */
  get roundsFired(): number {
    return this.fired
  }

  /**
   * 弾を進める。重力と抗力を受ける。
   *
   * 抗力は空気密度に比例するので高度で効きが変わる。積分は semi-implicit
   * Euler（速度を先に更新してから位置に使う）で、機体と同じ作法。
   *
   * @param groundLimit この高度を下回ったら地形を引く。地図の最高点で決める
   * @param terrain 地形。渡さなければ海面（高度 0）で消える
   */
  advance(
    dt: number,
    groundLimit: number,
    terrain?: { heightAt(x: number, z: number): number },
  ): void {
    let live = 0
    for (const bullet of this.pool) {
      if (bullet.life <= 0) continue
      bullet.life -= dt
      if (bullet.life <= 0) continue

      bullet.previous.copy(bullet.position)

      const speed = bullet.velocity.length()
      if (speed > 0) {
        const density = airDensity(bullet.position.y)
        // a = DRAG_K · (ρ/ρ₀) · v² を速度の逆向きへ
        const decel = DRAG_K * (density / SEA_LEVEL_DENSITY) * speed * speed
        bullet.velocity.addScaledVector(bullet.velocity, (-decel * dt) / speed)
      }
      bullet.velocity.y -= GRAVITY * dt
      bullet.position.addScaledVector(bullet.velocity, dt)

      // 地面に当たったら消す。高いところでは地形を引かない
      if (bullet.position.y < groundLimit) {
        const ground = terrain
          ? terrain.heightAt(bullet.position.x, bullet.position.z)
          : 0
        if (bullet.position.y <= (ground > 0 ? ground : 0)) {
          bullet.life = 0
          continue
        }
      }
      live++
    }
    this.live = live
  }

  /**
   * 引き金を引いているあいだ弾を出す。
   *
   * 1 ステップあたり 0.833 発なので端数を持ち越す。持ち越さないと 120Hz で
   * 毎ステップ 1 発になり、発射速度が 120 発/秒に化ける。
   *
   * @param nose 機首方向の単位ベクトル
   * @param up 機体上方向の単位ベクトル。散布の向きを作るのに使う
   * @param right 機体右方向の単位ベクトル
   * @param carrier 機体の速度。弾はこれを引き継ぐ
   */
  fire(
    dt: number,
    firing: boolean,
    muzzle: Vec3,
    nose: Vec3,
    right: Vec3,
    up: Vec3,
    carrier: Vec3,
    rng: Rng,
  ): number {
    if (!firing || this.rounds <= 0) {
      // 引き金を離したら端数を捨てる。ためておくと、押した瞬間にまとめて出る
      this.pending = 0
      return 0
    }

    this.pending += ROUNDS_PER_SECOND * dt
    let spawned = 0
    while (this.pending >= 1 && this.rounds > 0) {
      this.pending -= 1
      this.rounds -= 1
      this.spawn(muzzle, nose, right, up, carrier, rng)
      spawned++
    }
    return spawned
  }

  private spawn(
    muzzle: Vec3,
    nose: Vec3,
    right: Vec3,
    up: Vec3,
    carrier: Vec3,
    rng: Rng,
  ): void {
    const bullet = this.pool[this.next]!
    this.next = (this.next + 1) % this.capacity

    // 散布。機軸のまわりに一様な向きへ、半径は正規分布に近い形で振る。
    // 2 つの一様乱数から Box-Muller を使わず、和で近似する（分布の裾より
    // 決定論と安さを取る）
    const angle = rng.next() * Math.PI * 2
    const spread = (rng.next() + rng.next() - 1) * DISPERSION
    tmpDir.copy(nose)
    tmpRight.copy(right).multiplyScalar(Math.cos(angle) * spread)
    tmpUp.copy(up).multiplyScalar(Math.sin(angle) * spread)
    tmpDir.add(tmpRight).add(tmpUp).normalize()

    bullet.position.copy(muzzle)
    bullet.previous.copy(muzzle)
    // 弾は機体の速度を引き継ぐ。地面から見た初速は機体速度ぶん速い
    bullet.velocity.copy(carrier).addScaledVector(tmpDir, MUZZLE_SPEED)
    bullet.life = BULLET_LIFETIME
    bullet.tracer = this.fired % TRACER_INTERVAL === 0
    this.fired++
    // 生まれた弾もその場で数える。advance のときだけ数え直す作りにすると、
    // 同じステップで生まれた弾が抜けて 1 発ずれる
    this.live++
  }

  /** 弾を全部消して残弾を戻す。ワールドを作り直すときに呼ぶ */
  reset(): void {
    for (const bullet of this.pool) bullet.life = 0
    this.rounds = this.magazine
    this.pending = 0
    this.fired = 0
    this.live = 0
    this.next = 0
  }
}

/**
 * 弾の速度と飛距離の閉形式。
 *
 * dv/dt = −k v² を解いた形。抗力だけを見て重力を無視した値で、照準の
 * 予測とテストの検算に使う。k は海面の値。
 */
export function bulletSpeedAfter(seconds: number, muzzle = MUZZLE_SPEED): number {
  return muzzle / (1 + DRAG_K * muzzle * seconds)
}

/** 抗力だけを見た飛距離 m */
export function bulletRangeAfter(seconds: number, muzzle = MUZZLE_SPEED): number {
  return Math.log(1 + DRAG_K * muzzle * seconds) / DRAG_K
}

/**
 * 距離 range まで飛ぶのにかかる秒数。
 *
 * 上の飛距離の式を逆に解いたもの。ガンレティクルの予測に使う。
 * 抗力だけを見た値なので、重力の落ちは別に足す。
 */
export function bulletTimeToRange(range: number, muzzle = MUZZLE_SPEED): number {
  return (Math.exp(DRAG_K * range) - 1) / (DRAG_K * muzzle)
}
