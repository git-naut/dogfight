/**
 * FFT の海の CPU 参照（段 S3）。
 *
 * web-ocean（Noniv/web-ocean、MIT、a07c7fd）の `SIM_INIT`・`SIM_EVOLVE`・`FFT_ROWS`・
 * `FFT_COLS` の写し。Tessendorf の FFT の海で、波のスペクトルは JONSWAP、方向分布は
 * Donelan-Banner（風浪）と cos^2s（うねり）。TSL 版（`oceanNodes.ts`）の突き合わせの
 * 相手で、GPU の読み戻しと各成分の最大値に対する差 1e-4 で比べる（ユーザーの決定）。
 *
 * **式は web-ocean と 1 対 1 に写す。**変えたのは時間発展の位相の計算だけで、web-ocean は
 * `floor(ω/ω0)·ω0 × t` を 32 ビットの浮動小数で求める。細かいカスケードでは毛管波の項で
 * ω が最大 1,432 rad/s になり、ω/ω0 は最大 13.7 万。丸めで周波数の番号が 1 つずれる波が
 * 出るうえ、位相 ω·t が最大 86 万ラジアンに達して 32 ビットでは桁が足りない。ここでは
 * 番号 n を整数で持ち、時間を sim の刻み（1/120 秒）の整数と端数に分けて、
 * `(n × 刻み) mod 刻みの周期` を整数で求める（`phaseTicksMod`）。GPU 版も同じ手順にする。
 * ADR に記録する。
 *
 * three にも DOM にも依存しない。長さは m、時間は秒。倍精度で計算する。
 */

/** 重力加速度 m/s²（web-ocean の `GRAV`） */
export const GRAVITY = 9.81
/** 表面張力 / 密度 m³/s²（web-ocean の `SURF`。毛管波の項） */
export const SURFACE_TENSION = 7.4e-5

/** 1 カスケードの格子の一辺（web-ocean の `N`） */
export const OCEAN_FFT_SIZE = 256

/** 時間発展の周期 s（web-ocean の `LOOP`）。周波数をこの周期で量子化する */
export const OCEAN_LOOP_SECONDS = 600
/** sim の刻み s（`src/sim/loop.ts` の `FIXED_DT`）。位相の整数の刻み */
export const OCEAN_TICK_SECONDS = 1 / 120
/** 周期の刻みの数（600 秒 × 120） */
export const OCEAN_LOOP_TICKS = Math.round(OCEAN_LOOP_SECONDS / OCEAN_TICK_SECONDS)

/** 風浪とうねりの条件。web-ocean の画面のつまみ（`P`）と同じ意味 */
export interface OceanSpectrumParams {
  /** 各カスケードの一辺 m。大きい順 */
  cascades: readonly number[]
  /** 1 カスケードの格子の一辺 */
  size: number
  /** 海面 10 m の風速 m/s */
  windSpeed: number
  /** 波が進む向き rad（+X から +Z へ） */
  windDirection: number
  /** 吹送距離 m */
  fetch: number
  /** JONSWAP の尖り（web-ocean は 3.3） */
  gamma: number
  /** うねりの有義波高 m。0 でうねりなし */
  swellHeight: number
  /** うねりの向き rad */
  swellDirection: number
  /** うねりのピークの波長 m */
  swellLength: number
  /** うねりの方向分布 cos^2s の s */
  swellSpread: number
  /** 横の変位の強さ（choppiness、web-ocean の λ） */
  choppy: number
  /** ごく短い波を抑える長さ m（web-ocean の 0.0012） */
  shortCut: number
  /** 乱数の種 */
  seed: number
  /** スペクトルの倍率（web-ocean の `timeP.w`、既定 1） */
  gain: number
}

/**
 * web-ocean の既定（`P` と `CASC_L`、6 カスケード）。突き合わせと検査の固定の入力。
 * 本番の値は CP2 で決める（穏やかな海、有義波高 0.5〜0.8 m）
 */
