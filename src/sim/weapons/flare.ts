import { Vec3 } from '../vec3'
import { GRAVITY, airDensity } from '../isa'
import type { HeatSource } from '../combatant'

/**
 * フレア。赤外線ミサイルの囮。
 *
 * 投下したら自機の速度を引き継ぎ、抗力で急に減速しながら落ちる。**この
 * 「急に減速する」が囮として効く理由。**機体は 250 m/s で飛び続けるので、
 * 1 秒もあれば数十メートル離れる。ミサイルのシーカーから見て別の方向に
 * なったとき、初めて選択の対象になる。
 *
 * 燃えている間だけ熱源として見える（`alive`）。消えたらシーカーは本来の
 * 標的へ戻る。
 *
 * ## 実機の値
 *
 * MJU-7 は約 0.2 kg、断面は 5 x 2.5 cm ほどとされる。**燃焼時間と光度は
 * 公表されていない。**マグネシウム系の火工品で数秒とされる範囲を出発点に
 * して、実測で決める。
 *
 * | 項目 | 値 | 出どころ |
 * | 質量 | 0.2 kg | 公表値として引用される範囲 |
 * | 断面積 | 0.00125 m² | 5 x 2.5 cm から |
 * | 抗力係数 | 1.2 | **選んだ値。**角柱の範囲 |
 * | 燃焼時間 | 実測で決める | — |
 * | 投下の間隔 | 実測で決める | — |
 * | 1 回の枚数 | 実測で決める | — |
 *
 * ## 落ちる速さ
 *
 * 終端速度は抗力と重力のつり合いから
 *
 *   v_t = sqrt(2 m g / (ρ C_d A))
 *
 * 高度 3,000 m（ρ = 0.909 kg/m³）で m = 0.2、C_d = 1.2、A = 0.00125 なら
 *
 *   v_t = sqrt(2 · 0.2 · 9.80665 / (0.909 · 1.2 · 0.00125)) = 47.9 m/s
 *
 * **投下直後は 250 m/s で飛んでいるので、そこから 48 m/s まで落ちる。**
 * 減速の時定数は m / (0.5 ρ C_d A v) で、v = 250 なら 0.47 秒。
 */

/** 質量 kg。公表値として引用される範囲 */
export const FLARE_MASS = 0.2
/** 断面積 m²。5 x 2.5 cm から */
export const FLARE_AREA = 0.00125
/** 抗力係数。選んだ値。角柱の範囲 */
export const FLARE_DRAG_COEFFICIENT = 1.2

/**
 * 熱の強さ。機体の排気を 1 とした相対値。
 *
 * **幾何だけでは囮が原理的に効かない。**実測で確かめた（`docs/weapons.md`）。
 * ミサイルが機体を正確に追っている限り、機体への視線角は 0.00 度。軸から
 * 外れるフレアは決して選ばれず、4.8 秒のあいだ一度も掴まなかった。
 *
 * 実機のフレアが騙せるのは、機体の排気よりはるかに明るいから。マグネシウム系の
 * 火工品で 2,000 K 前後まで上がるとされ、タービン排気の 700〜900 K より高い。
 * 放射は温度の 4 乗に比例するので、面積が小さくても総量で勝つ。**具体的な
 * 倍率は公表されていないので、実測で決めた。**
 *
 * 2, 4, 6, 8, 16, 32 を振って挙動を見た。**6 以上は飽和してどの方向でも
 * 効く。**4 なら真後ろだけが確実で、横からは効かない。
 *
 * | 撃たれた方向 | なし | 0.5s | 1.0s | 1.5s | 2.0s |
 * | 180 度（真後ろ） | 命中 | 囮 | 囮 | 囮 | 囮 |
 * | 135 度 | 命中 | 命中 | 命中 | 外れ | 外れ |
 * | 90 度 | 命中 | 命中 | 命中 | 命中 | 命中 |
 * | 45 度 | 命中 | 外れ | 外れ | 囮 | 囮 |
 * | 0 度（正面） | 命中 | 命中 | 命中 | 命中 | 囮 |
 *
 * 「囮」はフレアを掴んで外れた、「外れ」は誘導を失って自滅した状態。
 *
 * **真後ろにつかれたらフレアで振り切れるが、横からは旋回で逃げるしかない。**
 * それが駆け引きになる。正面から早めに出しても効かないのは、フレアが機体の
 * 向こう側へ落ちて距離で不利になるから。着弾直前（2.0 秒）なら効く。
 */
export const FLARE_INTENSITY = 4

/**
 * 燃焼時間 秒。
 *
 * **囮が効くには「機体から十分離れる」時間が要る。**離れる前に消えると
 * シーカーは標的へ戻ってしまう。実測で決めた値をここに書く。
 */
export const FLARE_BURN_SECONDS = 4

/**
 * 投下 1 回あたりの枚数。
 *
 * 実機は左右から複数を撒く。ここは実測で決める。
 */
export const FLARE_PER_DEPLOY = 2

/** 同じ投下で撒く枚数どうしの横方向の散らばり m/s。左右へ分ける */
export const FLARE_SPREAD_SPEED = 8

/** 投下の間隔 秒。押しっぱなしで撒き続けない */
export const FLARE_INTERVAL = 0.5

/** 積んでいる数 */
export const FLARE_CAPACITY = 30

/**
 * 閃光が収まるまでの秒数。
 *
 * マグネシウム系の火工品は点火から一瞬で最大光度へ達し、そのあと安定した
 * 燃焼へ落ちる。**見た目だけの値で、囮としての効き方には関わらない。**
 * シーカーが使う `FLARE_INTENSITY` は燃焼のあいだ一定のまま。
 *
 * 0.25 秒は 60fps で 15 フレーム。これより短いと絵として読めない。
 */
