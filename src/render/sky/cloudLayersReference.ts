/**
 * 層の雲の CPU 参照（段 S4c）。web-ocean（MIT、a07c7fd）の `SKY_CLOUD_FUNCS` の縁と密度の関数と、
 * その下の `NOISE_WGSL` の `gnoise` の写し。three を import しない。
 *
 * 2 枚の薄い層で、低い方は 1.5 km の積雲（縁がカリフラワー状に崩れる）、高い方は 4.5 km の
 * 高層雲（滑らかで少し繊維状）。座標 q は km（視線が層と交わる点の水平の位置）。
 *
 * GPU（`cloudLayerNodes.ts`）は同じ式を持ち、自己診断が点で突き合わせる。機体の光を雲で遮る
 * 計算（`hillaireSky.ts` の光の色）もここを使う。
 */

/** 低い層（積雲）の高さ km。web-ocean の `cloudP.x`（注記は 2 km だが渡している値は 1.5） */
export const LOW_LAYER_ALTITUDE = 1.5
/** 高い層（高層雲）の高さ km（web-ocean の `cloudLayers` の `hc = 4.5`） */
export const HIGH_LAYER_ALTITUDE = 4.5
/** 低い層の光学的な厚さ（web-ocean の `cloudP.z`） */
export const LOW_LAYER_SIGMA = 2.2
/** 高い層の光学的な厚さ（web-ocean の `atmo.w`） */
export const HIGH_LAYER_SIGMA = 0.9
/** web-ocean の既定の雲量（`P.clouds`）と高層雲の量（`P.veil`） */
export const WEB_OCEAN_COVERAGE = 0.4
export const WEB_OCEAN_VEIL = 0.36

/**
 * 高層雲の量。web-ocean は積雲と別に持つ（0.36）が、この作品の `?coverage=` は 1 つなので、
 * 積雲の雲量に比例させる（web-ocean の既定 0.40 で 0.36）。快晴（0）では高層雲も消える（推測）
 */
export function veilFor(coverage: number): number {
  return Math.min(Math.max(coverage, 0), 1) * (WEB_OCEAN_VEIL / WEB_OCEAN_COVERAGE)
}

const f32 = Math.fround

/** PCG のハッシュ（`ocean/reference.ts` の `pcgHash` と同じ式） */
function pcgHash(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}

/** 格子点の勾配（`hashGrad`）。角は 32 ビットの浮動小数で求める（GPU と同じ丸め） */
function hashGrad(ix: number, iy: number): [number, number] {
  const h = pcgHash((Math.imul(ix >>> 0, 1664525) + pcgHash(((iy >>> 0) + 1013904223) >>> 0)) >>> 0)
  const a = f32(f32(h) * f32(6.28318530718 / 4294967296))
  return [Math.cos(a), Math.sin(a)]
}