export const WEB_OCEAN_DEFAULTS: OceanSpectrumParams = {
  cascades: [1103.0, 211.3, 39.7, 7.43, 1.393, 0.2617],
  size: OCEAN_FFT_SIZE,
  windSpeed: 7.0,
  windDirection: (118 * Math.PI) / 180,
  fetch: 90_000,
  gamma: 3.3,
  swellHeight: 1.8,
  swellDirection: (94 * Math.PI) / 180,
  swellLength: 120,
  swellSpread: 48,
  choppy: 1.25,
  shortCut: 0.0012,
  seed: 1,
  gain: 1,
}

/**
 * dogfight の海（CP2 の C、2026-10-29 ユーザーの決定）。風 6 m/s・吹送 20 km・うねり 0.3 m
 * （波長 80 m）。向き・γ・choppy などは web-ocean の既定のまま。有義波高は格子の分散から
 * 0.63 m（`significantWaveHeight`）
 */
export const DOGFIGHT_OCEAN: OceanSpectrumParams = {
  ...WEB_OCEAN_DEFAULTS,
  windSpeed: 6,
  fetch: 20_000,
  swellHeight: 0.3,
  swellLength: 80,
}

/**
 * 品質表の列（`oceanCascades`・`oceanFftSize`）から条件を作る。カスケードは長い側から残す。
 * エネルギーは長い波にあるので、減らしても有義波高はほぼ変わらない（CP2 の実測）
 */
export function oceanParamsFor(cascades: number, size: number, base: OceanSpectrumParams = DOGFIGHT_OCEAN): OceanSpectrumParams {
  return { ...base, cascades: base.cascades.slice(0, cascades), size }
}

/** 有義波高 4√m0 m。m0 は格子の上の分散 Σ 2(a(n)² + a(-n)²) を全カスケードで足したもの */
export function significantWaveHeight(p: OceanSpectrumParams): number {
  const bands = latticeBands(p)
  const N = p.size
  let m0 = 0
  for (let c = 0; c < p.cascades.length; c++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const [nx, ny] = latticeIndex(x, y, N)
        const a = amplitude(nx, ny, c, p, bands)
        const b = amplitude(-nx, -ny, c, p, bands)
        m0 += 2 * (a * a + b * b)
      }
    }
  }
  return 4 * Math.sqrt(m0)
}

// ---- 分散とスペクトル ----

/** 角周波数 rad/s。深水の重力波に毛管波の項を足す（web-ocean の `omegaOf`） */
export function omegaOf(k: number): number {
  return Math.sqrt(GRAVITY * k + SURFACE_TENSION * k * k * k)
}

/** 群速度 dω/dk（web-ocean の `dOmegaOf`） */
export function dOmegaOf(k: number): number {
  return (GRAVITY + 3 * SURFACE_TENSION * k * k) / (2 * omegaOf(k))
}

/** JONSWAP の周波数スペクトル S(ω)（web-ocean の `jonswap`） */
export function jonswap(w: number, wp: number, alpha: number, gamma: number): number {
  const sigma = w <= wp ? 0.07 : 0.09
  const d = (w - wp) / (sigma * wp)
  const r = Math.exp(-0.5 * d * d)
  const q = wp / w
  const q2 = q * q
  return ((alpha * GRAVITY * GRAVITY) / (w * w * w * w * w)) * Math.exp(-1.25 * q2 * q2) * Math.pow(gamma, r)
}

/** Donelan-Banner の方向分布。[-π, π] で積分が 1（web-ocean の `donelanBanner`） */
export function donelanBanner(theta: number, w: number, wp: number): number {
  const ratio = w / wp
  let beta: number
  if (ratio < 0.95) {
    beta = 2.61 * Math.pow(ratio, 1.3)
  } else if (ratio < 1.6) {
    beta = 2.28 * Math.pow(ratio, -1.3)
  } else {
    const eps = -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(ratio * ratio))
    beta = Math.pow(10, eps)
  }
  const sh = 1 / Math.cosh(Math.min(Math.max(beta * theta, -20), 20))
  return (beta / (2 * Math.tanh(beta * Math.PI))) * sh * sh
}

/** cos^2s(θ/2) の方向分布（うねり、web-ocean の `cosSpread`） */
export function cosSpread(theta: number, s: number): number {
  const q = Math.sqrt(s + 0.25) / (2 * Math.sqrt(Math.PI))
  return q * Math.pow(Math.abs(Math.cos(theta * 0.5)), 2 * s)
}

