import { Vec3 } from './vec3'
import { exhaustIntensity } from './combatant'
import { Quat } from './quat'
import {
  ROLLING_FRICTION,
  judgeTouchdown,
  lowestContact,
  pitchOf,
  rollOf,
  type CrashCause,
  type DeckSampler,
  type Touchdown,
  TOUCHDOWN_LIMITS,
} from './deckContact'
import {
  ARRESTOR,
  Arrestor,
  HOOK_DOWN_ANGLE,
  HOOK_TRANSIT_SECONDS,
  hookAngleOnDeck,
  hookPointWorld,
  type LandingResult,
} from './arrestor'
import { GRAVITY, airDensity, dynamicPressure, speedOfSound } from './isa'
import {
  AIRCRAFT,
  FLAP_LIFT_COEFFICIENT,
  angleOfAttack,
  applyAoaLimiter,
  availableThrust,
  bankAngle,
  clamp,
  controlAuthority,
  dragCoefficient,
  dragMagnitude,
  gLimitedPitchRate,
  lagFactor,
  liftCoefficient,
  liftDirection,
  liftMagnitude,
  sideslipAngle,
} from './flightModel'
import type { InputState } from './input'
import { TrailRing, type TrailSource } from './trail'

/**
 * 機体の状態と1ステップの積分。
 *
 * 積分は semi-implicit Euler（速度を先に更新してから位置に使う）。
 * 素の Euler よりエネルギーの発散が少なく、実装も1行しか変わらない。
 *
 * 姿勢の積分だけは軸角の指数写像で厳密に合成する。角速度が大きいフレームでも
 * クォータニオンが伸び縮みしない。
 */

/**
 * 機体の耐久。20mm 弾 1 発を 1 とする。
 *
 * 敵機と同じ値。**実弾で何発当てれば落ちるかの公表値はない。**戦闘機に対する
 * 20mm HEI の必要弾数は資料でも幅がある。ここは手触りの値。
 */
export const AIRCRAFT_INTEGRITY = 60

/**
 * 降着装置が出し切りから上げ切りまで（またはその逆）動く秒数。
 *
 * **推測。**F/A-18E の公表値を見つけていない（Phase 9 の段 5、ADR 0018）。戦闘機の脚は
 * 数秒で動くという程度の根拠で 5 秒に置いた。Phase 9 の段 4 までは対地 80 m で瞬時に
 * 出し入れしていた
 */
export const GEAR_TRANSIT_SECONDS = 5

/**
 * 脚を出し切ったときに足す抗力係数（主翼面積あたり）。
 *
 * **推測。**機体の零揚力抗力 `cd0` 0.026 に対して 0.02 で、脚を出すと零揚力抗力が
 * 2 倍近くになる。戦闘機の脚の抗力の公表値を見つけていない（ADR 0018）。出ている割合に
 * 比例させる
 */
export const GEAR_DRAG_COEFFICIENT = 0.02

/**
 * ハイGターン（Phase 10 の段 B6）。押して引いているあいだ、機首上げの速さの上限を何倍にするか。
 * **推測。**録画（ACE COMBAT 7 の講座 lesson 2）からは旋回の速さを測れなかった（空が一面同じ色で
 * 背景の特徴点が取れない）。ユーザーの決定で 1.4 倍
 */
export const HIGH_G_TURN_RATE = 1.4

/**
 * ハイGターンの減速（段 B6、段 C2 で録画に合わせ直した）。減速は `HIGH_G_POWER / 速さ`（m/s²）で、
 * 速さが落ちるほど強くなる。上限は `HIGH_G_DECELERATION`。
 *
 * 録画（lesson 2、コマ 8945〜9233）の SPEED は 404 kt から 1.8 秒で 366・5.8 秒で 263・7.8 秒で 196・
 * 9.6 秒で 116（91・65・49・29%）。高度は 4,679 → 5,459 ft と上がる。減り方は終わりほど速い
 * （最後の 1.8 秒で 80 kt）。
 *
 * 段 B6 では抗力係数を 1.2 足していた。速さの 2 乗で効くので速いうちに減りすぎ、同じ始まりで 1.8 秒に
 * 61〜63% まで落ちた。一定の減速でも、終わりの減り方が鈍った。速さに反比例させると、同じ始まり
 * （404 kt・1,426 m、0.25 秒倒してから引く、高度は +913 ft）で 90・56・43・33% になる
 * （`tests/sim/highG.test.ts`）。800 は sim で探した値
 */
export const HIGH_G_POWER = 800
/** 減速の上限 m/s²。遅いところで速さに反比例する減速が際限なく大きくならないように */
export const HIGH_G_DECELERATION = 20

/**
 * フラップを下ろし切ったときに足す形状の抗力係数。**入れていない（0）。**
 *
 * 一次資料を見つけていない。フラップで増えた揚力ぶんの誘導抗力は `dragCoefficient(cl)` が
 * 持つ。形状の抗力を 0〜0.04 で振っても、進入（130 kt・進入角 3.5 度）のスロットルは
 * 0.139〜0.165 で大きく変わらなかった（ADR 0019）。根拠のある値が見つかったら置く
 */
export const FLAP_DRAG_COEFFICIENT = 0

/**
 * 脚を出していてよい速度の上限 m/s。250 kt。
 *
 * **推測。**F/A-18 は 250 kt 前後と言われるが、公開の一次資料で確かめていない（ADR 0018）。
 * 超えたら HUD に警告を出すだけで、壊れはしない。比べるのは真対気速度で、低空では
 * 計器の速度とほぼ同じ
 */
export const GEAR_SPEED_LIMIT = 250 * 0.514444