/** 勾配ノイズ（`gnoise`）。おおよそ −0.7〜0.7 */
export function gnoise(px: number, py: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const fx = px - ix
  const fy = py - iy
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const dot = (gx: number, gy: number, dx: number, dy: number) => {
    const [ax, ay] = hashGrad(gx, gy)
    return ax * dx + ay * dy
  }
  const a = dot(ix, iy, fx, fy)
  const b = dot(ix + 1, iy, fx - 1, fy)
  const c = dot(ix, iy + 1, fx, fy - 1)
  const d = dot(ix + 1, iy + 1, fx - 1, fy - 1)
  const ab = a + (b - a) * ux
  const cd = c + (d - c) * ux
  return ab + (cd - ab) * uy
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * 画素の大きさで細かい段を消す fbm（`cloudFbm`）。`fp` は画素の大きさ（ノイズの単位）。
 * `billow` は細かい段を |noise| の膨らみに変える量（カリフラワー状の縁）
 */
export function cloudFbm(px: number, py: number, fp: number, octaves: number, billow: number): number {
  let s = 0
  let a = 0.5
  let qx = px
  let qy = py
  let f = 1
  for (let i = 0; i < octaves; i++) {
    const w = 1 - smoothstep(0.08, 0.28, fp * f)
    let n = gnoise(qx, qy)
    if (i >= 2) n = n + (Math.abs(n) * 2 - 0.38 - n) * billow
    s += a * n * w
    // CLOUD_ROT = mat2x2f(0.8, 0.6, −0.6, 0.8)（列で並ぶ）。× 2.03 と平行移動
    const rx = 0.8 * qx - 0.6 * qy
    const ry = 0.6 * qx + 0.8 * qy
    qx = rx * 2.03 + 13.1
    qy = ry * 2.03 + 7.7
    f *= 2.03
    a *= 0.5
  }
  return s
}

/** 低い層の縁（正の所が雲、`lowEdge`）。t は風の時刻 s */
export function lowEdge(qx: number, qy: number, fp: number, octaves: number, coverage: number, t: number): number {
  let px = qx * 0.38 + t * 0.004
  let py = qy * 0.38 + t * 0.0012
  const wx = gnoise(px * 0.3 + 1.7, py * 0.3 + 9.2)
  const wy = gnoise(px * 0.3 + 8.3, py * 0.3 + 2.8)
  px += wx * 1.4
  py += wy * 1.4
  // 少し伸びた細胞（雲の筋）と、少しだけ膨らむ細かい段
  const base = cloudFbm(px, py * 1.7, fp * 0.65, octaves, 0.35) * 1.3 + 0.5
  const large = gnoise(qx * 0.05 + 3.1, qy * 0.05 + 1.3) * 0.7
  return base + large - (1 - coverage)
}

export function lowSoft(fp: number): number {
  return 0.38 + Math.min(fp * 0.65, 1) * 0.3
}

export function lowDensity(qx: number, qy: number, fp: number, octaves: number, coverage: number, t: number): number {
  return Math.min(Math.max(lowEdge(qx, qy, fp, octaves, coverage, t) / lowSoft(fp), 0), 1)
}

/** 高い層の縁（`highEdge`）。滑らかで少し繊維状 */
export function highEdge(qx: number, qy: number, fp: number, octaves: number, veil: number, t: number): number {
  const sx = qx * 0.09
  const sy = qy * 0.2
  const px = 0.8 * sx - 0.6 * sy + t * 0.0015
  const py = 0.6 * sx + 0.8 * sy
  const n = cloudFbm(px, py, fp * 0.2, octaves, 0) * 1.25 + 0.5
  const big = gnoise(qx * 0.012 + 7, qy * 0.012 + 3) * 0.6
  return n + big - (1 - veil)
}

export function highSoft(fp: number): number {
  return 0.85 + Math.min(fp * 0.2, 1) * 0.3
}

export function highDensity(qx: number, qy: number, fp: number, octaves: number, veil: number, t: number): number {
  return Math.min(Math.max(highEdge(qx, qy, fp, octaves, veil, t) / highSoft(fp), 0), 1)
}

/**
 * ワールドの点 (x, y, z) m から太陽へ向かう線が 2 枚の層を横切るときの透過率（段 S4c の雲の影）。
 * 層は平らとみなす（数 km の範囲では地球の丸みは効かない）。太陽が層より下（sun.y ≤ 0）なら 1。
 * 密度は画素の大きさ 0 で引く（影は大きく、細かい段は効かない。段の数は呼ぶ側が決める）
 */
export function layerSunTransmittance(
  x: number,
  y: number,
  z: number,
  sun: { x: number; y: number; z: number },
  coverage: number,
  t: number,
  octaves: number,
): number {
  if (sun.y <= 0.01) return 1
  const h = Math.max(y, 0) / 1000
  let tau = 0
  for (const [hc, sigma, high] of [
    [LOW_LAYER_ALTITUDE, LOW_LAYER_SIGMA, false],
    [HIGH_LAYER_ALTITUDE, HIGH_LAYER_SIGMA, true],
  ] as const) {
    if (h >= hc) continue
    const s = (hc - h) / sun.y
    const qx = x / 1000 + sun.x * s
    const qy = z / 1000 + sun.z * s
    const d = high ? highDensity(qx, qy, 0, octaves, veilFor(coverage), t) : lowDensity(qx, qy, 0, octaves, coverage, t)
    tau += (d * sigma) / sun.y
  }
  return Math.exp(-tau)
}

/**
 * 雲の流れる時刻。
 *
 * 実時間ではなく sim のフレーム番号から導く。これで同じフレームからは
 * 常に同じ雲が出る。キャプチャモードの決定論はここに依存している。
 * 段 S4b で体積の雲（`clouds/geometry.ts`）から移した
 */
export function cloudTime(frame: number, fixedDt: number): number {
  return frame * fixedDt
}