/** 角度を [-π, π) へ（web-ocean の `wrapAngle`） */
export function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))
}

/** 風浪の JONSWAP の α と ピーク ω（吹送距離で決まる。web-ocean の `spectrum` の前半） */
export function windSeaShape(p: OceanSpectrumParams): { alpha: number; wp: number } {
  const U = p.windSpeed
  const F = p.fetch
  return {
    alpha: 0.076 * Math.pow((U * U) / (F * GRAVITY), 0.22),
    wp: 22 * Math.pow((GRAVITY * GRAVITY) / (U * F), 1 / 3),
  }
}

/** うねりのピーク ω（深水の分散 ω = √(gk)、web-ocean の `simF[46]`） */
export function swellPeak(p: OceanSpectrumParams): number {
  return Math.sqrt(GRAVITY * ((2 * Math.PI) / p.swellLength))
}

/** うねりの JONSWAP の α（有義波高から、尖り 6。web-ocean の `alphaS`） */
export function swellAlpha(p: OceanSpectrumParams): number {
  const ws = swellPeak(p)
  const gs = 6
  const hs4 = p.swellHeight * 0.25
  return ((hs4 * hs4 * 5 * ws * ws * ws * ws) / (GRAVITY * GRAVITY)) * (1 - 0.287 * Math.log(gs))
}

/**
 * 波の向きと方向 dir の差（rad、[-π, π]）。`wrapAngle(atan2(kz, kx) - dir)` と同じ値。
 *
 * **ゼロの符号に頼らない形にする。**web-ocean は atan2(kz, kx) から引くが、格子の軸の上は
 * kz がゼロで、atan2 の答えがゼロの符号で ±π 分かれる。段 S3 の突き合わせで、SwiftShader が
 * 軸の上の -k 側だけ角度を π 取り違えた（-k を `0 - n` で作っても同じ。コンパイラが `-n` に
 * 書き換えて -0 を作ったと見ている。推測）。差を外積と内積の atan2 で直接求めれば、ゼロに
 * なるのは波が dir とちょうど平行なときだけで、118 度・94 度には格子点が乗らない
 */
export function directionDelta(kx: number, kz: number, dir: number): number {
  const c = Math.cos(dir)
  const s = Math.sin(dir)
  return Math.atan2(kz * c - kx * s, kx * c + kz * s)
}

/**
 * 波数ベクトル (kx, kz) の方向スペクトル（web-ocean の `spectrum`）。
 * 周波数スペクトル × 方向分布を、波数の面積あたりへ写したもの
 */
export function spectrum(kx: number, kz: number, p: OceanSpectrumParams): number {
  const kl = Math.hypot(kx, kz)
  const w = omegaOf(kl)
  let Sw = 0
  if (p.windSpeed > 0.1) {
    const { alpha, wp } = windSeaShape(p)
    Sw = jonswap(w, wp, alpha, p.gamma) * donelanBanner(directionDelta(kx, kz, p.windDirection), w, wp)
  }
  if (p.swellHeight > 0.001) {
    Sw += jonswap(w, swellPeak(p), swellAlpha(p), 6) * cosSpread(directionDelta(kx, kz, p.swellDirection), p.swellSpread)
  }
  Sw *= Math.exp(-kl * kl * p.shortCut * p.shortCut)
  return ((Sw * dOmegaOf(kl)) / kl) * p.gain
}

/**
 * 各カスケードが受け持つ波数の帯 [kMin, kMax)（web-ocean の `writeSimStatic`）。
 * 隣のカスケードとは隙間も重なりも無い
 */
export function cascadeBands(p: OceanSpectrumParams): { kMin: number[]; kMax: number[] } {
  const L = p.cascades
  const C = L.length
  const kMin: number[] = []
  const kMax: number[] = []
  for (let c = 0; c < C; c++) {
    kMin.push(c === 0 ? Math.PI / L[c]! : (2 * Math.PI * 6) / L[c]!)
    kMax.push(c < C - 1 ? (2 * Math.PI * 6) / L[c + 1]! : ((Math.PI * p.size) / L[c]!) * 0.98)
  }
  for (let c = 1; c < C; c++) kMin[c] = kMax[c - 1]!
  return { kMin, kMax }
}