/**
 * 甲板を離れてから、触れ直しても新しい接地に数えないステップ数。0.5 秒（段 10）。
 *
 * **推測。**ボルターで甲板の端を走り抜けて浮くとき、引き起こしの途中で 2 回、降下率ほぼ 0 で
 * 甲板に触れ直した（`carrier-bolter` の f2393 と f2398）。新しい接地として数えると、接地の
 * 記録が降下率 0 で上書きされ、ボルターの結果も記録し直されていた（2026-10-15 に見つけた）。
 * この間に触れ直したら、走っている続きとみなす（ユーザーの判断）
 */
export const RECONTACT_STEPS = 60

export interface AircraftInit {
  position?: Vec3
  velocity?: Vec3
  orientation?: Quat
  /** 実効スロットル 0..1 */
  throttle?: number
  /** 降着装置を出し切った状態で始めるか。既定は上げ切り */
  gearDown?: boolean
}

export interface StepOptions {
  /**
   * 迎角制限器（フライバイワイヤ相当）。既定は有効。
   * 失速の挙動を検証するときだけ切る。
   */
  aoaLimiter?: boolean
  /**
   * 地形。渡さなければ高度 0 の水平面（外洋）として扱う。
   *
   * 描画と同じ高さ場を引く。GLSL と TypeScript に同じ式を二重に書くと、
   * いつか片方だけ直して「見えている山と当たる山がずれる」ので、
   * ここは sim 側の Terrain を正本にする。
   */
  terrain?: TerrainSampler
  /**
   * 舵の効きに掛ける係数 0..1。既定は 1。
   *
   * ダメージで操縦が鈍るのを表す。`controlAuthority` の結果へそのまま掛ける。
   * **飛行モデルの側に「ダメージ」という概念は持たせない。**効きが落ちる
   * 理由は呼び出し側が決める。
   */
  controlFactor?: number
  /**
   * 空母の甲板の当たり（段 7）。渡さなければ甲板は無い（今までどおり地形と海面だけ）
   */
  deck?: DeckSampler
}

/**
 * 地形の高さを引くもの。
 *
 * Terrain そのものを要求せず必要な形だけ受け取る。テストから平坦や斜面を
 * 差し込めるし、sim が描画側の型に縛られない。
 */
export interface TerrainSampler {
  heightAt(x: number, z: number): number
}

/**
 * 軌跡の履歴の長さ。
 *
 * 4 フレームごとに記録して 768 本。1/120 秒刻みなので 25.6 秒ぶん。
 * 340 m/s で飛べば 8.7 km 後ろまで残る。
 *
 * 引き起こしを続ける構図では画面に映るのは 1 秒ぶんしかない（視錐台が
 * 先に切る）。効くのは**機動が終わったあと**で、そのときに置いてきた
 * 濃い区間が後方へ遠ざかっていくのが見える。急上昇や急旋回のあとに
 * 軌跡が短く見えたのはここが足りていなかった。
 */
export const TRAIL_LENGTH = 768

/** 何フレームごとに記録するか */
export const TRAIL_STRIDE = 4

/**
 * 軌跡の 1 点。
 *
 * 描画がコントレイルと翼端渦のリボンを作るのに使う。**履歴は sim が持つ。**
 * 描画側にリングバッファを置くと、キャプチャモードは sync が 1 回しか
 * 走らないので何も出ない。履歴は sim の状態なので、リプレイにも後の Phase の
 * AI にも使える。
 */
export interface TrailPoint {
  readonly position: Vec3
  /** 機体右方向の単位ベクトル。翼端の位置を出すのに使う */
  readonly right: Vec3
  /** 機体上方向の単位ベクトル。リボンの向きに使う */
  readonly up: Vec3
  /** 荷重倍数。描画側で使う予備。渦の濃さには使わない */
  readonly loadFactor: number
  /** 翼端の水蒸気。翼端渦の濃さを決める。詳細は `Aircraft.wingtipVapor` */
  readonly wingtipVapor: number
  /** 実効スロットル。コントレイルの濃さを決める */
  readonly throttle: number
  /** 海抜 m。コントレイルが出る気温の判定に使う */
  readonly altitude: number
}

/**
 * 描画が読む機体の履歴。
 *
 * リングの仕組みそのものは `TrailRing` が持つ。ミサイルの煙も同じリングを
 * 使うので、機体固有の点の型だけをここで固定する。
 */
export type AircraftTrailSource = TrailSource<TrailPoint>

interface MutableTrailPoint {
  position: Vec3
  right: Vec3
  up: Vec3
  loadFactor: number
  wingtipVapor: number
  throttle: number
  altitude: number
}

