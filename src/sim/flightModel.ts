import { Vec3 } from './vec3'
import { GRAVITY, SEA_LEVEL_DENSITY, dynamicPressure } from './isa'

/**
 * 機体諸元と空力。手触りの調整はこのファイルの数値だけで済ませる。
 *
 * 値は F/A-18C の公表値を基準にした。戦闘重量 16,650 kg、主翼面積 37.16 m²、
 * 翼幅 11.43 m、F404-GE-402 × 2 のアフターバーナー推力 157.47 kN。
 * 導出と根拠は docs/flight-model.md に書いてある。
 *
 * Phase 1 では F-16 を基準にしていた。Phase 4 で機体モデルに FlightGear の
 * F/A-18C を取り込んだので、見えているものと物理を揃えるために書き換えた。
 * モデルの実測は 全長 17.797 m / 翼幅 11.571 m / 全高 4.488 m で、公表値と
 * 5% 以内で一致する（tests/tools/ac3d.test.ts が検査する）。
 */

const DEG = Math.PI / 180

const WING_SPAN = 11.43
const WING_AREA = 37.16

export const AIRCRAFT = {
  /** 質量 kg */
  mass: 16_650,
  /** 主翼面積 m² */
  wingArea: WING_AREA,
  /** アスペクト比 = 翼幅² / 翼面積 */
  aspectRatio: (WING_SPAN * WING_SPAN) / WING_AREA,
  /** オズワルド効率。誘導抗力の効きを決める */
  oswaldEfficiency: 0.8,

  /** 海面高度・アフターバーナー時の最大推力 N。F404-GE-402 が 17,700 lbf × 2 */
  maxThrust: 157_470,

  /**
   * 揚力傾斜 /rad。
   * 薄翼理論の 2π にアスペクト比 3.52 の有限翼補正を掛けた値。
   */
  liftSlope: 4.0,
  /**
   * 揚力係数が頭打ちになる迎角 rad。
   *
   * ここまでは迎角に比例して増え、ここから失速角までは一定になる。
   * 27.2 度で CLmax が 1.90 になり、LEX を持つ戦闘機の妥当な範囲に収まる。
   *
   * この平坦部が F/A-18C の高迎角性能の表現。Hornet が 35 度まで引けるのは
   * CLmax が高いからではなく、揚力が頭打ちになったあとも操縦できるため。
   * 平坦部を作らずに失速角を 38 度まで伸ばすと CLmax が 2.66 になり、
   * 実機の 1.8 前後から外れてしまう。
   */
  clPeakAngle: 27.2 * DEG,
  /** 失速角 rad。ここから揚力係数が落ち始める */
  stallAngle: 38 * DEG,
  /** 失速後、揚力係数が下げ止まる迎角 rad */
  postStallAngle: 48 * DEG,
  /** 下げ止まったときの揚力係数の残り割合 */
  postStallRetention: 0.6,

  /**
   * 有害抗力係数。
   *
   * クリーン形態の F/A-18C は 0.024 前後。モデルは翼端ミサイルとパイロンを
   * 付けた形態なので少し上げる。
   */
  cd0: 0.026,

  /** 構造の G 制限 */
  gLimit: 7.5,
  /**
   * フライバイワイヤの迎角制限 rad。
   *
   * Hornet の制御は 35 度まで許す。上の平坦部（27.2 度から 38 度）の内側に
   * あるので、制限角まで引いても揚力は落ちない。
   */
  aoaLimit: 35 * DEG,
  /** 負の迎角側の制限 rad */
  aoaLimitNegative: -15 * DEG,

  /** 舵の絶対上限 rad/s */
  maxPitchRate: 0.6,
  maxRollRate: 4.0,
  maxYawRate: 0.35,

  /** 角速度が指令値へ追従する時定数 s */
  pitchTau: 0.12,
  rollTau: 0.12,
  yawTau: 0.3,

  /** 実効スロットルが目標へ追従する時定数 s */
  throttleTau: 0.8,

  /**
   * 舵面が指令へ追従する時定数 s。
   *
   * 実機の舵面は指令に対して遅れて動く。遅れを入れないと、キー入力の瞬間に
   * 舵面が跳ねて安っぽく見える。飛行の挙動には使わない。角速度は
   * `pitchTau` などで別に遅らせているので、ここは見た目だけの値。
   */
  surfaceTau: 0.08,

  /**
   * 翼端の水蒸気が立ち上がる時定数 秒。
   *
   * 凝結そのものは速い。引き始めから 0.2 秒で追いつく。
   */
  vaporRiseTau: 0.2,

  /**
   * 翼端の水蒸気が消える時定数 秒。
   *
   * 立ち上がりより 15 倍遅い。引くのをやめた瞬間に消すと、軌跡が機体の
   * 真後ろだけの切れ端になる。追従カメラから見えるのは 0.7 秒ぶんもないので、
   * 機動が終わると同時に何も残らない。いったん凝結した水蒸気は渦核が
   * 崩れるまで残るので、ここで持たせる。
   *
   * 実測。駆動量 0.456（6.86 G・340 m/s の急上昇）から閾値 0.25 を割るまで
   * 3.0 × ln(0.456 / 0.25) = 1.8 秒。引き起こし 2 秒に対して同じだけ伸びる。
   */
  vaporFallTau: 3,

  /** 横滑りの側力による減衰の時定数 s */
  sideslipTau: 0.7,
  /** 垂直尾翼の風見安定ゲイン /s。横滑り角に比例したヨーで機首を経路へ戻す */
  weathervaneGain: 4.0,

  /** 舵の効きの基準速度 m/s。海面高度でこの速度のとき効きが 1.0 */
  controlRefSpeed: 120,
  /** 低速でも残す最低限の効き */
  minControlAuthority: 0.05,
} as const