/**
 * 各カスケードの帯を、**格子の整数の半径の 2 乗**（r² = nx² + ny²）で表したもの。
 * 下限は含み、上限は含まない。
 *
 * web-ocean は波数 |k| と kMin・kMax を浮動小数で比べる。2 段目以降の下限 2π·6/L には
 * 格子点 (±6, 0)・(0, ±6) がちょうど乗り、32 ビットと 64 ビットで帯に入るかが分かれた
 * （段 S3 の突き合わせで、カスケード 3 の (0, 6) が GPU にだけ入った）。ここでは境目を
 * 整数で決める。下限は 1 段目が r² ≥ 0.25（0 波数だけを除く）、2 段目以降が r² ≥ 36
 * ちょうど。上限は 6·Lc/Lc+1 の 2 乗（最後は 0.49·N の 2 乗）で、整数から離れている
 * ことを検査で縛る。帯の中身は `cascadeBands` と同じ
 */
export function latticeBands(p: OceanSpectrumParams): { rMin2: number[]; rMax2: number[] } {
  const L = p.cascades
  const C = L.length
  const rMin2: number[] = []
  const rMax2: number[] = []
  for (let c = 0; c < C; c++) {
    rMin2.push(c === 0 ? 0.25 : 36)
    const r = c < C - 1 ? (6 * L[c]!) / L[c + 1]! : 0.49 * p.size
    rMax2.push(r * r)
  }
  return { rMin2, rMax2 }
}

/** 格子の (x, y) の波数ベクトル。半分より上は負の周波数（web-ocean の `waveVec`） */
export function waveVec(x: number, y: number, L: number, size: number): [number, number] {
  const nx = x >= size / 2 ? x - size : x
  const ny = y >= size / 2 ? y - size : y
  const s = (2 * Math.PI) / L
  return [nx * s, ny * s]
}

/**
 * 逆 FFT の前に jxz を縮める係数（カスケードごと、帯の上限の波数 rad/m）。
 *
 * web-ocean は高さ h と jxz を 1 本の複素数に詰めて逆 FFT にかける。jxz は λ·k·h に比例し、
 * 細かいカスケードでは h の 85 倍（カスケード 5）になる。32 ビットでは jxz の丸めが h に乗り、
 * 高さが最大値の 1.2% ずれた（段 S3 の突き合わせ）。詰める前に jxz をこの係数で割り、
 * 逆 FFT の後で掛け戻す。逆 FFT は線形なので値は変わらず、丸めだけが釣り合う
 */
export function jxzScale(p: OceanSpectrumParams): number[] {
  const { rMax2 } = latticeBands(p)
  return p.cascades.map((L, c) => (Math.sqrt(rMax2[c]!) * 2 * Math.PI) / L)
}

/** 格子の番号を、負の周波数を含む整数の組 (nx, ny) へ */
export function latticeIndex(x: number, y: number, size: number): [number, number] {
  return [x >= size / 2 ? x - size : x, y >= size / 2 ? y - size : y]
}

/** 細かい 2 カスケードを控えめにする倍率（web-ocean の `amplitude` の g） */
export const cascadeGain = (c: number): number => (c >= 4 ? (c === 5 ? 0.6 : 0.85) : 1)

/**
 * 格子の整数の組 (nx, ny) の波の振幅（web-ocean の `amplitude`）。帯の判定は
 * `latticeBands`（整数の半径）で行う
 */
export function amplitude(
  nx: number,
  ny: number,
  c: number,
  p: OceanSpectrumParams,
  bands = latticeBands(p),
): number {
  const r2 = nx * nx + ny * ny
  if (r2 < bands.rMin2[c]! || r2 >= bands.rMax2[c]!) return 0
  const s = (2 * Math.PI) / p.cascades[c]!
  return Math.sqrt(Math.max(spectrum(nx * s, ny * s, p), 0)) * s * 0.5 * cascadeGain(c)
}