/** 描画とデバッグ表示に渡す読み取り用の状態。 */
export interface AircraftSample {
  position: Vec3
  orientation: Quat
  /**
   * 速度ベクトル m/s。
   *
   * HUD のフライトパスマーカー（機体が実際に向かっている先）に使う。
   * 機首の向きとは迎角と横滑りのぶんだけずれるので、`orientation` から
   * 導けない。補間はしない。速度は姿勢より緩やかに変わるので、1 ステップの
   * ずれは絵に出ない。
   */
  velocity: Vec3
  speed: number
  /**
   * 速さの変化率 m/s²。直前の 1 ステップで速さがどれだけ変わったか（段 36）。
   * HUD の SPEED の箱の増減の矢印に使う。キャプチャは 1 フレームしか描かないので、
   * 描画側で前の値を覚える形では矢印が出ない。sim が持つ
   */
  speedRate: number
  altitude: number
  angleOfAttack: number
  sideslip: number
  bank: number
  loadFactor: number
  /** 翼端の水蒸気。軌跡の先頭を現在の翼端へ繋ぐのに使う */
  wingtipVapor: number
  throttle: number
  stalled: boolean
  crashed: boolean
  /** 残りの耐久 0..AIRCRAFT_INTEGRITY。HUD が出す */
  integrity: number
  /** 真下の地形の高さ m。海上なら 0 */
  groundHeight: number
  /**
   * 対地高度 m。
   *
   * altitude は海抜のまま残す。空気密度を海抜から引いているので、意味を
   * 変えると飛行モデルが狂う。低空飛行では読みたいのはこちらのほう。
   */
  agl: number
  /** 舵面の位置 −1..1。描画が舵を切るのに使う */
  elevator: number
  aileron: number
  rudder: number
  /**
   * 降着装置が少しでも出ているか（`gearPosition > 0`）。描画が脚を出すのに使う。
   *
   * **判定は sim 側に置く。**描画側に状態を持たせるとキャプチャモードで
   * 出ない（`sync()` が 1 回しか走らないので、そこで false のままになる）。
   */
  gearDown: boolean
  /** 脚の位置 0..1。0 が上げ切り、1 が出し切り。`GEAR_TRANSIT_SECONDS` かけて動く */
  gearPosition: number
  /** 脚の指令。true が出す。動いている途中は `gearPosition` と食い違う */
  gearCommandDown: boolean
  /** 脚が出ているのに `GEAR_SPEED_LIMIT` を超えている。HUD が警告を出す */
  gearOverspeed: boolean
  /** フックの位置 0..1。0 が上げ切り。`HOOK_TRANSIT_SECONDS` かけて動く（段 8） */
  hookPosition: number
  /**
   * フックの実際の角度 rad（収納から下ろす向き）。甲板に当たっているときは、指令の角度より
   * 小さい（先端が甲板に載る角度）。描画がこのまま回す
   */
  hookAngle: number
  /** オートパイロットが入っているか（段 B6）。HUD の照準の下の欄に AUTO PILOT を出す */
  autopilot: boolean
}

// 毎ステップの一時変数。使い回してゴミを出さない。
const tmpForward = new Vec3()
const tmpUp = new Vec3()
const tmpRight = new Vec3()
const tmpVelDir = new Vec3()
const tmpForce = new Vec3()
const tmpAero = new Vec3()
const tmpLiftDir = new Vec3()
const tmpBodyVel = new Vec3()
const tmpRates = new Vec3()
const tmpQuat = new Quat()
const tmpHook = new Vec3()

export class Aircraft {
  /** ハイGターンが効いているか（段 B6）。押して引いているあいだ true。`step` が書く */
  highGActive = false
  /** オートパイロットが入っているか（段 B6）。`World` が書く */
  autopilot = false

  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()
  /** body 座標系の角速度 rad/s */
  readonly angularVelocity = new Vec3()

  /** 実効スロットル。入力の目標値とは別に、時定数をかけて追従する */
  throttle = 0.5
  /** 脚の指令。true が出す（`toggleGear`） */
  gearCommandDown = false
  /** 脚の位置 0..1。0 が上げ切り、1 が出し切り */
  gearPosition = 0

  crashed = false
  /** 墜落の原因。墜落していなければ null。撃墜（耐久切れ）も null（段 7） */
  crashCause: CrashCause | null = null
  /** 甲板の上を車輪で走っているか（段 7） */
  onDeck = false
  /** 最後に甲板に触れたときの記録。段 8 の着艦の結果が読む */
  lastTouchdown: Touchdown | null = null
  /** フックの指令。true が下ろす（`toggleHook`、段 8） */
  hookCommandDown = false
  /** フックの位置 0..1。0 が上げ切り、1 が下ろし切り */
  hookPosition = 0
  /** フックの実際の角度 rad。甲板に当たると指令より小さくなる（`hookAngleOnDeck`） */
  hookAngle = 0
  /** 拘束索に掛かっていれば、止めている装置。掛かっていなければ null（段 8） */
  arrestor: Arrestor | null = null
  /** 最後の着艦の結果。まだ無ければ null（段 8） */
  landing: LandingResult | null = null
  /**
   * いまの着艦の試み。甲板に車輪で降りたら立ち、走り抜けて離れたらボルターとして結果を残す。
   * 射出の終点（`releaseOnDeck`）では立てない
   */
  private landingPass = { touchedDown: false, tooFast: false }
  /**
   * 甲板を離れてからのステップ数。走っていなければ数え続け、`RECONTACT_STEPS` を超えたら
   * 「離れ切った」とみなす。初めは離れ切った状態
   */
  private stepsOffDeck = Number.POSITIVE_INFINITY
  /** 甲板を離れたが、まだ触れ直すかもしれないボルター。離れ切ったら結果に残す */
  private pendingBolter = false
  /** 前のステップのフックの先端の世界の位置。掃引の始点。無効なら null */
  private hookPointBefore: Vec3 | null = null

  /**
   * 残りの耐久。20mm 弾 1 発で 1 減る。
   *
   * **自機も撃たれる。**敵が機銃を撃つようになったので、`Combatant` として
   * 扱えないといけなくなった。値は敵機（`ENEMY_INTEGRITY`）と同じ 60 に
   * そろえてある。手ごたえの調整は決着時間を測ってから。
   */
  integrity = AIRCRAFT_INTEGRITY

  /**
   * 飛んでいるか。`Combatant` の口。
   *
   * 敵 AI が追う相手として自機を渡すのにも要る。墜落した相手は追わない。
   */
  /**
   * 熱の強さ。機体の排気を 1 とする。シーカーが読む。
   *
   * **アフターバーナーで上がる**（段 30b、全開で 1.3）。エンジンのスロットルは入力に
   * 遅れて追いつくので、焚き始めてから熱が上がるまでにも遅れがある
   */
  get intensity(): number {
    return exhaustIntensity(this.throttle)
  }