/** 誘導抗力係数 k。Cd = cd0 + k·Cl² の k にあたる */
export const INDUCED_DRAG_FACTOR =
  1 / (Math.PI * AIRCRAFT.aspectRatio * AIRCRAFT.oswaldEfficiency)

/** 舵の効きの基準動圧 Pa */
const REFERENCE_DYNAMIC_PRESSURE = dynamicPressure(
  SEA_LEVEL_DENSITY,
  AIRCRAFT.controlRefSpeed,
)

/** 最大揚力係数。平坦部に入る迎角で決まる。以降の計算の基準になる */
export const CL_MAX = AIRCRAFT.liftSlope * AIRCRAFT.clPeakAngle

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * 揚力係数を迎角から求める。
 *
 * 3 段になっている。頭打ちの迎角までは線形に増え、そこから失速角までは
 * 一定、失速角を超えると落ちて、落ち切ったあとは一定になる。負の迎角も
 * 対称に扱う。
 *
 * 平坦部を持たせているのが F/A-18C の高迎角性能の表現。前縁付け根の延長
 * （LEX）が作る渦揚力は、使える迎角を伸ばすが CLmax を比例して上げない。
 * 平坦部なしに失速角を伸ばすと CLmax が実機から外れる。
 *
 * 実際の翼はもっと滑らかな曲線を描くが、折れ線でも「引きすぎると
 * 揚力を失う」という挙動は再現できる。
 */
export function liftCoefficient(alpha: number): number {
  const sign = alpha < 0 ? -1 : 1
  const a = Math.abs(alpha)

  if (a <= AIRCRAFT.clPeakAngle) {
    return sign * AIRCRAFT.liftSlope * a
  }

  if (a <= AIRCRAFT.stallAngle) {
    return sign * CL_MAX
  }

  if (a >= AIRCRAFT.postStallAngle) {
    return sign * CL_MAX * AIRCRAFT.postStallRetention
  }

  // 失速角から下げ止まりまでを線形に落とす
  const t = (a - AIRCRAFT.stallAngle) / (AIRCRAFT.postStallAngle - AIRCRAFT.stallAngle)
  return sign * CL_MAX * (1 - t * (1 - AIRCRAFT.postStallRetention))
}

/**
 * 抗力係数。
 *
 * 第2項が誘導抗力で、揚力を稼ぐほど二乗で増える。旋回すると速度が落ちる
 * という飛行ゲームの核心的な感覚は、この項ひとつから出てくる。
 */
export function dragCoefficient(cl: number): number {
  return AIRCRAFT.cd0 + INDUCED_DRAG_FACTOR * cl * cl
}

/** 揚力の大きさ N。動圧に翼面積と揚力係数を掛けるだけ。 */
export function liftMagnitude(q: number, cl: number): number {
  return q * AIRCRAFT.wingArea * cl
}

/** 抗力の大きさ N。 */
export function dragMagnitude(q: number, cd: number): number {
  return q * AIRCRAFT.wingArea * cd
}

/**
 * 迎角。速度ベクトルと機体上方向から求める。
 *
 * 機首が流れより上を向いていれば正。速度がほぼゼロならゼロを返す。
 */
export function angleOfAttack(velocityDir: Vec3, bodyUp: Vec3): number {
  return Math.asin(clamp(-velocityDir.dot(bodyUp), -1, 1))
}

/**
 * 横滑り角。速度ベクトルが機体右方向へどれだけ振れているか。
 *
 * 正なら機体から見て右から風を受けている。風見安定はこれをゼロへ戻す。
 */