// ---- 乱数（web-ocean の `pcgHash`・`rand01`・`gauss2`、32 ビットの符号なし整数） ----

/** PCG のハッシュ。u32 の演算を `Math.imul` と `>>> 0` で写す */
export function pcgHash(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}

/** [0, 1) の一様乱数（24 ビット） */
export function rand01(s: number): number {
  return ((pcgHash(s) >>> 8) + 0.5) / 16777216
}

/** 標準正規の 2 つ組（Box-Muller） */
export function gauss2(seed: number): [number, number] {
  const u1 = rand01((Math.imul(seed >>> 0, 2) + 17) >>> 0)
  const u2 = rand01((Math.imul(seed >>> 0, 2) + 18 + pcgHash(seed)) >>> 0)
  const r = Math.sqrt(-2 * Math.log(u1))
  const a = 2 * Math.PI * u2
  return [r * Math.cos(a), r * Math.sin(a)]
}

// ---- 初期値 h0 ----

/**
 * 全カスケードの h0（web-ocean の `SIM_INIT`）。要素は (c, y, x) の順に 4 つずつで、
 * (Re h0(k), Im h0(k), Re conj(h0(-k)), Im conj(h0(-k)))
 */
export function buildH0(p: OceanSpectrumParams): Float64Array {
  const N = p.size
  const C = p.cascades.length
  const bands = latticeBands(p)
  const out = new Float64Array(C * N * N * 4)
  for (let c = 0; c < C; c++) {
    const seed = (Math.imul(p.seed >>> 0, 7919) + Math.imul(c, 1000003)) >>> 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const [nx, ny] = latticeIndex(x, y, N)
        const mx = (N - x) % N
        const my = (N - y) % N
        const ga = gauss2((seed + y * N + x) >>> 0)
        const gb = gauss2((seed + my * N + mx) >>> 0)
        const aa = amplitude(nx, ny, c, p, bands)
        const ab = amplitude(-nx, -ny, c, p, bands)
        const i = ((c * N + y) * N + x) * 4
        out[i] = ga[0] * aa
        out[i + 1] = ga[1] * aa
        out[i + 2] = gb[0] * ab
        out[i + 3] = -gb[1] * ab
      }
    }
  }
  return out
}

// ---- 時間発展 ----

/** 量子化した周波数の番号 n（ω ≈ n·2π/周期）。0 波数は 0 */
export function frequencyIndex(kx: number, kz: number): number {
  const kl = Math.hypot(kx, kz)
  if (kl < 1e-5) return 0
  return Math.floor(omegaOf(kl) / ((2 * Math.PI) / OCEAN_LOOP_SECONDS))
}

/** 全カスケードの n の表（(c, y, x) の順） */
export function buildFrequencyIndex(p: OceanSpectrumParams): Int32Array {
  const N = p.size
  const C = p.cascades.length
  const out = new Int32Array(C * N * N)
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const [kx, kz] = waveVec(x, y, p.cascades[c]!, N)
        out[(c * N + y) * N + x] = frequencyIndex(kx, kz)
      }
    }
  }
  return out
}

/** `phaseTicksMod` が刻みを上下に分ける幅 */
export const PHASE_SPLIT = 512

/**
 * (n × m) mod 周期の刻み数を、32 ビットの符号なし整数の範囲で求める（GPU 版と同じ手順）。
 *
 * n は最大 13.7 万、m は 7.2 万未満なので、そのまま掛けると約 98 億で 32 ビット
 * （約 43 億）を越える。n を先に周期で割った余り a（7.2 万未満）にし、m を 512 で上下に
 * 分けて掛ける。途中の値は最大で a × 141 ≈ 1,000 万、(… mod T) × 512 ≈ 3,700 万、
 * a × 511 ≈ 3,700 万、その和 ≈ 7,400 万
 */
export function phaseTicksMod(n: number, m: number): number {
  const T = OCEAN_LOOP_TICKS
  const a = n % T
  const mh = Math.floor(m / PHASE_SPLIT)
  const ml = m % PHASE_SPLIT
  return ((((a * mh) % T) * PHASE_SPLIT) + a * ml) % T
}