  get alive(): boolean {
    return this.integrity > 0 && !this.crashed
  }

  /**
   * ダメージを与える。落ちた瞬間だけ true を返す。
   *
   * 落ちたあとの弾で撃墜数を二重に数えないため、返り値で遷移を見分ける。
   * **耐久が尽きたら墜落と同じ扱いにする。**`crashed` を立てると `step` が
   * 何もしなくなり、機体はその場で止まる。爆発は `Combat` が出す。
   */
  damage(amount: number): boolean {
    if (!this.alive) return false
    this.integrity -= amount
    if (this.integrity <= 0) {
      this.crashed = true
      return true
    }
    return false
  }

  // 派生値。ステップの末尾で更新し、次のステップの制御と表示に使う
  speed = 0
  /** 直前のステップの頭の速さと刻み。`speedRate` を出す（段 36） */
  private speedBefore = 0
  private lastDt = 0
  altitude = 0
  /** 真下の地形の高さ m。海上なら 0 */
  groundHeight = 0
  /** 対地高度 m */
  agl = 0
  angleOfAttack = 0
  sideslip = 0
  bank = 0
  loadFactor = 1
  stalled = false

  /**
   * 舵面の位置 −1..1。指令へ一次遅れで追従する。
   *
   * 描画が使う。描画側で入力を読むとキャプチャモードで再現しない（sync が
   * 1 回しか走らないため）。sim の状態として持つ。
   */
  elevator = 0
  aileron = 0
  rudder = 0

  /**
   * 翼端の水蒸気 0..。翼端渦の濃さの元になる。
   *
   * 駆動量は マッハ数 × 揚力係数。渦の芯の温度低下を無次元で書くと
   * ΔT/T ∝ γM²Cl²/2 になるので、この積が要る。片方では足りない。
   * 荷重倍数だけで見ると定常旋回（3.0〜3.3 G）を取りこぼし、揚力係数だけで
   * 見ると速い引き起こし（6.86 G・340 m/s で Cl 0.453）を取りこぼす。
   *
   * **立ち上がりは速く、消えるのは遅い。**引くのをやめた瞬間に翼端の
   * 水蒸気が消えると、軌跡は機体の真後ろだけの短い切れ端になる。追従カメラ
   * から見えるのは 0.7 秒ぶんもないので、機動が終わると同時に何も残らない。
   * いったん凝結した水蒸気は渦核が崩れるまで残るので、減衰に時定数を持たせる。
   */
  wingtipVapor = 0

  // 描画補間用に前ステップの姿勢を持つ
  private readonly prevPosition = new Vec3()
  private readonly prevOrientation = new Quat()

  /** 軌跡の履歴。器は最初に作りきって使い回す */
  private readonly trail = new TrailRing<MutableTrailPoint>(TRAIL_LENGTH, () => ({
    position: new Vec3(),
    right: new Vec3(),
    up: new Vec3(),
    loadFactor: 1,
    wingtipVapor: 0,
    throttle: 0,
    altitude: 0,
  }))
  /** ステップの通し番号。TRAIL_STRIDE ごとに記録する */
  private stepIndex = 0