export function sideslipAngle(velocityDir: Vec3, bodyRight: Vec3): number {
  return Math.asin(clamp(velocityDir.dot(bodyRight), -1, 1))
}

/**
 * 揚力の向き。速度と直交し、機体上方向の側を向く単位ベクトル。
 *
 * 機体上方向にそのまま掛けると、大迎角のとき前後方向の成分が混ざって
 * 推力や制動のように働いてしまう。速度方向の成分を抜いてから正規化する。
 */
export function liftDirection(
  velocityDir: Vec3,
  bodyUp: Vec3,
  out: Vec3 = new Vec3(),
): Vec3 {
  out.copy(bodyUp).addScaledVector(velocityDir, -bodyUp.dot(velocityDir))
  const len = out.length()
  // 速度と機体上方向が平行（真上に上昇中など）なら揚力の向きが定まらない
  if (len < 1e-6) return out.set(0, 0, 0)
  return out.multiplyScalar(1 / len)
}

/**
 * バンク角 rad。右に傾いていれば正。
 *
 * 機体右方向と上方向の Y 成分から求める。水平なら 0、右に 90 度倒せば +π/2。
 */
export function bankAngle(bodyUp: Vec3, bodyRight: Vec3): number {
  return Math.atan2(-bodyRight.y, bodyUp.y)
}

/**
 * 舵の効き。動圧に比例させる。
 *
 * 低速では舵面に当たる空気が薄く、実際に効かない。着陸速度でも
 * 完全に操縦不能にはしないよう下限を置く。
 */
export function controlAuthority(q: number): number {
  return clamp(q / REFERENCE_DYNAMIC_PRESSURE, AIRCRAFT.minControlAuthority, 1)
}

/**
 * G 制限から決まるピッチ率の上限 rad/s。
 *
 * 荷重倍数 n で旋回するときの角速度は ω = √(n²-1)·g/v。速度が上がるほど
 * 同じ G で回れる角速度は小さくなる。高速では曲がりにくいという感覚の正体。
 */
export function gLimitedPitchRate(speed: number): number {
  if (speed < 1) return AIRCRAFT.maxPitchRate
  const n = AIRCRAFT.gLimit
  return (Math.sqrt(n * n - 1) * GRAVITY) / speed
}

/**
 * 迎角制限器。指令ピッチ率を迎角の余裕に応じて絞る。
 *
 * F-16 のフライバイワイヤが実際にやっていること。これがないと低速で
 * フルに引いた瞬間に失速する。制限を外せば失速するので、空力側の
 * 失速表現は殺していない。
 *
 * @param command 正規化した指令 -1..1。正が機首上げ
 * @param alpha 現在の迎角 rad
 */
export function applyAoaLimiter(command: number, alpha: number): number {
  // 制限に近づく方向の操作だけ絞る。戻す方向は妨げない。
  const margin = 0.3 // 制限角の何割手前から絞り始めるか

  if (command > 0) {
    const limit = AIRCRAFT.aoaLimit
    const band = limit * margin
    const remaining = limit - alpha
    return command * clamp(remaining / band, 0, 1)
  }

  if (command < 0) {
    const limit = AIRCRAFT.aoaLimitNegative
    const band = Math.abs(limit) * margin
    const remaining = alpha - limit
    return command * clamp(remaining / band, 0, 1)
  }

  return 0
}

/**
 * 一次遅れの追従係数。
 *
 * 単純に t を掛けるとフレームレートで挙動が変わる。指数で書けば
 * dt が変わっても同じ時定数で収束する。
 */
export function lagFactor(dt: number, tau: number): number {
  if (tau <= 0) return 1
  return 1 - Math.exp(-dt / tau)
}

/** ジェットエンジンの推力。空気密度にほぼ比例して落ちる。 */
export function availableThrust(throttle: number, density: number): number {
  return AIRCRAFT.maxThrust * throttle * (density / SEA_LEVEL_DENSITY)
}

/**
 * 水平定常飛行に必要な迎角とスロットル。
 *
 * テストの初期条件と、将来のオートパイロットに使う。揚力と重量、
 * 推力と抗力をそれぞれ釣り合わせて解く。
 */
export function trimCondition(
  speed: number,
  density: number,
): { alpha: number; throttle: number } {
  const q = dynamicPressure(density, speed)
  const weight = AIRCRAFT.mass * GRAVITY
  const cl = weight / (q * AIRCRAFT.wingArea)
  const alpha = cl / AIRCRAFT.liftSlope
  const drag = q * AIRCRAFT.wingArea * dragCoefficient(cl)
  const throttle = drag / availableThrust(1, density)
  return { alpha, throttle }
}