/**
 * 位相 ω·t（mod 2π）。t = (ticks + alpha) × 刻み。**整数の部分を整数で正確に求める**
 * （ファイルの頭の注記）。端数 alpha の分（n × alpha、最大 13.7 万）だけを浮動小数で足す
 */
export function evolvePhase(n: number, ticks: number, alpha: number): number {
  const T = OCEAN_LOOP_TICKS
  const m = ((ticks % T) + T) % T
  return ((2 * Math.PI) * (phaseTicksMod(n, m) + n * alpha)) / T
}

/**
 * 時間発展（web-ocean の `SIM_EVOLVE`）。返すのは 2 本のスペクトルで、要素ごとに複素 2 つ。
 * A = (Dx + i·Dz, h + i·jxz/κ)、B = (sx + i·sz, jxx + i·jzz)。実数の場を 2 つずつ 1 本の
 * 複素数に詰める（逆 FFT の後で実部と虚部に分かれる）。κ は `jxzScale`
 */
export function evolve(
  h0: Float64Array,
  nTable: ArrayLike<number>,
  ticks: number,
  alpha: number,
  p: OceanSpectrumParams,
): { specA: Float64Array; specB: Float64Array } {
  const N = p.size
  const C = p.cascades.length
  const specA = new Float64Array(C * N * N * 4)
  const specB = new Float64Array(C * N * N * 4)
  const lam = p.choppy
  const kappa = jxzScale(p)
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const idx = (c * N + y) * N + x
        const [kx, kz] = waveVec(x, y, p.cascades[c]!, N)
        const kl = Math.hypot(kx, kz)
        if (kl < 1e-5) continue
        const ph = evolvePhase(nTable[idx]!, ticks, alpha)
        const ec = Math.cos(ph)
        const es = Math.sin(ph)
        const a0 = h0[idx * 4]!
        const a1 = h0[idx * 4 + 1]!
        const b0 = h0[idx * 4 + 2]!
        const b1 = h0[idx * 4 + 3]!
        // h = h0(k)·e^{-iωt} + conj(h0(-k))·e^{iωt}
        const hr = a0 * ec + a1 * es + (b0 * ec - b1 * es)
        const hi = -a0 * es + a1 * ec + (b0 * es + b1 * ec)
        // i·h
        const ihr = -hi
        const ihi = hr
        const ik = 1 / kl
        const Dxr = ihr * lam * kx * ik
        const Dxi = ihi * lam * kx * ik
        const Dzr = ihr * lam * kz * ik
        const Dzi = ihi * lam * kz * ik
        const jxzR = (hr * (-lam * kx * kz * ik)) / kappa[c]!
        const jxzI = (hi * (-lam * kx * kz * ik)) / kappa[c]!
        const sxr = ihr * kx
        const sxi = ihi * kx
        const szr = ihr * kz
        const szi = ihi * kz
        const jxxR = hr * (-lam * kx * kx * ik)
        const jxxI = hi * (-lam * kx * kx * ik)
        const jzzR = hr * (-lam * kz * kz * ik)
        const jzzI = hi * (-lam * kz * kz * ik)
        const o = idx * 4
        // u + i·v（u, v は複素数）= (u.r - v.i, u.i + v.r)
        specA[o] = Dxr - Dzi
        specA[o + 1] = Dxi + Dzr
        specA[o + 2] = hr - jxzI
        specA[o + 3] = hi + jxzR
        specB[o] = sxr - szi
        specB[o + 1] = sxi + szr
        specB[o + 2] = jxxR - jzzI
        specB[o + 3] = jxxI + jzzR
      }
    }
  }
  return { specA, specB }
}

// ---- 逆 FFT ----

/**
 * 1 本の逆 DFT（正規化なし、指数は +i）。web-ocean の `butterflies` と同じ向き。
 * re・im は長さ N の作業列で、その場で書き換える
 */
