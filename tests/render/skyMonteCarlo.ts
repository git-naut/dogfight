import {
  GROUND_ALBEDO,
  GROUND_RADIUS,
  MIE_G,
  TOP_RADIUS,
  medium,
  phaseMie,
  phaseRayleigh,
} from '../../src/render/sky/reference'

/**
 * 天空光の「正解」をモンテカルロ法の光線追跡で出す（段 S2a の調査）。
 *
 * 地表の 1 点から上向きに光線を飛ばし（余弦で重みを付けて向きを引く）、散乱の
 * たびに太陽への寄与（太陽までの透過率 × 位相）を足し、次の向きを位相関数どおりに
 * 引く。**近似を入れない。**地球の丸み、散乱の全次数、地面の反射（ランバート面）を
 * そのまま扱う。takram（Bruneton の次数の足し上げ）とも Hillaire（多重散乱の近似）
 * とも違う、3 つ目の独立した解き方。
 *
 * 余弦で重みを付けた向きの平均の放射輝度が、照度 / π になる
 * （E = ∫ L cosθ dω = π × E[L]）。乱数は種を固定するので結果は再現する。
 * 定数と媒質の式は `src/render/sky/reference.ts` をそのまま読む。
 *
 * 色ごとに別の光線を飛ばす（減衰と散乱の比が色で違うので、1 本の道で 3 色を
 * 運ぶと重みの分散が大きくなる）。
 */

type V3 = [number, number, number]

/** 決まった種から決まった列を出す乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])

/** 位相関数の余弦の逆累積の表（線形補間で引く） */
function inverseCdf(phase: (c: number) => number, bins = 16384): Float64Array {
  const n = 1 << 16
  const cdf = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const c = -1 + (2 * (i + 0.5)) / n
    cdf[i + 1] = cdf[i]! + phase(c) * (2 / n)
  }
  const total = cdf[n]!
  const out = new Float64Array(bins + 1)
  let j = 0
  for (let k = 0; k <= bins; k++) {
    const target = (k / bins) * total
    while (j < n && cdf[j + 1]! < target) j++
    const span = cdf[j + 1]! - cdf[j]!
    const f = span > 0 ? (target - cdf[j]!) / span : 0
    out[k] = Math.min(1, -1 + (2 * (j + f)) / n)
  }
  return out
}
const RAYLEIGH_ICDF = inverseCdf(phaseRayleigh)
const MIE_ICDF = inverseCdf((c) => phaseMie(c, MIE_G))
function sampleCos(table: Float64Array, u: number): number {
  const x = u * (table.length - 1)
  const i = Math.min(Math.floor(x), table.length - 2)
  return table[i]! + (table[i + 1]! - table[i]!) * (x - i)
}

/** 向き d を軸にして、天頂角の余弦 c と方位 phi の向きを作る */
function around(d: V3, c: number, phi: number): V3 {
  const s = Math.sqrt(Math.max(0, 1 - c * c))
  const a: V3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  let t: V3 = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]]
  const tl = len(t)
  t = [t[0] / tl, t[1] / tl, t[2] / tl]
  const b: V3 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]]
  return [
    d[0] * c + (t[0] * Math.cos(phi) + b[0] * Math.sin(phi)) * s,
    d[1] * c + (t[1] * Math.cos(phi) + b[1] * Math.sin(phi)) * s,
    d[2] * c + (t[2] * Math.cos(phi) + b[2] * Math.sin(phi)) * s,
  ]
}

/** 球と光線の交点の距離（近い方、遠い方）。交わらなければ null */
function sphere(o: V3, d: V3, r: number): [number, number] | null {
  const b = dot(o, d)
  const c = dot(o, o) - r * r
  const disc = b * b - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  return [-b - s, -b + s]
}

/** 光線の行き止まり（地面か上端）までの距離と、地面に当たるか */
function segment(o: V3, d: V3): { t: number; ground: boolean } {
  const g = sphere(o, d, GROUND_RADIUS - 1e-6)
  if (g !== null && g[0] > 1e-6) return { t: g[0], ground: true }
  const top = sphere(o, d, TOP_RADIUS)!
  return { t: Math.max(top[1], 0), ground: false }
}

/** 刻み幅を高さに合わせて変える（地表付近の 1.2 km の尺度を拾うため） */
const stepAt = (h: number) => Math.min(4, Math.max(0.05, 0.15 * (h + 0.3)))

/** 区間の光学的深さの累積の表（距離と累積） */
function opticalTable(o: V3, d: V3, tMax: number, channel: number): { t: number[]; tau: number[] } {
  const ts = [0]
  const taus = [0]
  let t = 0
  let tau = 0
  while (t < tMax) {
    const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
    const dt = Math.min(stepAt(len(p) - GROUND_RADIUS), tMax - t)
    const q: V3 = [o[0] + d[0] * (t + dt / 2), o[1] + d[1] * (t + dt / 2), o[2] + d[2] * (t + dt / 2)]
    tau += medium(len(q) - GROUND_RADIUS).extinction[channel]! * dt
    t += dt
    ts.push(t)
    taus.push(tau)
  }
  return { t: ts, tau: taus }
}

