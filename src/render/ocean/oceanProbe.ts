/**
 * FFT の海の自己診断（段 S3、`?oceanprobe=1`）の固定の入力と比べ方。
 *
 * GPU で解いた h0・周波数の番号・時間発展のあとのスペクトル・変位・傾きを読み戻し、
 * CPU 参照（`reference.ts`）と比べる。全カスケード 256² の 6 つの場は合わせて約 3,300 万の
 * 数になり、ページから JSON で取り出すには大きすぎるので、**比べる計算はページの中で行い、
 * 差の要約だけを返す。**ここが唯一の定義で、焼き手（`pipeline/node.ts`）と検査
 * （node-path.spec、vitest）が同じものを読む。three にも DOM にも依存しない。
 */
import {
  OCEAN_LOOP_SECONDS,
  buildH0,
  buildFrequencyIndex,
  oceanFields,
  evolve,
  inverseFft2d,
  assembleDisplacement,
  omegaOf,
  waveVec,
  type OceanSpectrumParams,
} from './reference'

/** 突き合わせの時刻（刻みの数と端数）。周期（7.2 万刻み）を越えた値で、余りの計算も通す */
export const OCEAN_PROBE_TICKS = 81_234
export const OCEAN_PROBE_ALPHA = 0.25

/** GPU と CPU の許容。各成分の最大値に対する差（ユーザーの決定、2026-10-28） */
export const OCEAN_PROBE_TOLERANCE = 1e-4

/**
 * 周波数の番号が食い違ってよい範囲。ω/ω0 の小数部が整数からこれ以内なら、32 ビットの
 * 丸めで境目をまたいだとみなす。ω/ω0 は最大 13.7 万で、32 ビットの丸め（相対 6e-8）は
 * 0.008 前後。sqrt と割り算の丸めが重なる分を見込んで 0.05 にした（推測）
 */
export const OCEAN_PROBE_INDEX_BOUNDARY = 0.05

/**
 * GPU の場（要素ごとに 4 つ、32 ビット）と CPU の場の差を、**カスケードと成分ごとの最大値**
 * で割った値の最大。カスケードどうしで振幅が桁で違うので、全体の最大値で割ると細かい
 * カスケードの誤りが埋もれる。`transpose` を立てると CPU の x と y を入れ替えて比べる
 * （向きの取り違えで落ちることを確かめる用）
 */
export function oceanNormalizedError(
  gpu: ArrayLike<number>,
  cpu: ArrayLike<number>,
  size: number,
  cascades: number,
  transpose = false,
): number {
  const N = size
  let worst = 0
  for (let c = 0; c < cascades; c++) {
    for (let ch = 0; ch < 4; ch++) {
      let max = 0
      let diff = 0
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = ((c * N + y) * N + x) * 4 + ch
          const j = transpose ? ((c * N + x) * N + y) * 4 + ch : i
          max = Math.max(max, Math.abs(cpu[i]!))
          diff = Math.max(diff, Math.abs(gpu[i]! - cpu[j]!))
        }
      }
      // 場が全部 0 のカスケードと成分は比べない（例: 横の変位を切ったとき）
      if (max > 0) worst = Math.max(worst, diff / max)
    }
  }
  return worst
}

/** 差がいちばん大きかった要素（検査が落ちたときの手がかり） */
export interface OceanWorst {
  cascade: number
  channel: number
  x: number
  y: number
  gpu: number
  cpu: number
  /** そのカスケードと成分の最大値 */
  max: number
}

/** `oceanNormalizedError` の差がいちばん大きい要素を探す */
export function oceanWorstElement(gpu: ArrayLike<number>, cpu: ArrayLike<number>, size: number, cascades: number): OceanWorst | null {
  const N = size
  let best: OceanWorst | null = null
  let bestRatio = -1
  for (let c = 0; c < cascades; c++) {
    for (let ch = 0; ch < 4; ch++) {
      let max = 0
      for (let i = 0; i < N * N; i++) max = Math.max(max, Math.abs(cpu[(c * N * N + i) * 4 + ch]!))
      if (max === 0) continue
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = ((c * N + y) * N + x) * 4 + ch
          const r = Math.abs(gpu[i]! - cpu[i]!) / max
          if (r > bestRatio) {
            bestRatio = r
            best = { cascade: c, channel: ch, x, y, gpu: gpu[i]!, cpu: cpu[i]!, max }
          }
        }
      }
    }
  }
  return best
}

/** 差の大きい要素を、大きい順に limit 個（検査が落ちたときの手がかり） */
export function oceanTopMismatches(
  gpu: ArrayLike<number>,
  cpu: ArrayLike<number>,
  size: number,
  cascades: number,
  limit = 10,
): OceanWorst[] {
  const N = size
  const out: (OceanWorst & { ratio: number })[] = []
  for (let c = 0; c < cascades; c++) {
    for (let ch = 0; ch < 4; ch++) {
      let max = 0
      for (let i = 0; i < N * N; i++) max = Math.max(max, Math.abs(cpu[(c * N * N + i) * 4 + ch]!))
      if (max === 0) continue
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = ((c * N + y) * N + x) * 4 + ch
          const ratio = Math.abs(gpu[i]! - cpu[i]!) / max
          if (ratio > 1e-4) out.push({ cascade: c, channel: ch, x, y, gpu: gpu[i]!, cpu: cpu[i]!, max, ratio })
        }
      }
    }
  }
  out.sort((a, b) => b.ratio - a.ratio)
  return out.slice(0, limit)
}

