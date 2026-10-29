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

// ---- 海面のテクスチャ（段 S4a-1）----
//
// FFT の出力をミップ付きのテクスチャへ写し、頂点シェーダと同じ式（`oceanCascadeLod`・
// `oceanUvOffset`）で引いた値を、CPU 参照の場から同じ引き方で求めた値と比べる。ミップは
// three の生成（2 × 2 の平均）、引き方は repeat の双線形と段の間の線形

/** 突き合わせの uv の起点。端数（`oceanUvOffset`）が 0 にならない値 */
export const OCEAN_SURFACE_PROBE_ORIGIN: readonly [number, number] = [-3_071.25, 2_050.5]
/** 頂点の間隔 m。段 0 から粗い段まで */
export const OCEAN_SURFACE_PROBE_CELLS: readonly number[] = [0.01, 0.6, 5, 40]
/** 間隔ごとの点の数 */
export const OCEAN_SURFACE_PROBE_COUNT = 64

/**
 * 点を散らす幅 m。`far` は覆う範囲（high の 3 km 四方）で、使われ方そのもの。`near` は起点の
 * 近く（16 m 四方）で、uv の桁が小さく、テクスチャの精度（16 か 32 ビット）だけが残る
 */
export const OCEAN_SURFACE_PROBE_SPANS = { far: 3_072, near: 16 } as const

/**
 * 許容（カスケードと成分ごとの場の最大値に対する差）。
 *
 * `far` は 32 ビットの uv の丸めで決まる。起点から 3 km 先では細かいカスケード（一辺 7.43 m、
 * texel 2.9 cm）の uv が約 400 周になり、texel の位置が 0.008 前後ずれる。2026-10-29 の実測で
 * 16・32 ビットとも最大 1.07e-3（高さで 0.03 mm）で、起点の近くでは 1e-6 まで下がる。丸めの順番
 * （割り算・サンプラの中の掛け算）は CPU で再現できていない（推測）。`near` は精度ごとで、
 * 実測は 16 ビット 1.1e-4・32 ビット 4.3e-6（SwiftShader）。双線形の重みを 8 ビットに丸める
 * 見立ては、CPU で丸めると差がかえって増えたので外した
 */
export const OCEAN_SURFACE_TOLERANCE = { far: 2e-3, near: { '16': 2e-4, '32': 1e-5 } } as const

/** 突き合わせの点 (x, z, 間隔, 0)。起点から幅 span の四方に散らす。乱数は使わない */
export function oceanSurfaceProbePoints(span: number = OCEAN_SURFACE_PROBE_SPANS.far): Float32Array {
  const out = new Float32Array(OCEAN_SURFACE_PROBE_CELLS.length * OCEAN_SURFACE_PROBE_COUNT * 4)
  const [ox, oz] = OCEAN_SURFACE_PROBE_ORIGIN
  let k = 0
  for (const cell of OCEAN_SURFACE_PROBE_CELLS) {
    for (let i = 0; i < OCEAN_SURFACE_PROBE_COUNT; i++) {
      // 黄金比の刻みで [0, 1) に散らす（R2 列）
      const a = (i * 0.7548776662466927) % 1
      const b = (i * 0.5698402909980532) % 1
      out[k++] = ox + a * span
      out[k++] = oz + b * span
      out[k++] = cell
      out[k++] = 0
    }
  }
  return out
}

/** 場（要素ごとに 4 つ、カスケード × N²）のミップ。段 l は一辺 N / 2^l、2 × 2 の平均 */
export function buildOceanMips(field: ArrayLike<number>, N: number, C: number): Float64Array[] {
  const levels: Float64Array[] = [Float64Array.from(field)]
  for (let n = N / 2; n >= 1; n /= 2) {
    const prev = levels[levels.length - 1]!
    const pn = n * 2
    const next = new Float64Array(C * n * n * 4)
    for (let c = 0; c < C; c++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          for (let ch = 0; ch < 4; ch++) {
            const at = (xx: number, yy: number) => prev[((c * pn + yy) * pn + xx) * 4 + ch]!
            next[((c * n + y) * n + x) * 4 + ch] =
              (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4
          }
        }
      }
    }
    levels.push(next)
  }
  return levels
}