  constructor(init: AircraftInit = {}) {
    if (init.position) this.position.copy(init.position)
    if (init.velocity) this.velocity.copy(init.velocity)
    if (init.orientation) this.orientation.copy(init.orientation).normalize()
    if (init.throttle !== undefined) this.throttle = clamp(init.throttle, 0, 1)
    if (init.gearDown === true) this.setGear(true)

    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)
    this.updateDerived()
  }

  /**
   * 脚の指令を切り替える。**位置はすぐには動かない。**`step()` が `GEAR_TRANSIT_SECONDS`
   * かけて指令へ寄せる。甲板の上で受け付けないのは呼ぶ側（`World`）の仕事
   */
  toggleGear(): void {
    if (this.crashed) return
    this.gearCommandDown = !this.gearCommandDown
  }

  /**
   * フックの指令を切り替える（段 8）。位置は `HOOK_TRANSIT_SECONDS` かけて動く。射出中に
   * 受け付けないのは呼ぶ側（`World`）の仕事
   */
  toggleHook(): void {
    if (this.crashed) return
    this.hookCommandDown = !this.hookCommandDown
  }

  /** 脚を出し切り（true）か上げ切り（false）に置く。始めの状態を作るのに使う */
  setGear(down: boolean): void {
    this.gearCommandDown = down
    this.gearPosition = down ? 1 : 0
  }

  /**
   * カタパルト射出中の状態を反映する。
   *
   * **`step()` を通さない。**位置と速度はカタパルトが直接書いているので、
   * ここでは補間用の前フレームを送り、派生値（速度・高度・対地高度）を
   * 計算し直すだけ。加速の積分を 2 か所に書かないため（`launch.ts`）。
   *
   * 姿勢は射出方向を向かせる。甲板の上で機首がカタパルトの向きを向いて
   * いる状態。ピッチとロールは 0。
   */
  syncFromLaunch(
    direction: Vec3,
    pitch: number,
    groundHeight = this.groundHeight,
  ): void {
    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)
    this.headTo(direction.x, direction.z, pitch)
    this.updateDerived(undefined, groundHeight)
  }

  /**
   * 機首を水平の向き (x, z) へ向け、機首上げ `pitch` rad を掛ける。傾きは 0。
   *
   * **ヨーの符号に注意。**Y 軸まわりに +a 回すと機首 (0, 0, −1) は (−sin a, 0, −cos a) へ
   * 写る。以前は a = atan2(x, −z) で、機首が向きと左右逆になっていた（2026-10-14 に見つけた）。
   * 帯が 4.37 度傾く cat-3 では機首が 8.74 度ずれ、ユーザーが「cat-3 に対してまっすぐ配置されて
   * いない」と指摘した。軸と平行な cat-4（0.04 度）では見えなかった
   */
  private headTo(x: number, z: number, pitch: number): void {
    const yaw = Math.atan2(-x, -z)
    this.orientation.setFromAxisAngle(tmpUp.set(0, 1, 0), yaw)
    // **機首上げを掛ける。**実機は前脚を伸ばして射出姿勢を作る。
    // 機体の右軸まわりに回すので、ヨーのあとに掛ける
    if (pitch !== 0) {
      this.orientation.multiply(tmpQuat.setFromAxisAngle(tmpRight.set(1, 0, 0), pitch))
    }
  }

  /**
   * 射出が終わった瞬間、甲板の上を車輪で走っている状態にする（段 7）。
   *
   * **着艦として数えない。**射出の終点から甲板の縁までの数フレームは車輪が甲板にあるので、
   * そのまま当たりを見ると「触れた」と判定してしまう。走っている状態から始めれば、縁を越えた
   * ところで普通に飛ぶ
   */
  releaseOnDeck(): void {
    this.onDeck = true
  }

  /** 墜落させる。止めて原因を残す。甲板で起きた墜落は着艦の結果にも残す（段 8） */
  private crash(cause: CrashCause): void {
    this.velocity.set(0, 0, 0)
    this.angularVelocity.set(0, 0, 0)
    this.crashed = true
    this.crashCause = cause
    this.onDeck = false
    if (cause !== 'ground') this.landing = { kind: 'crash', cause, touchdown: this.lastTouchdown }
  }

  /**
   * 甲板を離れた。車輪で降りたあと拘束索に掛からずに離れたら、ボルターとして残す（段 8）
   */
  private leaveDeck(): void {
    this.onDeck = false
    this.stepsOffDeck = 0
    // ボルターは、`RECONTACT_STEPS` のあいだ触れ直さなかったら結果に残す（`settleBolter`）
    this.pendingBolter = this.landingPass.touchedDown && this.arrestor === null
  }

  /** 甲板を離れているあいだ毎ステップ呼ぶ。離れ切ったら、保留していたボルターを結果に残す */
  private settleBolter(): void {
    this.stepsOffDeck++
    if (!this.pendingBolter || this.stepsOffDeck <= RECONTACT_STEPS) return
    const reason = this.landingPass.tooFast ? 'tooFast' : this.hookPosition < 1 ? 'hookUp' : 'missed'
    this.landing = { kind: 'bolter', reason, touchdown: this.lastTouchdown }
    this.landingPass = { touchedDown: false, tooFast: false }
    this.pendingBolter = false
  }

  /**
   * フックの角度を決め、先端が前のステップから拘束索を越えたかを見る（段 8）。位置を積分して
   * 甲板の当たりを見たあとに呼ぶ。
   *
   * 越えた点の先端の高さが索の上端（甲板 + `ARRESTOR.wireHeight`）以下で、水平の速さが
   * `ARRESTOR.maxEngageSpeed` 以下なら掛かる。**掛かった瞬間の位置から止める。**越えた点まで
   * 戻さないので、引き出し長の起点は最大 1 ステップ（130 kt で 0.56 m）先へずれる
   */
  private engageWire(deck: DeckSampler): void {
    const target = this.hookPosition * HOOK_DOWN_ANGLE
    const point = hookPointWorld(this.position, this.orientation, target, tmpHook)
    const deckUnderHook = deck.deckHeightAt(point.x, point.z)
    this.hookAngle =
      deckUnderHook === null
        ? target
        : hookAngleOnDeck(this.position, this.orientation, target, deckUnderHook)
    hookPointWorld(this.position, this.orientation, this.hookAngle, point)

    const before = this.hookPointBefore
    if (before !== null && this.arrestor === null) {
      const crossing = deck.crossWire(before.x, before.z, point.x, point.z)
      if (crossing !== null) {
        const y = before.y + (point.y - before.y) * crossing.t
        const x = before.x + (point.x - before.x) * crossing.t
        const z = before.z + (point.z - before.z) * crossing.t
        const deckHeight = deck.deckHeightAt(x, z)
        if (deckHeight !== null && y <= deckHeight + ARRESTOR.wireHeight) {
          const speed = Math.hypot(this.velocity.x, this.velocity.z)
          if (speed > ARRESTOR.maxEngageSpeed) {
            this.landingPass.tooFast = true
          } else if (speed > 0) {
            this.arrestor = new Arrestor(
              this.position.x,
              this.position.z,
              this.velocity.x / speed,
              this.velocity.z / speed,
              speed,
              this.lastDt,
            )
            this.landing = {
              kind: 'trap',
              wire: (crossing.index + 1) as 1 | 2 | 3,
              engageSpeed: speed,
              offCenter: crossing.offCenter,
              touchdown: this.landingPass.touchedDown ? this.lastTouchdown : null,
            }
          }
        }
      }
    }
    if (this.hookPointBefore === null) this.hookPointBefore = new Vec3()
    this.hookPointBefore.copy(point)
  }

  /**
   * 空母の甲板との当たり（段 7、`deckContact.ts`）。位置を積分した直後に呼ぶ。
   *
   * 1. 艦橋の箱に入ったら墜落
   * 2. 甲板の上で、いちばん低い接点（脚を出し切っていれば車輪、そうでなければ機体の最下点）が
   *    甲板に届いたら、初めて触れた瞬間に判定する。原点が甲板より下なら船体に入ったので墜落、
   *    脚が出し切りでなければ墜落、降下率と姿勢が範囲の外なら墜落。内側なら車輪で走る
   * 3. 走っているあいだは傾きを 0、機首下げを 0 にそろえ、車輪を甲板に載せる。転がり抵抗で
   *    減速する。揚力で浮けば離れる
   */
  private contactDeck(deck: DeckSampler, dt: number): void {
    const p = this.position
    if (deck.insideIsland(p.x, p.y, p.z)) return this.crash('island')
    const deckHeight = deck.deckHeightAt(p.x, p.z)
    if (!this.onDeck) this.settleBolter()
    if (deckHeight === null) {
      // 甲板の外。縁を越えたら普通に飛ぶ（落ちれば海面で墜落）
      if (this.onDeck) this.leaveDeck()
      return
    }
    const gearDown = this.gearPosition >= 1

    if (!this.onDeck) {
      if (lowestContact(p, this.orientation, gearDown) > deckHeight) return
      // **原点が甲板より下なら、上から降りたのではなく横から船体に入った**
      if (p.y <= deckHeight) return this.crash('hull')
      if (!gearDown) return this.crash('belly')
    }
    if (!this.onDeck && this.stepsOffDeck <= RECONTACT_STEPS) {
      // 離れて間もなく触れ直した。走っている続きで、新しい接地にも着艦の試みにも数えない
      this.onDeck = true
      this.pendingBolter = false
    }
    if (!this.onDeck) {
      const sinkRate = -this.velocity.y
      const pitch = pitchOf(this.orientation)
      const roll = rollOf(this.orientation)
      const cause = judgeTouchdown(sinkRate, pitch, roll)
      if (cause !== null) return this.crash(cause)
      this.lastTouchdown = {
        sinkRate,
        pitch,
        roll,
        hard: sinkRate > TOUCHDOWN_LIMITS.hardSinkRate,
      }
      this.onDeck = true
      this.landingPass.touchedDown = true
    }

    // 走っている。脚が上がったら（甲板では上げられないが念のため）胴体が触れる
    if (!gearDown) return this.crash('belly')

    // 傾きを 0、機首下げを 0 にそろえる。機首上げ（引き起こし）は残す
    const pitch = Math.max(0, pitchOf(this.orientation))
    this.orientation.forward(tmpForward)
    this.headTo(tmpForward.x, tmpForward.z, pitch)
    this.angularVelocity.z = 0
    if (pitch === 0) this.angularVelocity.x = 0

    const lowest = lowestContact(p, this.orientation, true)
    if (lowest > deckHeight + 1e-6) {
      // 揚力で浮いた
      this.leaveDeck()
      return
    }
    p.y += deckHeight - lowest
    if (this.velocity.y < 0) this.velocity.y = 0
    // 拘束索に掛かっていれば、水平の動きは装置が決める（`Arrestor`）
    if (this.arrestor !== null) return
    // 転がり抵抗。水平の速さを減らす（止まったら止まったまま）
    const vh = Math.hypot(this.velocity.x, this.velocity.z)
    if (vh > 0) {
      const k = Math.max(0, vh - ROLLING_FRICTION * GRAVITY * dt) / vh
      this.velocity.x *= k
      this.velocity.z *= k
    }
  }

  step(input: InputState, dt: number, options: StepOptions = {}): void {
    this.prevPosition.copy(this.position)
    this.prevOrientation.copy(this.orientation)
    this.speedBefore = this.speed
    this.lastDt = dt

    if (this.crashed) return

    const useLimiter = options.aoaLimiter !== false

    this.orientation.forward(tmpForward)
    this.orientation.up(tmpUp)
    this.orientation.right(tmpRight)

    const density = airDensity(this.altitude)
    const q = dynamicPressure(density, this.speed)

    // 1. 指令角速度。舵の効き、G 制限、迎角制限をここで掛ける。
    //    ダメージで鈍るぶんは呼び出し側が係数で渡す
    const authority = controlAuthority(q) * (options.controlFactor ?? 1)

    let pitchCommand = clamp(input.pitch, -1, 1)
    if (useLimiter) pitchCommand = applyAoaLimiter(pitchCommand, this.angleOfAttack)

    // ハイGターン（段 B6）。押して引いているあいだだけ、機首上げの速さの上限を上げる
    this.highGActive = input.highG && pitchCommand > 0
    const highG = this.highGActive ? HIGH_G_TURN_RATE : 1
    const pitchCap = Math.min(AIRCRAFT.maxPitchRate * highG, gLimitedPitchRate(this.speed) * highG)
    const targetPitch = pitchCommand * pitchCap * authority
    const targetRoll = clamp(input.roll, -1, 1) * AIRCRAFT.maxRollRate * authority
    const pilotYaw = clamp(input.yaw, -1, 1) * AIRCRAFT.maxYawRate * authority

    // 2. 風見安定。横滑り角に比例したヨーで機首を経路へ戻す。
    //    垂直尾翼が実際にやっていること。協調旋回はこの機構から出てくる。
    const weathervaneYaw = this.speed > 1 ? AIRCRAFT.weathervaneGain * this.sideslip : 0
    const targetYaw = pilotYaw + weathervaneYaw

    // 3. 指令へ一次遅れで追従。軸ごとに時定数が違う
    setBodyRates(tmpRates, targetPitch, targetRoll, targetYaw)
    this.angularVelocity.x +=
      (tmpRates.x - this.angularVelocity.x) * lagFactor(dt, AIRCRAFT.pitchTau)
    this.angularVelocity.y +=
      (tmpRates.y - this.angularVelocity.y) * lagFactor(dt, AIRCRAFT.yawTau)
    this.angularVelocity.z +=
      (tmpRates.z - this.angularVelocity.z) * lagFactor(dt, AIRCRAFT.rollTau)

    // 4. 姿勢を積分して body 軸を取り直す
    this.orientation.integrateBodyRate(this.angularVelocity, dt, tmpQuat)
    this.orientation.forward(tmpForward)
    this.orientation.up(tmpUp)
    this.orientation.right(tmpRight)

    // 5. スロットルの追従
    const targetThrottle = clamp(input.throttle, 0, 1)
    this.throttle += (targetThrottle - this.throttle) * lagFactor(dt, AIRCRAFT.throttleTau)

    // 脚。指令へ一定の速さで寄せる（一次遅れにしない。脚は油圧で一定の速さで動く）
    const gearStep = dt / GEAR_TRANSIT_SECONDS
    this.gearPosition = this.gearCommandDown
      ? Math.min(1, this.gearPosition + gearStep)
      : Math.max(0, this.gearPosition - gearStep)
    // フックも一定の速さで寄せる（段 8）
    const hookStep = dt / HOOK_TRANSIT_SECONDS
    this.hookPosition = this.hookCommandDown
      ? Math.min(1, this.hookPosition + hookStep)
      : Math.max(0, this.hookPosition - hookStep)

    // 舵面の位置。指令をそのまま見せると入力の瞬間に跳ねるので遅らせる。
    // 制限器を通したあとのピッチ指令を使う。制限が効いているときに舵面が
    // 動いたままだと、見えているものと挙動が食い違う
    const surfaceLag = lagFactor(dt, AIRCRAFT.surfaceTau)
    this.elevator += (pitchCommand - this.elevator) * surfaceLag
    this.aileron += (clamp(input.roll, -1, 1) - this.aileron) * surfaceLag
    this.rudder += (clamp(input.yaw, -1, 1) - this.rudder) * surfaceLag

    // 6. 力を合算する。tmpAero には重力以外を入れて荷重倍数の計算に使う
    tmpAero.set(0, 0, 0)
    tmpAero.addScaledVector(tmpForward, availableThrust(this.throttle, density))

    const speed = this.speed
    if (speed > 0.1) {
      tmpVelDir.copy(this.velocity).multiplyScalar(1 / speed)
      const alpha = angleOfAttack(tmpVelDir, tmpUp)
      // フラップは脚と一緒に動く（G で両方）。下りている割合だけ揚力を足す
      const cl = liftCoefficient(alpha) + FLAP_LIFT_COEFFICIENT * this.gearPosition

      liftDirection(tmpVelDir, tmpUp, tmpLiftDir)
      tmpAero.addScaledVector(tmpLiftDir, liftMagnitude(q, cl))
      // 脚とフラップの抗力は出ている割合に比例させる。フラップで増えた揚力の誘導抗力は
      // `dragCoefficient(cl)` が含む
      const cd = dragCoefficient(cl) + (GEAR_DRAG_COEFFICIENT + FLAP_DRAG_COEFFICIENT) * this.gearPosition
      tmpAero.addScaledVector(tmpVelDir, -dragMagnitude(q, cd))
      // ハイGターンの減速。速さによらずほぼ一定に減らす（録画は約 30 kt/秒で直線に近く減る）
      if (this.highGActive) {
        tmpAero.addScaledVector(tmpVelDir, -AIRCRAFT.mass * Math.min(HIGH_G_DECELERATION, HIGH_G_POWER / speed))
      }
    }

    tmpForce.copy(tmpAero)
    tmpForce.y -= AIRCRAFT.mass * GRAVITY

    // 7. 速度を更新（semi-implicit Euler なので位置より先）
    this.velocity.addScaledVector(tmpForce, dt / AIRCRAFT.mass)

    // 8. 横滑りの減衰。機体座標系の横方向成分だけを抜く。
    //    上下成分は迎角そのものなので触らない。ここを丸ごと寄せると揚力が消える。
    this.orientation.rotateInverse(this.velocity, tmpBodyVel)
    tmpBodyVel.x -= tmpBodyVel.x * lagFactor(dt, AIRCRAFT.sideslipTau)
    this.orientation.rotate(tmpBodyVel, this.velocity)

    // 9. 位置と地形
    this.position.addScaledVector(this.velocity, dt)
    // 拘束索に掛かっていれば、水平の位置と速度は装置の閉じた式で置き直す（段 8）
    this.arrestor?.advance(this.position, this.velocity)

    // 9a. 空母の甲板（段 7）とフック（段 8）。墜落したらここで終える
    if (options.deck !== undefined) {
      this.contactDeck(options.deck, dt)
      if (this.crashed) {
        this.updateDerived(tmpAero, this.groundHeight)
        return
      }
      this.engageWire(options.deck)
    } else {
      this.hookAngle = this.hookPosition * HOOK_DOWN_ANGLE
    }
    // 地形を渡されていなければ海面（高度 0）。外洋はそれで正しい
    const ground = options.terrain
      ? options.terrain.heightAt(this.position.x, this.position.z)
      : 0
    // 海面より低い地形（海底）に当たっても意味がないので、海面で止める
    const floor = ground > 0 ? ground : 0
    if (this.position.y <= floor) {
      this.position.y = floor
      this.velocity.set(0, 0, 0)
      this.angularVelocity.set(0, 0, 0)
      this.crashed = true
      this.crashCause = 'ground'
    }

    this.updateDerived(tmpAero, floor)

    // 翼端の水蒸気。派生値のあとに置く。迎角と海抜が要るため
    const vaporDrive =
      (this.speed / speedOfSound(this.altitude)) *
      Math.abs(liftCoefficient(this.angleOfAttack))
    const vaporTau =
      vaporDrive > this.wingtipVapor ? AIRCRAFT.vaporRiseTau : AIRCRAFT.vaporFallTau
    this.wingtipVapor += (vaporDrive - this.wingtipVapor) * lagFactor(dt, vaporTau)

    // 軌跡の記録。派生値を更新したあとに置く。荷重倍数と海抜が要るため
    if (this.stepIndex % TRAIL_STRIDE === 0) this.recordTrail(tmpUp, tmpRight)
    this.stepIndex++
  }

  /**
   * 軌跡を 1 点記録する。
   *
   * 呼ぶのは TRAIL_STRIDE ステップごと。1/120 秒ごとに残すと 768 本でも
   * 6.4 秒ぶんしか持てない。
   */
  private recordTrail(up: Vec3, right: Vec3): void {
    const slot = this.trail.push()
    slot.position.copy(this.position)
    slot.right.copy(right)
    slot.up.copy(up)
    slot.loadFactor = this.loadFactor
    slot.wingtipVapor = this.wingtipVapor
    slot.throttle = this.throttle
    slot.altitude = this.altitude
  }

  /** 記録済みの点の数。TRAIL_LENGTH で頭打ち */
  get trailLength(): number {
    return this.trail.length
  }

  /**
   * 新しい順に index 番目の点。0 が最新。
   *
   * 返すのは内部の器そのもの。保持せずその場で使う。毎フレーム 768 本を
   * 写すのは無駄なので、読む側の作法として決めておく。
   */
  trailPoint(index: number): TrailPoint {
    return this.trail.at(index)
  }

  /**
   * 描画用に前ステップと現ステップを補間した状態を書き込む。
   *
   * @param alpha 0 が前ステップ、1 が現ステップ
   */
  sample(alpha: number, out: AircraftSample): AircraftSample {
    out.position.copy(this.prevPosition).lerp(this.position, alpha)
    out.orientation.copy(this.prevOrientation).slerp(this.orientation, alpha)
    out.velocity.copy(this.velocity)
    out.speed = this.speed
    out.speedRate = this.lastDt > 0 ? (this.speed - this.speedBefore) / this.lastDt : 0
    out.altitude = this.altitude
    out.angleOfAttack = this.angleOfAttack
    out.sideslip = this.sideslip
    out.bank = this.bank
    out.loadFactor = this.loadFactor
    out.wingtipVapor = this.wingtipVapor
    out.throttle = this.throttle
    out.stalled = this.stalled
    out.crashed = this.crashed
    out.integrity = this.integrity
    out.groundHeight = this.groundHeight
    out.agl = this.agl
    out.elevator = this.elevator
    out.aileron = this.aileron
    out.rudder = this.rudder
    out.gearDown = this.gearPosition > 0
    out.gearPosition = this.gearPosition
    out.gearCommandDown = this.gearCommandDown
    out.gearOverspeed = this.gearPosition > 0 && this.speed > GEAR_SPEED_LIMIT
    out.hookPosition = this.hookPosition
    out.autopilot = this.autopilot
    out.hookAngle = this.hookAngle
    return out
  }

  /** 制御と表示に使う派生値を state から計算し直す。 */
  private updateDerived(aeroForce?: Vec3, groundHeight = this.groundHeight): void {
    this.speed = this.velocity.length()
    this.altitude = this.position.y
    this.groundHeight = groundHeight
    this.agl = this.position.y - groundHeight

    this.orientation.up(tmpUp)
    this.orientation.right(tmpRight)
    this.bank = bankAngle(tmpUp, tmpRight)

    if (this.speed > 0.1) {
      tmpVelDir.copy(this.velocity).multiplyScalar(1 / this.speed)
      this.angleOfAttack = angleOfAttack(tmpVelDir, tmpUp)
      this.sideslip = sideslipAngle(tmpVelDir, tmpRight)
    } else {
      this.angleOfAttack = 0
      this.sideslip = 0
    }

    this.stalled = Math.abs(this.angleOfAttack) > AIRCRAFT.stallAngle

    // 荷重倍数は重力を除いた力（加速度計が読む値）を g で割ったもの。
    // 水平定常飛行では揚力だけが残り 1G になる。
    this.loadFactor = aeroForce
      ? aeroForce.length() / (AIRCRAFT.mass * GRAVITY)
      : this.loadFactor
  }
}

