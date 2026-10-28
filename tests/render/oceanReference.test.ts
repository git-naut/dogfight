import { describe, expect, it } from 'vitest'
import {
  GRAVITY,
  SURFACE_TENSION,
  OCEAN_LOOP_SECONDS,
  OCEAN_LOOP_TICKS,
  OCEAN_TICK_SECONDS,
  WEB_OCEAN_DEFAULTS as P,
  buildFrequencyIndex,
  buildH0,
  cascadeBands,
  cascadeGain,
  latticeBands,
  amplitude,
  cosSpread,
  directionDelta,
  wrapAngle,
  dOmegaOf,
  donelanBanner,
  evolvePhase,
  inverseFft1d,
  jonswap,
  oceanFields,
  omegaOf,
  pcgHash,
  phaseTicksMod,
  spectrum,
  swellAlpha,
  swellPeak,
  waveVec,
  windSeaShape,
  type OceanSpectrumParams,
} from '@render/ocean/reference'
import { checkFrequencyIndex, oceanNormalizedError } from '@render/ocean/oceanProbe'

/**
 * FFT の海の CPU 参照（`src/render/ocean/reference.ts`、段 S3）を、式の外の相手で縛る。
 *
 * GPU との一致は node-path.spec が見る。**両側が同じ誤りを持てばそこは通る**ので、ここは
 * 解析式・積分・独立に書いた計算と比べる。許容は 2026-10-28 の実測を見て決めた
 * （値は各検査の注記）。
 */

/** 区間 [a, b) を n 等分した中点則 */
function integrate(f: (x: number) => number, a: number, b: number, n: number): number {
  const dx = (b - a) / n
  let s = 0
  for (let i = 0; i < n; i++) s += f(a + (i + 0.5) * dx) * dx
  return s
}

describe('分散の式', () => {
  it('長い波は深水の重力波 ω² = gk に近づく', () => {
    for (const k of [0.001, 0.01, 0.1]) {
      expect(omegaOf(k) ** 2 / (GRAVITY * k) - 1).toBeLessThan(1e-4)
    }
  })

  it('短い波は表面張力で速くなる（毛管波の項 σk³）', () => {
    // 細かいカスケード（波数 3,000 前後）では ω の大半がこの項になる（`reference.ts` の注記）
    for (const k of [100, 1000, 3000]) {
      expect(Math.abs((omegaOf(k) ** 2 - GRAVITY * k) / (SURFACE_TENSION * k ** 3) - 1), `k=${k}`).toBeLessThan(1e-9)
    }
  })

  it('群速度が角周波数の数値微分と一致する', () => {
    for (const k of [0.01, 1, 100, 3000]) {
      const h = k * 1e-6
      const numeric = (omegaOf(k + h) - omegaOf(k - h)) / (2 * h)
      expect(Math.abs(dOmegaOf(k) / numeric - 1), `k=${k}`).toBeLessThan(1e-6)
    }
  })
})