export function inverseFft1d(re: Float64Array, im: Float64Array): void {
  const N = re.length
  const logN = Math.round(Math.log2(N))
  for (let i = 0; i < N; i++) {
    let r = 0
    for (let b = 0; b < logN; b++) r |= ((i >> b) & 1) << (logN - 1 - b)
    if (r > i) {
      ;[re[i], re[r]] = [re[r]!, re[i]!]
      ;[im[i], im[r]] = [im[r]!, im[i]!]
    }
  }
  for (let half = 1; half < N; half *= 2) {
    for (let start = 0; start < N; start += half * 2) {
      for (let pos = 0; pos < half; pos++) {
        const ang = (Math.PI * pos) / half
        const wr = Math.cos(ang)
        const wi = Math.sin(ang)
        const i0 = start + pos
        const i1 = i0 + half
        const tr = re[i1]! * wr - im[i1]! * wi
        const ti = re[i1]! * wi + im[i1]! * wr
        re[i1] = re[i0]! - tr
        im[i1] = im[i0]! - ti
        re[i0] = re[i0]! + tr
        im[i0] = im[i0]! + ti
      }
    }
  }
}

/**
 * 2 本の複素数を詰めたスペクトル（要素ごとに 4 つ）を、カスケードごとに 2 次元の逆 FFT に
 * かける（行 → 列、web-ocean の `FFT_ROWS`・`FFT_COLS`）
 */
export function inverseFft2d(spec: Float64Array, size: number, cascades: number): Float64Array {
  const N = size
  const out = Float64Array.from(spec)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let c = 0; c < cascades; c++) {
    for (const pair of [0, 2]) {
      // 行（x 方向）
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const o = ((c * N + y) * N + x) * 4 + pair
          re[x] = out[o]!
          im[x] = out[o + 1]!
        }
        inverseFft1d(re, im)
        for (let x = 0; x < N; x++) {
          const o = ((c * N + y) * N + x) * 4 + pair
          out[o] = re[x]!
          out[o + 1] = im[x]!
        }
      }
      // 列（y 方向）
      for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
          const o = ((c * N + y) * N + x) * 4 + pair
          re[y] = out[o]!
          im[y] = out[o + 1]!
        }
        inverseFft1d(re, im)
        for (let y = 0; y < N; y++) {
          const o = ((c * N + y) * N + x) * 4 + pair
          out[o] = re[y]!
          out[o + 1] = im[y]!
        }
      }
    }
  }
  return out
}

/** 1 カスケードの格子の、海面の場（web-ocean の `emit`） */
export interface OceanFields {
  /** (Dx, Dy, Dz, jxz)。Dy が高さ */
  displacement: Float64Array
  /** (sx, sz, jxx, jzz)。高さの傾きと、横の変位の微分 */
  derivatives: Float64Array
}

/** 時間発展から海面の場まで（逆 FFT と組み立て） */
export function oceanFields(
  h0: Float64Array,
  nTable: ArrayLike<number>,
  ticks: number,
  alpha: number,
  p: OceanSpectrumParams,
): OceanFields {
  const C = p.cascades.length
  const { specA, specB } = evolve(h0, nTable, ticks, alpha, p)
  return {
    displacement: assembleDisplacement(inverseFft2d(specA, p.size, C), p),
    derivatives: inverseFft2d(specB, p.size, C),
  }
}

/** 逆 FFT のあとの A（Dx, Dz, Dy, jxz/κ）を (Dx, Dy, Dz, jxz) へ並べ替え、jxz を掛け戻す */
export function assembleDisplacement(a: ArrayLike<number>, p: OceanSpectrumParams): Float64Array {
  const N = p.size
  const kappa = jxzScale(p)
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i += 4) {
    const c = Math.floor(i / 4 / (N * N))
    out[i] = a[i]!
    out[i + 1] = a[i + 2]!
    out[i + 2] = a[i + 1]!
    out[i + 3] = a[i + 3]! * kappa[c]!
  }
  return out
}

/**
 * ヤコビアン（横の変位で面が畳まれる度合い）。1 を下回るほど畳まれ、負で裏返る。
 * 泡を出す目安（web-ocean の泡の更新が使う形）
 */
export function jacobian(jxx: number, jzz: number, jxz: number): number {
  return (1 + jxx) * (1 + jzz) - jxz * jxz
}