export function createAircraftSample(): AircraftSample {
  return {
    position: new Vec3(),
    orientation: new Quat(),
    velocity: new Vec3(),
    speed: 0,
    speedRate: 0,
    altitude: 0,
    angleOfAttack: 0,
    sideslip: 0,
    bank: 0,
    loadFactor: 1,
    wingtipVapor: 0,
    throttle: 0,
    stalled: false,
    crashed: false,
    integrity: AIRCRAFT_INTEGRITY,
    groundHeight: 0,
    agl: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    gearDown: false,
    gearPosition: 0,
    gearCommandDown: false,
    gearOverspeed: false,
    hookPosition: 0,
    hookAngle: 0,
    autopilot: false,
  }
}

/**
 * 直感的な指令（機首上げ・右ロール・右ヨーを正）を body 座標系の
 * 角速度ベクトルへ写す。
 *
 * 座標系は右手系で機首が -Z なので、素直に書くと符号が食い違う。
 * 機首上げは +X まわりの正回転、右ロールは -Z まわりの正回転、
 * 右ヨーは +Y まわりの負回転。ここ1か所に閉じ込める。
 */
export function setBodyRates(
  out: Vec3,
  pitchUp: number,
  rollRight: number,
  yawRight: number,
): Vec3 {
  return out.set(pitchUp, -yawRight, -rollRight)
}