/** 太陽までの透過率。地面に遮られれば 0 */
function transmittanceToSun(p: V3, sun: V3, channel: number): number {
  const g = sphere(p, sun, GROUND_RADIUS - 1e-6)
  if (g !== null && g[0] > 1e-6) return 0
  const tMax = sphere(p, sun, TOP_RADIUS)![1]
  const table = opticalTable(p, sun, tMax, channel)
  return Math.exp(-table.tau[table.tau.length - 1]!)
}

export interface MonteCarloResult {
  /** 照度 / π（太陽の照度 1 あたり） */
  value: number
  /** その標準誤差 */
  error: number
}

/**
 * 地表の上向きの面が受ける天空の照度 / π を 1 色ぶん出す。
 *
 * @param maxOrder 足す散乱の次数の上限（1 なら 1 回散乱だけ、地面の反射も入れない）
 */
export function monteCarloSky(
  sunMu: number,
  channel: number,
  paths: number,
  seed: number,
  maxOrder = 64,
): MonteCarloResult {
  const random = rng(seed)
  const sun: V3 = [Math.sqrt(1 - sunMu * sunMu), sunMu, 0]
  let sum = 0
  let sumSq = 0
  for (let n = 0; n < paths; n++) {
    // 余弦で重みを付けた上向きの向き
    const u1 = random()
    const u2 = random()
    let d: V3 = around([0, 1, 0], Math.sqrt(u1), 2 * Math.PI * u2)
    let o: V3 = [0, GROUND_RADIUS, 0]
    let beta = 1
    let contribution = 0
    let order = 0
    let first = true
    for (;;) {
      const seg = segment(o, d)
      const table = opticalTable(o, d, seg.t, channel)
      const tauTotal = table.tau[table.tau.length - 1]!
      const pass = Math.exp(-tauTotal)
      let interact: boolean
      if (first) {
        // 最初の区間は必ず散乱させ、重みに散乱する確率を掛ける（素通りは上へ抜けて寄与 0）
        beta *= 1 - pass
        interact = true
        first = false
      } else {
        interact = random() < 1 - pass
      }
      if (!interact) {
        if (!seg.ground || order >= maxOrder || maxOrder === 1) break
        // 地面: ランバート面。太陽の直達を足し、余弦で重みを付けて跳ね返す
        const p: V3 = [o[0] + d[0] * seg.t, o[1] + d[1] * seg.t, o[2] + d[2] * seg.t]
        const nrm: V3 = [p[0] / len(p), p[1] / len(p), p[2] / len(p)]
        const cosSun = dot(nrm, sun)
        if (cosSun > 0) {
          contribution += ((beta * GROUND_ALBEDO) / Math.PI) * cosSun * transmittanceToSun(p, sun, channel)
        }
        beta *= GROUND_ALBEDO
        o = [p[0] + nrm[0] * 1e-6, p[1] + nrm[1] * 1e-6, p[2] + nrm[2] * 1e-6]
        d = around(nrm, Math.sqrt(random()), 2 * Math.PI * random())
        order++
        continue
      }
      // 散乱の位置を光学的深さで引く（素通りしない条件つき）
      const target = -Math.log(1 - random() * (1 - pass))
      let i = 1
      while (i < table.tau.length - 1 && table.tau[i]! < target) i++
      const f = (target - table.tau[i - 1]!) / Math.max(table.tau[i]! - table.tau[i - 1]!, 1e-300)
      const t = table.t[i - 1]! + f * (table.t[i]! - table.t[i - 1]!)
      const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
      const m = medium(len(p) - GROUND_RADIUS)
      const sR = m.rayleighScattering[channel]!
      const sM = m.mieScattering
      const ext = m.extinction[channel]!
      beta *= (sR + sM) / ext
      order++
      // 太陽への寄与。光は -sun の向きに来て -d の向きへ出る。散乱角の余弦は sun・d
      const c = dot(sun, d)
      const phase = (sR * phaseRayleigh(c) + sM * phaseMie(c, MIE_G)) / (sR + sM)
      contribution += beta * phase * transmittanceToSun(p, sun, channel)
      if (order >= maxOrder) break
      // 次の向き（位相関数どおりに引くので重みは変えない）
      const useMie = random() < sM / (sR + sM)
      const cosNext = sampleCos(useMie ? MIE_ICDF : RAYLEIGH_ICDF, random())
      d = around(d, cosNext, 2 * Math.PI * random())
      o = p
      // 重みが小さくなったらロシアンルーレット
      if (beta < 0.05) {
        if (random() < 0.5) break
        beta *= 2
      }
    }
    sum += contribution
    sumSq += contribution * contribution
  }
  const mean = sum / paths
  const variance = Math.max(0, sumSq / paths - mean * mean)
  return { value: mean, error: Math.sqrt(variance / paths) }
}