/** 段 l を (u, v) で repeat の双線形に引く。texel の中心は (i + 0.5) / n */
function bilinear(level: Float64Array, n: number, c: number, u: number, v: number): number[] {
  const fx = u * n - 0.5
  const fy = v * n - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const wrap = (i: number) => ((i % n) + n) % n
  const out = [0, 0, 0, 0]
  for (const [dx, dy, w] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty],
    [1, 1, tx * ty],
  ] as const) {
    const i = ((c * n + wrap(y0 + dy)) * n + wrap(x0 + dx)) * 4
    for (let ch = 0; ch < 4; ch++) out[ch]! += w * level[i + ch]!
  }
  return out
}

/** カスケード c を (u, v) と段 lod（端数は段の間の線形）で引く。段は [0, 最後] に収める */
export function sampleOceanCpu(mips: Float64Array[], N: number, c: number, u: number, v: number, lod: number): number[] {
  const last = mips.length - 1
  const l = Math.min(Math.max(lod, 0), last)
  const l0 = Math.floor(l)
  const l1 = Math.min(l0 + 1, last)
  const t = l - l0
  const a = bilinear(mips[l0]!, N >> l0, c, u, v)
  if (t === 0) return a
  const b = bilinear(mips[l1]!, N >> l1, c, u, v)
  return a.map((x, i) => x + (b[i]! - x) * t)
}

/** 海面のテクスチャの突き合わせの要約 */
export interface OceanSurfaceSummary {
  /** 変位 (Dx, Dy, Dz) の差を、カスケードと成分ごとの場の最大値で割った値の最大 */
  error: number
  /** 間隔ごとの同じ値 */
  byCell: number[]
  /** CPU の u と v を入れ替えたときの差。大きくなければ比べ方が空回り */
  transposed: number
  /** 足さなかった（段が粗すぎる）カスケードと点の組の数 */
  skipped: number
}

/**
 * GPU が引いた値（点 × カスケード、vec4）を CPU の場から同じ引き方で求めた値と比べる。
 * 足さないカスケードは GPU が 0 を書く
 */
export function compareOceanSurface(
  gpu: ArrayLike<number>,
  points: ArrayLike<number>,
  displacement: ArrayLike<number>,
  p: OceanSpectrumParams,
  lodOf: (cell: number, L: number, N: number) => number,
  skippedAt: (lod: number, N: number) => boolean,
): OceanSurfaceSummary {
  const N = p.size
  const C = p.cascades.length
  const mips = buildOceanMips(displacement, N, C)
  const scale: number[] = []
  for (let c = 0; c < C; c++) {
    for (let ch = 0; ch < 3; ch++) {
      let m = 0
      for (let i = 0; i < N * N; i++) m = Math.max(m, Math.abs(displacement[(c * N * N + i) * 4 + ch]!))
      scale.push(m)
    }
  }
  const M = points.length / 4
  const perCell = OCEAN_SURFACE_PROBE_COUNT
  const byCell = new Array<number>(Math.ceil(M / perCell)).fill(0)
  let error = 0
  let transposed = 0
  let skipped = 0
  for (let k = 0; k < M; k++) {
    const x = points[k * 4]!
    const z = points[k * 4 + 1]!
    const cell = points[k * 4 + 2]!
    for (let c = 0; c < C; c++) {
      const L = p.cascades[c]!
      const lod = lodOf(cell, L, N)
      const g = [0, 1, 2].map((ch) => gpu[(k * C + c) * 4 + ch]!)
      let want = [0, 0, 0]
      let swap = [0, 0, 0]
      if (skippedAt(lod, N)) {
        skipped++
      } else {
        const u = x / L + 0.5 / N
        const v = z / L + 0.5 / N
        want = sampleOceanCpu(mips, N, c, u, v, lod)
        swap = sampleOceanCpu(mips, N, c, v, u, lod)
      }
      for (let ch = 0; ch < 3; ch++) {
        const s = scale[c * 3 + ch]!
        if (s === 0) continue
        const e = Math.abs(g[ch]! - want[ch]!) / s
        error = Math.max(error, e)
        byCell[Math.floor(k / perCell)] = Math.max(byCell[Math.floor(k / perCell)]!, e)
        transposed = Math.max(transposed, Math.abs(g[ch]! - swap[ch]!) / s)
      }
    }
  }
  return { error, byCell, transposed, skipped }
}
