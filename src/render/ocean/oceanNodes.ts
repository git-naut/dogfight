import {
  Fn,
  If,
  atan,
  clamp,
  cosh,
  exp,
  float,
  floor,
  fract,
  int,
  instancedArray,
  invocationLocalIndex,
  instanceIndex,
  length,
  log,
  max,
  pow,
  select,
  sqrt,
  tanh,
  uint,
  uniform,
  uniformArray,
  vec2,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl'
import type { ComputeNode, Node, Renderer } from 'three/webgpu'
import {
  GRAVITY,
  OCEAN_LOOP_SECONDS,
  OCEAN_LOOP_TICKS,
  PHASE_SPLIT,
  SURFACE_TENSION,
  jxzScale,
  latticeBands,
  swellAlpha,
  swellPeak,
  windSeaShape,
  type OceanSpectrumParams,
} from './reference'

/**
 * FFT の海を TSL のコンピュートで解く（段 S3）。
 *
 * web-ocean（MIT、a07c7fd）の `SIM_INIT`・`SIM_EVOLVE`・`FFT_ROWS`・`FFT_COLS` の写し。
 * 式は CPU 参照（`reference.ts`）と 1 対 1 に写し、node-path が各成分の最大値に対する差
 * 1e-4 で突き合わせる（ユーザーの決定）。**時間発展の位相だけ web-ocean から変えた**
 * （周波数の番号を整数で持ち、刻みとの積の余りを整数で求める。`reference.ts` の注記）。
 *
 * 記憶域の並びは CPU 参照と同じで、要素の番号は `(c × N + y) × N + x`。
 * 段 S3 では場面に繋がない。出力は 32 ビットの記憶域のまま持ち、読み戻して比べる。
 * 海面の描画（段 S4a）でテクスチャへ写すかを決める。
 *
 * **WebGPU が要る。**共有メモリ（`workgroupArray`）と同期（`workgroupBarrier`）は、three の
 * WebGL2 の組み立てに無い（段 S3 で three の本文を読んで確かめた）。
 */

type N<T extends string> = Node<T>

/** カスケードの数の上限（uniform の配列の長さ） */
const MAX_CASCADES = 8
/** 要素ごとのコンピュートの組の大きさ */
const ELEMENT_WORKGROUP = 64

export interface OceanSimulation {
  readonly size: number
  readonly cascades: number
  /** 要素ごとに (Re h0(k), Im h0(k), Re conj h0(-k), Im conj h0(-k)) */
  readonly h0: N<'vec4'> & { value: unknown }
  /** 量子化した周波数の番号 n（`frequencyIndex`） */
  readonly frequencyIndex: N<'uint'> & { value: unknown }
  /** 時間発展のあとのスペクトル（`evolve` の specA・specB） */
  readonly specA: N<'vec4'> & { value: unknown }
  readonly specB: N<'vec4'> & { value: unknown }
  /** (Dx, Dy, Dz, jxz) */
  readonly displacement: N<'vec4'> & { value: unknown }
  /** (sx, sz, jxx, jzz) */
  readonly derivatives: N<'vec4'> & { value: unknown }
  /** 初期値 h0 と周波数の番号を作る。スペクトルの条件が変わったときだけ呼ぶ */
  init(renderer: Renderer): void
  /** 時刻 t = (ticks + alpha) × 1/120 秒の海面を作る（時間発展 → 行の逆 FFT → 列の逆 FFT） */
  update(renderer: Renderer, ticks: number, alpha: number): void
  dispose(): void
}

export function createOceanSimulation(p: OceanSpectrumParams): OceanSimulation {
  const size = p.size
  const C = p.cascades.length
  if (C > MAX_CASCADES) throw new Error(`カスケードは ${MAX_CASCADES} まで（${C}）`)
  const logN = Math.round(Math.log2(size))
  if (1 << logN !== size) throw new Error(`格子の一辺は 2 のべき（${size}）`)
  const count = C * size * size

  const h0 = instancedArray(count, 'vec4')
  const frequencyIndex = instancedArray(count, 'uint')
  const specA = instancedArray(count, 'vec4')
  const specB = instancedArray(count, 'vec4')
  const tmpA = instancedArray(count, 'vec4')
  const tmpB = instancedArray(count, 'vec4')
  const displacement = instancedArray(count, 'vec4')
  const derivatives = instancedArray(count, 'vec4')

  // カスケードごとの値。CPU 参照と同じく倍精度で求めて渡す
  const bands = latticeBands(p)
  const pad = (a: number[]) => [...a, ...new Array(MAX_CASCADES - a.length).fill(0)]
  const cascL = uniformArray(pad([...p.cascades]), 'float')
  // 帯は格子の整数の半径の 2 乗で判定する（`latticeBands` の注記）
  const rMin2 = uniformArray(pad(bands.rMin2), 'float')
  const rMax2 = uniformArray(pad(bands.rMax2), 'float')
  // 逆 FFT の前に jxz を縮める係数（`jxzScale` の注記）
  const kappa = uniformArray(pad(jxzScale(p)), 'float')
  const wind = windSeaShape(p)
  /** uniform の配列の要素。`@types/three` は要素の型を float と見なさないので、逃げ口を 1 か所に */
  const at = (arr: unknown, c: N<'uint'>) =>
    (arr as { element(i: unknown): unknown }).element(c) as unknown as N<'float'>

  // 時刻。刻みの余り m を CPU で上下に分けて渡す（`phaseTicksMod`）
  const ticksHigh = uniform(0, 'uint')
  const ticksLow = uniform(0, 'uint')
  const alphaU = uniform(0)

  const N = size
  const T = OCEAN_LOOP_TICKS
  const PI = Math.PI

  /** 要素の番号から (c, y, x) */
  const split = (idx: N<'uint'>) => {
    const c = idx.div(N * N)
    const rem = idx.mod(N * N)
    return { c, y: rem.div(N), x: rem.mod(N) }
  }

  /** 格子の番号を、負の周波数を含む整数の組へ（`latticeIndex`）。浮動小数で持つが値は整数 */
  const latticeIndex = (x: N<'uint'>, y: N<'uint'>): N<'vec2'> =>
    vec2(
      select(x.greaterThanEqual(N / 2), float(x).sub(N), float(x)),
      select(y.greaterThanEqual(N / 2), float(y).sub(N), float(y)),
    ) as unknown as N<'vec2'>

  /** 格子の (x, y) の波数（`waveVec`） */
  const waveVec = (x: N<'uint'>, y: N<'uint'>, c: N<'uint'>): N<'vec2'> =>
    latticeIndex(x, y).mul(float(2 * PI).div(at(cascL, c))) as unknown as N<'vec2'>

  const omegaOf = (k: N<'float'>) => sqrt(k.mul(GRAVITY).add(k.mul(k).mul(k).mul(SURFACE_TENSION))) as unknown as N<'float'>
  const dOmegaOf = (k: N<'float'>) =>
    float(GRAVITY).add(k.mul(k).mul(3 * SURFACE_TENSION)).div(omegaOf(k).mul(2)) as unknown as N<'float'>

  const jonswap = (w: N<'float'>, wp: number, alpha: number, gamma: number): N<'float'> => {
    const sigma = select(w.lessThanEqual(wp), float(0.07), float(0.09))
    const d = w.sub(wp).div(sigma.mul(wp))
    const r = exp(d.mul(d).mul(-0.5))
    const q = float(wp).div(w)
    const q2 = q.mul(q)
    const w5 = w.mul(w).mul(w).mul(w).mul(w)
    return float(alpha * GRAVITY * GRAVITY)
      .div(w5)
      .mul(exp(q2.mul(q2).mul(-1.25)))
      .mul(pow(float(gamma), r)) as unknown as N<'float'>
  }

  const donelanBanner = (theta: N<'float'>, w: N<'float'>, wp: number): N<'float'> =>
    Fn(() => {
      const ratio = w.div(wp).toVar()
      const beta = float(0).toVar()
      If(ratio.lessThan(0.95), () => {
        beta.assign(pow(ratio, 1.3).mul(2.61))
      })
        .ElseIf(ratio.lessThan(1.6), () => {
          beta.assign(pow(ratio, -1.3).mul(2.28))
        })
        .Else(() => {
          const eps = exp(log(ratio.mul(ratio)).mul(-0.567)).mul(0.8393).sub(0.4)
          beta.assign(pow(float(10), eps))
        })
      const sh = float(1).div(cosh(clamp(beta.mul(theta), -20, 20)))
      return beta.div(tanh(beta.mul(PI)).mul(2)).mul(sh).mul(sh)
    })() as unknown as N<'float'>

  /** k と方向 dir のなす角の余弦（代数で、三角関数を使わない） */
  const directionCos = (k: N<'vec2'>, dir: number) =>
    k.x.mul(Math.cos(dir)).add(k.y.mul(Math.sin(dir))).div(length(k)) as unknown as N<'float'>
  const cosSpread = (cosDelta: N<'float'>, s: number): N<'float'> => {
    // |cos(δ/2)| = √((1 + cos δ)/2)。WGSL の cos は絶対誤差 2^-11 まで許され、2s 乗で拡大する
    const base = sqrt(max(cosDelta.add(1).mul(0.5), 0)).toVar()
    const e = 2 * s
    let powered: N<'float'>
    if (Number.isInteger(e) && e > 0) {
      // 整数の指数は 2 乗を重ねて掛ける（pow の log と exp を通さない）
      let acc: N<'float'> | null = null
      let sq: N<'float'> = base as unknown as N<'float'>
      let k = e
      while (k > 0) {
        if (k & 1) acc = (acc === null ? sq : acc.mul(sq)) as unknown as N<'float'>
        k >>= 1
        if (k > 0) sq = sq.mul(sq).toVar() as unknown as N<'float'>
      }
      powered = acc!
    } else {
      powered = pow(base, e) as unknown as N<'float'>
    }
    return powered.mul(Math.sqrt(s + 0.25) / (2 * Math.sqrt(PI))) as unknown as N<'float'>
  }

  /**
   * 波の向きと方向 dir の差（`directionDelta`）。ゼロの符号に頼らないよう、外積と内積の
   * atan2 で直接求める（`reference.ts` の注記。SwiftShader が軸の上で角度を π 取り違えた）
   */
  const directionDelta = (k: N<'vec2'>, dir: number) => {
    const c = Math.cos(dir)
    const s = Math.sin(dir)
    return atan(k.y.mul(c).sub(k.x.mul(s)), k.x.mul(c).add(k.y.mul(s))) as unknown as N<'float'>
  }

  const spectrum = (k: N<'vec2'>): N<'float'> =>
    Fn(() => {
      const kl = length(k).toVar()
      const w = omegaOf(kl).toVar()
      const Sw = float(0).toVar()
      if (p.windSpeed > 0.1) {
        Sw.assign(jonswap(w, wind.wp, wind.alpha, p.gamma).mul(donelanBanner(directionDelta(k, p.windDirection), w, wind.wp)))
      }
      if (p.swellHeight > 0.001) {
        Sw.addAssign(
          jonswap(w, swellPeak(p), swellAlpha(p), 6).mul(cosSpread(directionCos(k, p.swellDirection), p.swellSpread)),
        )
      }
      Sw.mulAssign(exp(kl.mul(kl).mul(-p.shortCut * p.shortCut)))
      return Sw.mul(dOmegaOf(kl)).div(kl).mul(p.gain)
    })() as unknown as N<'float'>

  /** 整数の組 n の波の振幅（`amplitude`）。r² は整数で、32 ビットでも正確 */
  const amplitude = (n: N<'vec2'>, c: N<'uint'>): N<'float'> =>
    Fn(() => {
      const r2 = n.x.mul(n.x).add(n.y.mul(n.y)).toVar()
      const out = float(0).toVar()
      If(r2.greaterThanEqual(at(rMin2, c)).and(r2.lessThan(at(rMax2, c))), () => {
        const s = float(2 * PI).div(at(cascL, c)).toVar()
        const g = select(c.greaterThanEqual(4), select(c.equal(5), float(0.6), float(0.85)), float(1))
        out.assign(sqrt(max(spectrum(n.mul(s) as unknown as N<'vec2'>), 0)).mul(s).mul(0.5).mul(g))
      })
      return out
    })() as unknown as N<'float'>

  /**
   * sin(2πt) と cos(2πt)。t は 1 周の割合。**組み込みの sin・cos を使わない。**WGSL は絶対誤差
   * 2^-11 まで許し、SwiftShader では乱数と位相で最大値の 2e-4 ずれた（段 S3、ユーザーの決定で
   * 自前にした）。4 分の 1 周ごとに折り返し、|角度| ≤ π/4 で多項式を解く（打ち切りの誤差は
   * sin で 2e-9、cos で 1e-10。32 ビットの丸めが残る）
   */
  const sincos2pi = (t: N<'float'>): N<'vec2'> =>
    Fn(() => {
      const q = floor(t.mul(4).add(0.5)).toVar()
      const a = t.sub(q.mul(0.25)).mul(2 * PI).toVar()
      const a2 = a.mul(a).toVar()
      const sn = a.mul(
        float(1).add(a2.mul(float(-1 / 6).add(a2.mul(float(1 / 120).add(a2.mul(float(-1 / 5040).add(a2.mul(1 / 362880)))))))),
      ).toVar()
      const cs = float(1)
        .add(a2.mul(float(-1 / 2).add(a2.mul(float(1 / 24).add(a2.mul(float(-1 / 720).add(a2.mul(float(1 / 40320).add(a2.mul(-1 / 3628800))))))))))
        .toVar()
      const quadrant = uint(int(q).mod(4).add(4).mod(4)).toVar()
      const out = vec2(sn, cs).toVar()
      If(quadrant.equal(uint(1)), () => {
        out.assign(vec2(cs, sn.negate()))
      })
        .ElseIf(quadrant.equal(uint(2)), () => {
          out.assign(vec2(sn.negate(), cs.negate()))
        })
        .ElseIf(quadrant.equal(uint(3)), () => {
          out.assign(vec2(cs.negate(), sn))
        })
      return out
    })() as unknown as N<'vec2'>

  // ---- 乱数（`pcgHash`・`rand01`・`gauss2`）。u32 の掛け算は 2^32 で巻く ----
  const pcgHash = (v: N<'uint'>): N<'uint'> => {
    const s = v.mul(uint(747796405)).add(uint(2891336453))
    const w = s.shiftRight(s.shiftRight(uint(28)).add(uint(4))).bitXor(s).mul(uint(277803737))
    return w.shiftRight(uint(22)).bitXor(w) as unknown as N<'uint'>
  }
  const rand01 = (s: N<'uint'>) => float(pcgHash(s).shiftRight(uint(8))).add(0.5).div(16777216) as unknown as N<'float'>
  const gauss2 = (seed: N<'uint'>): N<'vec2'> => {
    const u1 = rand01(seed.mul(uint(2)).add(uint(17)))
    const u2 = rand01(seed.mul(uint(2)).add(uint(18)).add(pcgHash(seed)))
    const r = sqrt(log(u1).mul(-2))
    // cos(2πu2)・sin(2πu2) を自前で（`sincos2pi`）
    const sc = sincos2pi(u2)
    return vec2(r.mul(sc.y), r.mul(sc.x)) as unknown as N<'vec2'>
  }

  // ---- 初期値 h0 と周波数の番号（`buildH0`・`frequencyIndex`） ----
  const initNode = Fn(() => {
    const idx = uint(instanceIndex).toVar()
    const { c, y, x } = split(idx)
    const cv = c.toVar()
    const xv = x.toVar()
    const yv = y.toVar()
    const k = waveVec(xv, yv, cv).toVar()
    const mx = uint(N).sub(xv).mod(N)
    const my = uint(N).sub(yv).mod(N)
    const seed = uint(p.seed >>> 0).mul(uint(7919)).add(cv.mul(uint(1000003))).toVar()
    const ga = gauss2(seed.add(yv.mul(N).add(xv))).toVar()
    const gb = gauss2(seed.add(my.mul(N).add(mx))).toVar()
    const nk = latticeIndex(xv, yv).toVar()
    const aa = amplitude(nk, cv).toVar()
    const ab = amplitude(nk.negate() as unknown as N<'vec2'>, cv).toVar()
    h0.element(idx).assign(vec4(ga.x.mul(aa), ga.y.mul(aa), gb.x.mul(ab), gb.y.mul(ab).negate()))
    const kl = length(k)
    const n = select(kl.lessThan(1e-5), uint(0), uint(floor(omegaOf(kl).div((2 * PI) / OCEAN_LOOP_SECONDS))))
    frequencyIndex.element(idx).assign(n)
  })().compute(count, [ELEMENT_WORKGROUP]) as unknown as ComputeNode

  // ---- 時間発展（`evolve`） ----
  const evolveNode = Fn(() => {
    const idx = uint(instanceIndex).toVar()
    const { c, y, x } = split(idx)
    const k = waveVec(x, y, c).toVar()
    const kl = length(k).toVar()
    If(kl.lessThan(1e-5), () => {
      specA.element(idx).assign(vec4(0, 0, 0, 0))
      specB.element(idx).assign(vec4(0, 0, 0, 0))
    }).Else(() => {
      // 位相。(n × m) mod T を 32 ビットの整数で（`phaseTicksMod`）
      const n = frequencyIndex.element(idx).toVar()
      const a = n.mod(uint(T)).toVar()
      const whole = a
        .mul(ticksHigh)
        .mod(uint(T))
        .mul(uint(PHASE_SPLIT))
        .add(a.mul(ticksLow))
        .mod(uint(T))
      // 位相を 1 周の割合で持ち、自前の sin・cos へ（`sincos2pi`）
      const turns = fract(float(whole).add(float(n).mul(alphaU)).div(T))
      const sc = sincos2pi(turns as unknown as N<'float'>).toVar()
      const ec = sc.y
      const es = sc.x
      const H = h0.element(idx).toVar()
      // h = h0(k)·e^{-iωt} + conj(h0(-k))·e^{iωt}
      const hr = H.x.mul(ec).add(H.y.mul(es)).add(H.z.mul(ec).sub(H.w.mul(es))).toVar()
      const hi = H.x.mul(es).negate().add(H.y.mul(ec)).add(H.z.mul(es).add(H.w.mul(ec))).toVar()
      const ihr = hi.negate()
      const ihi = hr
      const lam = p.choppy
      const ik = float(1).div(kl).toVar()
      const kx = k.x
      const kz = k.y
      const Dxr = ihr.mul(kx).mul(ik).mul(lam)
      const Dxi = ihi.mul(kx).mul(ik).mul(lam)
      const Dzr = ihr.mul(kz).mul(ik).mul(lam)
      const Dzi = ihi.mul(kz).mul(ik).mul(lam)
      const cxz = kx.mul(kz).mul(ik).mul(-lam)
      const cxx = kx.mul(kx).mul(ik).mul(-lam)
      const czz = kz.mul(kz).mul(ik).mul(-lam)
      const cxzS = cxz.div(at(kappa, c))
      specA.element(idx).assign(vec4(Dxr.sub(Dzi), Dxi.add(Dzr), hr.sub(hi.mul(cxzS)), hi.add(hr.mul(cxzS))))
      specB.element(idx).assign(
        vec4(
          ihr.mul(kx).sub(ihi.mul(kz)),
          ihi.mul(kx).add(ihr.mul(kz)),
          hr.mul(cxx).sub(hi.mul(czz)),
          hi.mul(cxx).add(hr.mul(czz)),
        ),
      )
    })
  })().compute(count, [ELEMENT_WORKGROUP]) as unknown as ComputeNode

  // ---- 逆 FFT（`inverseFft2d`）。1 本を 1 つの組（N/2 本の呼び出し）で解く ----
  // 回転因子 e^{2πi j/N}（j < N/2）。CPU で倍精度で求めて 32 ビットへ。WGSL の cos・sin は
  // 絶対誤差 2^-11 まで許され、傾きの逆 FFT が最大値の 5.9e-4 ずれた（表にして 3.0e-7）
  const twiddleTable = instancedArray(
    new Float32Array(Array.from({ length: N / 2 }, (_, j) => [Math.cos((2 * PI * j) / N), Math.sin((2 * PI * j) / N)]).flat()),
    'vec2',
  )
  const bitrev = (i: N<'uint'>): N<'uint'> => {
    let r: N<'uint'> = uint(0) as unknown as N<'uint'>
    for (let b = 0; b < logN; b++) {
      r = r.bitOr(i.shiftRight(uint(b)).bitAnd(uint(1)).shiftLeft(uint(logN - 1 - b))) as unknown as N<'uint'>
    }
    return r
  }

  /**
   * 共有メモリの配列。`element` は実行時にある（three の `BitonicSort.js` が使う）が
   * `@types/three` の `WorkgroupInfoNode` に無いので、型の逃げ口を 1 か所にまとめる
   */
  interface SharedArray {
    element(i: N<'uint'>): N<'vec4'>
  }
  const shared = () => workgroupArray('vec4', N) as unknown as SharedArray

  /** 共有メモリの上の radix-2 の逆 FFT（入力は並べ替え済み）。段の数は JS で展開する */
  const butterflies = (wa: SharedArray, wb: SharedArray, t: N<'uint'>) => {
    const cmul = (a: N<'vec2'>, w: N<'vec2'>) =>
      vec2(a.x.mul(w.x).sub(a.y.mul(w.y)), a.x.mul(w.y).add(a.y.mul(w.x))) as unknown as N<'vec2'>
    for (let s = 0; s < logN; s++) {
      const half = 1 << s
      const pos = t.bitAnd(uint(half - 1)).toVar()
      const i0 = t.shiftRight(uint(s)).shiftLeft(uint(s + 1)).add(pos).toVar()
      const i1 = i0.add(uint(half)).toVar()
      // π·pos/half = 2π·(pos·N/(2·half))/N
      const w = twiddleTable.element(pos.mul(uint(N / (2 * half)))).toVar()
      const a0 = wa.element(i0).toVar()
      const a1 = wa.element(i1).toVar()
      const b0 = wb.element(i0).toVar()
      const b1 = wb.element(i1).toVar()
      const ta = vec4(cmul(a1.xy as never, w as never), cmul(a1.zw as never, w as never)).toVar()
      const tb = vec4(cmul(b1.xy as never, w as never), cmul(b1.zw as never, w as never)).toVar()
      wa.element(i0).assign(a0.add(ta))
      wa.element(i1).assign(a0.sub(ta))
      wb.element(i0).assign(b0.add(tb))
      wb.element(i1).assign(b0.sub(tb))
      workgroupBarrier()
    }
  }

  const half = N / 2
  /** 行（x 方向）。組 1 つが 1 行。組の番号 = c × N + y */
  const rowsNode = Fn(() => {
    const wa = shared()
    const wb = shared()
    const t = uint(invocationLocalIndex).toVar()
    const base = uint(workgroupId.x).mul(N).toVar()
    const e0 = t
    const e1 = t.add(half).toVar()
    wa.element(bitrev(e0)).assign(specA.element(base.add(e0)))
    wa.element(bitrev(e1)).assign(specA.element(base.add(e1)))
    wb.element(bitrev(e0)).assign(specB.element(base.add(e0)))
    wb.element(bitrev(e1)).assign(specB.element(base.add(e1)))
    workgroupBarrier()
    butterflies(wa, wb, t)
    tmpA.element(base.add(e0)).assign(wa.element(e0))
    tmpA.element(base.add(e1)).assign(wa.element(e1))
    tmpB.element(base.add(e0)).assign(wb.element(e0))
    tmpB.element(base.add(e1)).assign(wb.element(e1))
  })().compute(C * N * half, [half]) as unknown as ComputeNode

  /** 列（y 方向）と組み立て（`emit`）。組の番号 = c × N + x */
  const colsNode = Fn(() => {
    const wa = shared()
    const wb = shared()
    const t = uint(invocationLocalIndex).toVar()
    const wg = uint(workgroupId.x).toVar()
    const c = wg.div(N).toVar()
    const x = wg.mod(N).toVar()
    const e0 = t
    const e1 = t.add(half).toVar()
    const i0 = c.mul(N).add(e0).mul(N).add(x).toVar()
    const i1 = c.mul(N).add(e1).mul(N).add(x).toVar()
    wa.element(bitrev(e0)).assign(tmpA.element(i0))
    wa.element(bitrev(e1)).assign(tmpA.element(i1))
    wb.element(bitrev(e0)).assign(tmpB.element(i0))
    wb.element(bitrev(e1)).assign(tmpB.element(i1))
    workgroupBarrier()
    butterflies(wa, wb, t)
    // a = (Dx, Dz, Dy, jxz) → (Dx, Dy, Dz, jxz)
    const a0 = wa.element(e0).toVar()
    const a1 = wa.element(e1).toVar()
    const kc = at(kappa, c)
    displacement.element(i0).assign(vec4(a0.x, a0.z, a0.y, a0.w.mul(kc)))
    displacement.element(i1).assign(vec4(a1.x, a1.z, a1.y, a1.w.mul(kc)))
    derivatives.element(i0).assign(wb.element(e0))
    derivatives.element(i1).assign(wb.element(e1))
  })().compute(C * N * half, [half]) as unknown as ComputeNode

  // GPU のパスごとの所要で見分ける名前（`passTimes.ts` の群「海」）
  for (const [node, name] of [
    [initNode, 'Ocean [ Init ]'],
    [evolveNode, 'Ocean [ Evolve ]'],
    [rowsNode, 'Ocean [ FFT Rows ]'],
    [colsNode, 'Ocean [ FFT Cols ]'],
  ] as const) {
    ;(node as unknown as { name: string }).name = name
  }

  const api: OceanSimulation = {
    size,
    cascades: C,
    h0: h0 as never,
    frequencyIndex: frequencyIndex as never,
    specA: specA as never,
    specB: specB as never,
    displacement: displacement as never,
    derivatives: derivatives as never,
    init(renderer: Renderer) {
      renderer.compute(initNode)
    },
    update(renderer: Renderer, ticks: number, alpha: number) {
      const m = ((ticks % T) + T) % T
      ticksHigh.value = Math.floor(m / PHASE_SPLIT)
      ticksLow.value = m % PHASE_SPLIT
      alphaU.value = alpha
      renderer.compute(evolveNode)
      renderer.compute(rowsNode)
      renderer.compute(colsNode)
    },
    dispose() {
      for (const node of [initNode, evolveNode, rowsNode, colsNode]) {
        ;(node as unknown as { dispose?: () => void }).dispose?.()
      }
    },
  }
  return api
}