export interface OceanIndexCheck {
  /** 食い違った要素の数 */
  mismatched: number
  /** 食い違いのうち、差が 1 でないか、境目から遠い（小数部が許容の外）ものの数 */
  unexplained: number
  /** 食い違った要素の、ω/ω0 の小数部の整数からの距離の最大 */
  worstBoundaryDistance: number
}

/** 周波数の番号を CPU と比べる。食い違いは境目をまたいだものだけであることを確かめる */
export function checkFrequencyIndex(gpu: ArrayLike<number>, p: OceanSpectrumParams): OceanIndexCheck {
  const cpu = buildFrequencyIndex(p)
  const N = p.size
  const w0 = (2 * Math.PI) / OCEAN_LOOP_SECONDS
  let mismatched = 0
  let unexplained = 0
  let worst = 0
  for (let c = 0; c < p.cascades.length; c++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = (c * N + y) * N + x
        if (gpu[i] === cpu[i]) continue
        mismatched++
        const [kx, kz] = waveVec(x, y, p.cascades[c]!, N)
        const q = omegaOf(Math.hypot(kx, kz)) / w0
        const d = Math.abs(q - Math.round(q))
        worst = Math.max(worst, d)
        if (Math.abs(gpu[i]! - cpu[i]!) !== 1 || d > OCEAN_PROBE_INDEX_BOUNDARY) unexplained++
      }
    }
  }
  return { mismatched, unexplained, worstBoundaryDistance: worst }
}

/** GPU から読み戻した場 */
export interface OceanGpuFields {
  h0: ArrayLike<number>
  frequencyIndex: ArrayLike<number>
  specA: ArrayLike<number>
  specB: ArrayLike<number>
  displacement: ArrayLike<number>
  derivatives: ArrayLike<number>
}

/** 突き合わせの要約。各値は `oceanNormalizedError` */
export interface OceanProbeSummary {
  index: OceanIndexCheck
  h0: number
  specA: number
  specB: number
  displacement: number
  derivatives: number
  /** 向きを取り違えた（x と y を入れ替えた）ときの変位の差。大きくなければ比べ方が空回り */
  displacementTransposed: number
  /** 場ごとの、差がいちばん大きかった要素 */
  worst: Record<'h0' | 'specA' | 'specB' | 'displacement' | 'derivatives', OceanWorst | null>
  /**
   * 段ごとの差。前の段に **GPU の出力**を入れて CPU で 1 段だけ解き、GPU のその段と比べる。
   * 差がどの段で生まれたかを切り分ける
   */
  stages: {
    /** GPU の h0 → CPU の時間発展 対 GPU の時間発展 */
    evolveA: number
    evolveB: number
    /** GPU の時間発展の結果 → CPU の逆 FFT 対 GPU の変位・傾き */
    fftDisplacement: number
    fftDerivatives: number
  }
  /** 変位で差が 1e-4 を越えた要素（大きい順に 5 個） */
  top: OceanWorst[]
}

/**
 * GPU の場を CPU 参照と比べる。**時間発展から先は GPU の周波数の番号を使う**（番号の
 * 食い違いは `index` で別に確かめる。境目の波は GPU と CPU で別の周波数になり、比べられない）
 */
export function compareOcean(gpu: OceanGpuFields, p: OceanSpectrumParams, ticks: number, alpha: number): OceanProbeSummary {
  const C = p.cascades.length
  const N = p.size
  const h0 = buildH0(p)
  const index = checkFrequencyIndex(gpu.frequencyIndex, p)
  const { specA, specB } = evolve(h0, gpu.frequencyIndex, ticks, alpha, p)
  const fields = oceanFields(h0, gpu.frequencyIndex, ticks, alpha, p)
  return {
    index,
    h0: oceanNormalizedError(gpu.h0, h0, N, C),
    specA: oceanNormalizedError(gpu.specA, specA, N, C),
    specB: oceanNormalizedError(gpu.specB, specB, N, C),
    displacement: oceanNormalizedError(gpu.displacement, fields.displacement, N, C),
    derivatives: oceanNormalizedError(gpu.derivatives, fields.derivatives, N, C),
    displacementTransposed: oceanNormalizedError(gpu.displacement, fields.displacement, N, C, true),
    worst: {
      h0: oceanWorstElement(gpu.h0, h0, N, C),
      specA: oceanWorstElement(gpu.specA, specA, N, C),
      specB: oceanWorstElement(gpu.specB, specB, N, C),
      displacement: oceanWorstElement(gpu.displacement, fields.displacement, N, C),
      derivatives: oceanWorstElement(gpu.derivatives, fields.derivatives, N, C),
    },
    stages: stageErrors(gpu, p, ticks, alpha),
    top: oceanTopMismatches(gpu.displacement, fields.displacement, N, C, 5),
  }
}

/** 段ごとの差（`OceanProbeSummary.stages`） */
function stageErrors(gpu: OceanGpuFields, p: OceanSpectrumParams, ticks: number, alpha: number): OceanProbeSummary['stages'] {
  const C = p.cascades.length
  const N = p.size
  const fromGpuH0 = evolve(Float64Array.from(gpu.h0), gpu.frequencyIndex, ticks, alpha, p)
  const displacement = assembleDisplacement(inverseFft2d(Float64Array.from(gpu.specA), N, C), p)
  const b = inverseFft2d(Float64Array.from(gpu.specB), N, C)
  return {
    evolveA: oceanNormalizedError(gpu.specA, fromGpuH0.specA, N, C),
    evolveB: oceanNormalizedError(gpu.specB, fromGpuH0.specB, N, C),
    fftDisplacement: oceanNormalizedError(gpu.displacement, displacement, N, C),
    fftDerivatives: oceanNormalizedError(gpu.derivatives, b, N, C),
  }
}