export const FLARE_FLASH_SECONDS = 0.25

/**
 * 閃光の強さ 0..1。点火の瞬間が 1 で、`FLARE_FLASH_SECONDS` で 0 になる。
 *
 * 描画側がこの値で白熱と赤を混ぜ、大きさと濃さを持ち上げる。二乗で落とすと
 * 立ち上がりが鋭く、尾を引かない。
 *
 * @param burned 点火からの経過秒
 */
export function flashIntensity(burned: number): number {
  if (burned <= 0) return 1
  if (burned >= FLARE_FLASH_SECONDS) return 0
  const t = 1 - burned / FLARE_FLASH_SECONDS
  return t * t
}

/** 排気口の後ろ。ここから出す（機体座標） */
export const FLARE_OFFSET = new Vec3(0, -1, 3)

// 一時変数。使い回してゴミを出さない
const drag = new Vec3()
const offset = new Vec3()
const lateral = new Vec3()

/**
 * フレア 1 発。
 *
 * `HeatSource` を満たすので、シーカーからは機体と同じ列に並ぶ。**姿勢も
 * 対気速度も持たない。**それが `Tracked` ではなく `HeatSource` を切り出した
 * 理由。
 */
export class Flare implements HeatSource {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  /** 残りの燃焼 秒。0 以下で消える */
  burn = 0
  /** 熱の強さ。機体の排気を 1 とした相対値 */
  readonly intensity = FLARE_INTENSITY

  get alive(): boolean {
    return this.burn > 0
  }

  /** 投下。機体の位置と速度を引き継ぎ、横へ散らす */
  ignite(position: Vec3, velocity: Vec3, lateralVelocity: Vec3): void {
    this.position.copy(position)
    this.velocity.copy(velocity).add(lateralVelocity)
    this.burn = FLARE_BURN_SECONDS
  }

  /** 1 ステップ進める。抗力で減速しながら落ちる */
  step(dt: number): void {
    if (!this.alive) return
    this.burn -= dt

    const speed = this.velocity.length()
    if (speed > 1e-6) {
      const density = airDensity(this.position.y)
      const magnitude =
        (0.5 * density * speed * speed * FLARE_AREA * FLARE_DRAG_COEFFICIENT) / FLARE_MASS
      // 抗力は速度の逆向き
      drag.copy(this.velocity).multiplyScalar(-magnitude / speed)
      this.velocity.addScaledVector(drag, dt)
    }
    this.velocity.y -= GRAVITY * dt
    this.position.addScaledVector(this.velocity, dt)
  }

  /** 器を空に戻す */
  reset(): void {
    this.burn = 0
    this.position.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
  }
}

/**
 * フレアの束。自機が持つ。
 *
 * **プールは作りきって使い回す。**燃え尽きたものから再利用する。器を
 * 増やさないので、ゴミが出ない。
 */
export class Countermeasures {
  readonly flares: readonly Flare[]
  /** 残りの数 */
  left: number
  private readonly capacity: number

  /**
   * @param capacity 積む数。省略すると `FLARE_CAPACITY`。**0 なら撒かない**
   *   （煙や曳光弾を見る台本で絵に混ざらないようにするため）
   */
  constructor(capacity: number = FLARE_CAPACITY) {
    this.capacity = capacity
    this.flares = Array.from({ length: capacity }, () => new Flare())
    this.left = capacity
  }
  /** 撒いた総数。テストと計器が読む */
  deployed = 0
  /** 前回の投下からの経過 秒 */
  private sinceDeploy = FLARE_INTERVAL
  /** 前ステップで押されていたか。押しっぱなしで撒き続けない */
  private held = false

  /** 燃えているフレア。シーカーへ渡す */
  get burning(): readonly HeatSource[] {
    return this.flares
  }

  /** いま燃えている数 */
  get aliveCount(): number {
    let count = 0
    for (const flare of this.flares) if (flare.alive) count++
    return count
  }

  /**
   * 1 ステップ進める。
   *
   * @param deploy 投下の要求。押しっぱなしでは 1 回しか撒かない
   * @param position 機体の位置
   * @param velocity 機体の速度
   * @param orientation 機体の姿勢。排気口の位置と散らす向きに使う
   */
  step(
    dt: number,
    deploy: boolean,
    position: Vec3,
    velocity: Vec3,
    orientation: { rotate(v: Vec3, out: Vec3): Vec3 },
  ): void {
    this.sinceDeploy += dt
    for (const flare of this.flares) flare.step(dt)

    const edge = deploy && !this.held
    this.held = deploy
    if (!edge) return
    if (this.left <= 0) return
    if (this.sinceDeploy < FLARE_INTERVAL) return

    orientation.rotate(FLARE_OFFSET, offset)
    offset.add(position)

    for (let i = 0; i < FLARE_PER_DEPLOY; i++) {
      const flare = this.flares.find((f) => !f.alive)
      if (flare === undefined) break
      // 左右へ交互に散らす。同じ場所に重ねても囮にならない
      const sign = i % 2 === 0 ? 1 : -1
      lateral.set(sign * FLARE_SPREAD_SPEED, 0, 0)
      orientation.rotate(lateral, lateral)
      flare.ignite(offset, velocity, lateral)
      this.left--
      this.deployed++
      if (this.left <= 0) break
    }
    this.sinceDeploy = 0
  }

  /** ワールドを作り直すときに呼ぶ */
  reset(): void {
    for (const flare of this.flares) flare.reset()
    this.left = this.capacity
    this.deployed = 0
    this.sinceDeploy = FLARE_INTERVAL
    this.held = false
  }
}
