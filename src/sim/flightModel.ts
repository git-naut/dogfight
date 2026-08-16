import { Vec3 } from './vec3'
import { GRAVITY, SEA_LEVEL_DENSITY, dynamicPressure } from './isa'

/**
 * 機体諸元と空力。手触りの調整はこのファイルの数値だけで済ませる。
 *
 * 値は F-16 の実測値を基準にした。戦闘離陸重量 9,791 kg、主翼面積 28.87 m²、
 * 翼幅 9.96 m、F110 のアフターバーナー推力 122.77 kN。
 * 導出と根拠は docs/flight-model.md に書いてある。
 */

const DEG = Math.PI / 180

const WING_SPAN = 9.96
const WING_AREA = 28.87

export const AIRCRAFT = {
  /** 質量 kg */
  mass: 9800,
  /** 主翼面積 m² */
  wingArea: WING_AREA,
  /** アスペクト比 = 翼幅² / 翼面積 */
  aspectRatio: (WING_SPAN * WING_SPAN) / WING_AREA,
  /** オズワルド効率。誘導抗力の効きを決める */
  oswaldEfficiency: 0.8,

  /** 海面高度・アフターバーナー時の最大推力 N */
  maxThrust: 122_770,

  /**
   * 揚力傾斜 /rad。
   * 薄翼理論の 2π にアスペクト比 3.44 の有限翼補正を掛けた値。
   */
  liftSlope: 4.0,
  /**
   * 失速角 rad。
   *
   * 素の翼型なら 16〜18 度だが、この機体は前縁付け根の延長（LERX）で
   * 高迎角まで渦揚力が伸びる前提で 26 度に置く。下の迎角制限 25 度が
   * 失速の手前で効くようにするため。18 度のままだと制限に達する前に
   * 失速してしまい、制限器が意味をなさない。
   */
  stallAngle: 26 * DEG,
  /** 失速後、揚力係数が下げ止まる迎角 rad */
  postStallAngle: 35 * DEG,
  /** 下げ止まったときの揚力係数の残り割合 */
  postStallRetention: 0.6,

  /** 有害抗力係数。クリーン形態 */
  cd0: 0.02,

  /** 構造の G 制限 */
  gLimit: 9,
  /** フライバイワイヤの迎角制限 rad。F-16 が実際に持つ機能 */
  aoaLimit: 25 * DEG,
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

/** 失速角における揚力係数。以降の計算の基準になる */
export const CL_MAX = AIRCRAFT.liftSlope * AIRCRAFT.stallAngle

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * 揚力係数を迎角から求める。
 *
 * 失速角までは線形に増え、そこを超えると失速して落ちる。落ち切ったあとは
 * 一定にする。負の迎角も対称に扱う。
 *
 * 実際の翼はもっと滑らかな曲線を描くが、折れ線でも「引きすぎると
 * 揚力を失う」という挙動は再現できる。
 */
export function liftCoefficient(alpha: number): number {
  const sign = alpha < 0 ? -1 : 1
  const a = Math.abs(alpha)

  if (a <= AIRCRAFT.stallAngle) {
    return sign * AIRCRAFT.liftSlope * a
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