describe('スペクトルの形', () => {
  it('Donelan-Banner の方向分布は [-π, π] で積分が 1（実測 1.000000）', () => {
    for (const ratio of [0.5, 0.8, 1, 1.2, 2, 4]) {
      const s = integrate((t) => donelanBanner(t, ratio, 1), -Math.PI, Math.PI, 20_000)
      expect(Math.abs(s - 1), `ω/ωp=${ratio}`).toBeLessThan(1e-4)
    }
  })

  it('cos^2s の方向分布は積分が 1 に近い（近似の正規化。実測 s=2 で 0.997）', () => {
    for (const sp of [2, 10, 48]) {
      const s = integrate((t) => cosSpread(t, sp), -Math.PI, Math.PI, 20_000)
      expect(Math.abs(s - 1), `s=${sp}`).toBeLessThan(5e-3)
    }
  })

  it('向きの差が web-ocean の wrapAngle(atan2(kz, kx) - dir) と一致する', () => {
    for (const dir of [P.windDirection, P.swellDirection, 0.3, -2.5]) {
      for (const [kx, kz] of [[1, 2], [-3, 0.5], [0.2, -4], [-1, -1], [5, 0.01]]) {
        const want = wrapAngle(Math.atan2(kz!, kx!) - dir)
        const got = directionDelta(kx!, kz!, dir)
        const d = Math.abs(((got - want + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
        expect(d, `dir=${dir} k=(${kx}, ${kz})`).toBeLessThan(1e-12)
      }
    }
  })

  it('向きの差は軸の上でゼロの符号に左右されない', () => {
    // 段 S3 で SwiftShader が軸の上の -k 側だけ角度を π 取り違えた（`directionDelta` の注記）
    for (const dir of [P.windDirection, P.swellDirection]) {
      for (const kx of [-10, 7]) {
        expect(directionDelta(kx, -0, dir)).toBe(directionDelta(kx, 0, dir))
      }
    }
  })

  it('JONSWAP はピークの周波数で最も大きい', () => {
    const wp = 1.2
    let best = 0
    let at = 0
    for (let w = 0.3; w < 4; w += 1e-4) {
      const v = jonswap(w, wp, 0.01, 3.3)
      if (v > best) {
        best = v
        at = w
      }
    }
    expect(Math.abs(at / wp - 1)).toBeLessThan(1e-3)
  })

  it('うねりの有義波高 4√m0 が指定に合う（実測 1.794 m 対 1.8 m）', () => {
    const ws = swellPeak(P)
    const m0 = integrate((w) => jonswap(w, ws, swellAlpha(P), 6), 0.05, 20, 200_000)
    expect(Math.abs((4 * Math.sqrt(m0)) / P.swellHeight - 1)).toBeLessThan(0.01)
  })

  it('格子に配った分散が、1 次元の積分の有義波高と 2% 以内（実測 0.4%）', () => {
    // 格子の分散 = Σ S(k)·dk²（各カスケードの帯の内、細かい 2 カスケードの減衰込み）。
    // 帯の隙間・重なり・取りこぼしがあればずれる
    const bands = cascadeBands(P)
    let grid = 0
    for (let c = 0; c < P.cascades.length; c++) {
      const L = P.cascades[c]!
      const dk = (2 * Math.PI) / L
      const g = cascadeGain(c)
      for (let y = 0; y < P.size; y++) {
        for (let x = 0; x < P.size; x++) {
          const [kx, kz] = waveVec(x, y, L, P.size)
          const kl = Math.hypot(kx, kz)
          if (kl < 1e-5 || kl < bands.kMin[c]! || kl >= bands.kMax[c]!) continue
          grid += spectrum(kx, kz, P) * dk * dk * g * g
        }
      }
    }
    const { alpha, wp } = windSeaShape(P)
    const m0 =
      integrate((w) => jonswap(w, wp, alpha, P.gamma), 0.05, 40, 400_000) +
      integrate((w) => jonswap(w, swellPeak(P), swellAlpha(P), 6), 0.05, 20, 200_000)
    expect(Math.abs(Math.sqrt(grid / m0) - 1)).toBeLessThan(0.02)
  })

  it('どのカスケードも帯の上限が格子の折り返し（ナイキスト）より下', () => {
    // 折り返しの列（x か y が N/2）には、h0 の対になる -k が格子に無い。そこへ波が
    // 入るとエルミート性が崩れ、高さの虚部が横の変位の枠へ漏れる（下の「虚部へ
    // 漏れない」）。web-ocean も同じ作りで、帯をナイキストより下に収めて避けている
    const { rMax2 } = latticeBands(P)
    for (let c = 0; c < P.cascades.length; c++) {
      expect(rMax2[c]!, `カスケード ${c}`).toBeLessThan((P.size / 2) ** 2)
    }
  })

  it('整数の帯の上限は整数から離れている（32 ビットに丸めても判定が変わらない）', () => {
    // 下限は 0.25 と 36 ちょうどで、どちらも 32 ビットで正確に表せる。上限が整数の
    // すぐそばにあると、32 ビットに丸めた値と比べたときに格子点の行き先が変わる
    const { rMin2, rMax2 } = latticeBands(P)
    for (const v of rMin2) expect(Math.fround(v)).toBe(v)
    // 整数の r² との大小が、32 ビットに丸めても変わらないこと。カスケード 4 の上限は
    // 1019.9932 で 1020 に近いが、その付近の 32 ビットの刻み（約 6e-5）の 100 倍離れている
    for (let c = 0; c < P.cascades.length; c++) {
      const v = rMax2[c]!
      const f = Math.fround(v)
      expect(Number.isInteger(f), `カスケード ${c} の上限 ${v} が丸めで整数になる`).toBe(false)
      expect(Math.ceil(f), `カスケード ${c} の上限 ${v}`).toBe(Math.ceil(v))
    }
  })

  it('境目ちょうどの格子点（r² = 36）は上のカスケードに入る（下限を含む）', () => {
    // 波数の帯では丸めしだいで分かれた点（段 S3）。整数の帯で、下限を含むと決めた
    for (let c = 1; c < P.cascades.length; c++) {
      expect(amplitude(6, 0, c, P), `カスケード ${c} の (6, 0)`).toBeGreaterThan(0)
      expect(amplitude(0, -6, c, P), `カスケード ${c} の (0, -6)`).toBeGreaterThan(0)
    }
  })

  it('整数の帯は波数の帯と同じ格子点を選ぶ（境目ちょうどの点だけを除いて）', () => {
    // 境目ちょうど（2 段目以降の r² = 36）の点は、整数の帯では含み、波数の帯では
    // 浮動小数の丸めしだい。それ以外の点は 1 つも食い違わないこと
    const lattice = latticeBands(P)
    const bands = cascadeBands(P)
    let ties = 0
    for (let c = 0; c < P.cascades.length; c++) {
      const s = (2 * Math.PI) / P.cascades[c]!
      for (let ny = -P.size / 2; ny < P.size / 2; ny++) {
        for (let nx = -P.size / 2; nx < P.size / 2; nx++) {
          const r2 = nx * nx + ny * ny
          const kl = Math.hypot(nx, ny) * s
          const byLattice = r2 >= lattice.rMin2[c]! && r2 < lattice.rMax2[c]!
          const byWave = kl >= 1e-5 && kl >= bands.kMin[c]! && kl < bands.kMax[c]!
          if (byLattice === byWave) continue
          expect(c > 0 && r2 === 36, `カスケード ${c} の (${nx}, ${ny})`).toBe(true)
          ties++
        }
      }
    }
    // 境目の 4 点 × 5 カスケードのうち、丸めで分かれた分だけ数える（0 でもよい）
    expect(ties).toBeLessThanOrEqual(20)
  })

  it('カスケードの帯は隙間なく続く', () => {
    const { kMin, kMax } = cascadeBands(P)
    for (let c = 1; c < P.cascades.length; c++) expect(kMin[c]).toBe(kMax[c - 1])
    for (let c = 0; c < P.cascades.length; c++) expect(kMax[c]!).toBeGreaterThan(kMin[c]!)
  })
})

describe('乱数', () => {
  it('PCG のハッシュが BigInt で書いた独立の計算と一致する', () => {
    const M = 0xffffffffn
    const ref = (v: number): number => {
      const s = (BigInt(v) * 747796405n + 2891336453n) & M
      const w = (((s >> ((s >> 28n) + 4n)) ^ s) * 277803737n) & M
      return Number(((w >> 22n) ^ w) & M)
    }
    for (const v of [0, 1, 17, 12345, 2 ** 31, 2 ** 32 - 1, 987654321]) {
      expect(pcgHash(v), `v=${v}`).toBe(ref(v))
    }
  })

  it('同じ種なら同じ h0', () => {
    const small: OceanSpectrumParams = { ...P, size: 16, cascades: [100, 10] }
    expect(buildH0(small)).toEqual(buildH0(small))
  })
})

describe('時間発展の位相', () => {
  it('分けて掛けた余りが、素直な (n × m) mod 周期と一致する', () => {
    const T = OCEAN_LOOP_TICKS
    for (const n of [0, 1, 999, 71_999, 72_000, 136_759, 140_000]) {
      for (const m of [0, 1, 511, 512, 513, 40_000, T - 1]) {
        expect(phaseTicksMod(n, m), `n=${n} m=${m}`).toBe((n * m) % T)
      }
    }
  })

  it('位相が ω·t（周期で量子化した ω）と mod 2π で一致する', () => {
    const w0 = (2 * Math.PI) / OCEAN_LOOP_SECONDS
    for (const n of [1, 500, 136_759]) {
      for (const [ticks, alpha] of [[0, 0], [1_234, 0.25], [71_999, 0.9], [200_000, 0.5]] as const) {
        const t = (ticks + alpha) * OCEAN_TICK_SECONDS
        const direct = (n * w0 * t) % (2 * Math.PI)
        const got = evolvePhase(n, ticks, alpha)
        const d = Math.abs(((got - direct + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
        expect(d, `n=${n} ticks=${ticks}`).toBeLessThan(1e-6)
      }
    }
  })
})

describe('逆 FFT', () => {
  it('1 つの周波数だけを入れると e^{+i 2π k x / N} が出る', () => {
    const N = 16
    for (const k of [1, 3, 15]) {
      const re = new Float64Array(N)
      const im = new Float64Array(N)
      re[k] = 1
      inverseFft1d(re, im)
      for (let x = 0; x < N; x++) {
        const a = (2 * Math.PI * k * x) / N
        expect(re[x]!).toBeCloseTo(Math.cos(a), 12)
        expect(im[x]!).toBeCloseTo(Math.sin(a), 12)
      }
    }
  })

  it('素直に書いた逆 DFT と一致する', () => {
    const N = 32
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      re[i] = Math.sin(i * 1.7) + 0.3
      im[i] = Math.cos(i * 0.9)
    }
    const wantRe: number[] = []
    const wantIm: number[] = []
    for (let x = 0; x < N; x++) {
      let r = 0
      let s = 0
      for (let k = 0; k < N; k++) {
        const a = (2 * Math.PI * k * x) / N
        r += re[k]! * Math.cos(a) - im[k]! * Math.sin(a)
        s += re[k]! * Math.sin(a) + im[k]! * Math.cos(a)
      }
      wantRe.push(r)
      wantIm.push(s)
    }
    inverseFft1d(re, im)
    for (let x = 0; x < N; x++) {
      expect(re[x]!).toBeCloseTo(wantRe[x]!, 10)
      expect(im[x]!).toBeCloseTo(wantIm[x]!, 10)
    }
  })
})

describe('海面の場', () => {
  // 小さな格子で全段を通す（256² の 6 カスケードは node-path の突き合わせで使う）。
  // 帯の上限がナイキストより下になる組を選ぶ（上の「折り返しより下」の条件）。
  // 32 × 32 では次のカスケードが 0.375 倍より長くなければならない
  const small: OceanSpectrumParams = { ...P, size: 32, cascades: [200, 100] }
  const h0 = buildH0(small)
  const n = buildFrequencyIndex(small)

  it('2 本ずつ詰めた実数の場が、逆 FFT の後で虚部へ漏れない（h0 のエルミート性）', () => {
    // 横の変位を 0 にすると、Dx・Dz・jxz の枠には何も入らないはず。h0 の
    // 共役の組み方を間違えると、高さの虚部がそこへ漏れる
    const flat = oceanFields(h0, n, 1234, 0.5, { ...small, choppy: 0 })
    let leak = 0
    let height = 0
    for (let i = 0; i < flat.displacement.length; i += 4) {
      leak = Math.max(leak, Math.abs(flat.displacement[i]!), Math.abs(flat.displacement[i + 2]!), Math.abs(flat.displacement[i + 3]!))
      height = Math.max(height, Math.abs(flat.displacement[i + 1]!))
    }
    expect(height).toBeGreaterThan(0)
    expect(leak / height).toBeLessThan(1e-12)
  })

  it('周期だけ進めると同じ海面に戻る', () => {
    const a = oceanFields(h0, n, 500, 0.25, small)
    const b = oceanFields(h0, n, 500 + OCEAN_LOOP_TICKS, 0.25, small)
    let worst = 0
    let max = 0
    for (let i = 0; i < a.displacement.length; i++) {
      worst = Math.max(worst, Math.abs(a.displacement[i]! - b.displacement[i]!))
      max = Math.max(max, Math.abs(a.displacement[i]!))
    }
    expect(worst / max).toBeLessThan(1e-12)
  })

  it('高さの傾きが、高さの差分と合う', () => {
    // 1 つのカスケードだけで、格子の間の中心差分と sx を比べる。符号と大きさの取り
    // 違え（i·k の向き）を捕まえる。格子の刻み（7.8 m）に近い短い波は差分では微分
    // できないので、shortCut 20 m で抑える（波長 31 m で e^-16）
    const one: OceanSpectrumParams = { ...P, size: 64, cascades: [500], choppy: 0, shortCut: 20 }
    const f = oceanFields(buildH0(one), buildFrequencyIndex(one), 0, 0, one)
    const N = one.size
    const dx = one.cascades[0]! / N
    let dot = 0
    let norm1 = 0
    let norm2 = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const h = (xx: number) => f.displacement[((y * N + ((xx + N) % N)) * 4) + 1]!
        const numeric = (h(x + 1) - h(x - 1)) / (2 * dx)
        const sx = f.derivatives[(y * N + x) * 4]!
        dot += numeric * sx
        norm1 += numeric * numeric
        norm2 += sx * sx
      }
    }
    // 相関が強い（向きが合っている）こと。逆向きなら -1 に近くなる
    expect(dot / Math.sqrt(norm1 * norm2)).toBeGreaterThan(0.99)
  })
})

describe('横の変位の微分', () => {
  it('jxz（∂Dx/∂z）が、横の変位 Dx の z 方向の差分と大きさまで合う', () => {
    // jxz は逆 FFT の前に縮め、後で掛け戻す（`jxzScale`）。相関では大きさの誤りが
    // 見えないので、回帰の傾きが 1 に近いことを見る。短い波は shortCut で抑える
    const one: OceanSpectrumParams = { ...P, size: 64, cascades: [500], shortCut: 20 }
    const f = oceanFields(buildH0(one), buildFrequencyIndex(one), 0, 0, one)
    const N = one.size
    const dz = one.cascades[0]! / N
    let sxy = 0
    let sxx = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const Dx = (yy: number) => f.displacement[((((yy + N) % N) * N + x) * 4)]!
        const numeric = (Dx(y + 1) - Dx(y - 1)) / (2 * dz)
        const jxz = f.displacement[(y * N + x) * 4 + 3]!
        sxy += numeric * jxz
        sxx += numeric * numeric
      }
    }
    expect(Math.abs(sxy / sxx - 1)).toBeLessThan(0.05)
  })
})

describe('自己診断の比べ方', () => {
  const N = 4
  const C = 2
  const cpu = Float64Array.from({ length: C * N * N * 4 }, (_, i) => Math.sin(i * 0.7) * (1 + Math.floor(i / (N * N * 4)) * 100))

  it('同じ場なら差は 0、x と y を入れ替えると大きく出る', () => {
    expect(oceanNormalizedError(cpu, cpu, N, C)).toBe(0)
    expect(oceanNormalizedError(cpu, cpu, N, C, true)).toBeGreaterThan(0.1)
  })

  it('差はカスケードと成分ごとの最大値で割る（細かいカスケードの誤りを埋もれさせない）', () => {
    // カスケード 1 は 101 倍大きい。カスケード 0 の要素を最大値の 1% だけずらすと 0.01 が出る
    const gpu = Float64Array.from(cpu)
    let max0 = 0
    for (let i = 0; i < N * N; i++) max0 = Math.max(max0, Math.abs(cpu[i * 4]!))
    gpu[0] = cpu[0]! + max0 * 0.01
    expect(oceanNormalizedError(gpu, cpu, N, C)).toBeCloseTo(0.01, 10)
  })

  it('周波数の番号の食い違いは、境目のものだけを許す', () => {
    const small: OceanSpectrumParams = { ...P, size: 16, cascades: [100, 10] }
    const cpuIndex = buildFrequencyIndex(small)
    expect(checkFrequencyIndex(cpuIndex, small)).toEqual({ mismatched: 0, unexplained: 0, worstBoundaryDistance: 0 })
    // 境目から遠い要素を 1 つずらすと、説明の付かない食い違いになる
    const bad = Int32Array.from(cpuIndex)
    bad[5] = bad[5]! + 3
    expect(checkFrequencyIndex(bad, small).unexplained).toBe(1)
  })
})
