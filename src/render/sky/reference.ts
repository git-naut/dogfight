/**
 * Hillaire の大気の CPU 参照（段 S2a）。
 *
 * web-ocean（Noniv/web-ocean、MIT、a07c7fd）の `ATMO_CORE_WGSL` と `TRANS_LUT` の写し。
 * TSL 版（`skyNodes.ts`）の突き合わせの相手で、GPU の読み戻しと相対 1e-3 で比べる。
 * **GPU と同じ刻み方で積分する。**解析解に近づけるために刻みを増やすと、
 * GPU との比較が「どちらが正しいか」ではなく「刻みの違い」を測ってしまう。
 * 解析解との差は別の検査で、許容を広げて見る。
 *
 * 長さの単位は km（web-ocean と同じ）。係数は 1/km。
 * three にも DOM にも依存しない。
 *
 * **定数は takram（Bruneton の既定）にそろえる。**web-ocean は Hillaire 2020 の
 * 値（上端 6,460 km、ミーの非対称 0.84、地面 0.06、ミーの減衰 4.40e-3）を使うが、
 * 今の絵との連続を取った（段 S2a、2026-10-26）。天空光での差は 2〜3%。
 * 散乱の式（積分の刻み・LUT の写し方・多重散乱の近似）は web-ocean のまま。
 *
 * 光の尺度は takram の輝度の換算を使う（`SUN_ILLUMINANCE`・`SKY_ILLUMINANCE`）。
 * 直達光は takram と 0.3% 以内で一致し、天空光は厳密な多重散乱
 * （`tests/render/skyTruth.test.ts`）と 3% 以内で一致する。今の takram の天空光は
 * 厳密な値より 1.3〜1.6 倍明るく、物理の値を採る（ユーザーの決定）。
 */

export type Rgb = readonly [number, number, number]

/** 地表の半径 km */
export const GROUND_RADIUS = 6360
/** 大気の上端の半径 km（takram の 6,420 km。web-ocean は 6,460 km） */
export const TOP_RADIUS = 6420
/** レイリーの散乱係数 1/km（赤・緑・青） */
export const RAYLEIGH_SCATTERING: Rgb = [5.802e-3, 13.558e-3, 33.1e-3]
/** ミーの散乱係数と減衰係数 1/km */
export const MIE_SCATTERING = 3.996e-3
export const MIE_EXTINCTION = 4.44e-3
/** オゾンの吸収係数 1/km */
export const OZONE_ABSORPTION: Rgb = [0.65e-3, 1.881e-3, 0.085e-3]
/** レイリーとミーの高さの尺度 km */
export const RAYLEIGH_SCALE_HEIGHT = 8
export const MIE_SCALE_HEIGHT = 1.2
/** オゾンの層の中心と半幅 km（三角形の分布） */
export const OZONE_CENTER = 25
export const OZONE_HALF_WIDTH = 15

/**
 * 大気の上端での太陽の照度（takram の `solarIrradiance`、Bruneton の既定）
 */
export const SOLAR_IRRADIANCE: Rgb = [1.474, 1.8504, 1.91198]
/**
 * 放射輝度から輝度への換算（takram の `sunRadianceToLuminance` と
 * `skyRadianceToLuminance`）。太陽と空で別の値を使う
 */
export const SUN_RADIANCE_TO_LUMINANCE: Rgb = [98242.786222, 69954.398112, 66475.012354]
export const SKY_RADIANCE_TO_LUMINANCE: Rgb = [114974.916437, 71305.954816, 65310.548555]
/**
 * 換算を太陽の換算の輝度（Rec.709 の重み）で割って相対にする（takram の
 * `sunRadianceToRelativeLuminance` と同じ割り方）
 */
const RELATIVE =
  0.2126 * SUN_RADIANCE_TO_LUMINANCE[0] +
  0.7152 * SUN_RADIANCE_TO_LUMINANCE[1] +
  0.0722 * SUN_RADIANCE_TO_LUMINANCE[2]
/**
 * 直達光と天空光の尺度。Hillaire の値（太陽の照度 1 あたり）に掛けると takram の
 * 光の単位になる。直達は 6 時刻で takram と 0.3% 以内（段 S2a の実測）
 */
export const SUN_ILLUMINANCE: Rgb = [0, 1, 2].map(
  (c) => (SOLAR_IRRADIANCE[c]! * SUN_RADIANCE_TO_LUMINANCE[c]!) / RELATIVE,
) as unknown as Rgb
export const SKY_ILLUMINANCE: Rgb = [0, 1, 2].map(
  (c) => (SOLAR_IRRADIANCE[c]! * SKY_RADIANCE_TO_LUMINANCE[c]!) / RELATIVE,
) as unknown as Rgb

/** 透過率の LUT の大きさ */
export const TRANSMITTANCE_WIDTH = 256
export const TRANSMITTANCE_HEIGHT = 64
/** 透過率を積分する刻みの数（web-ocean と同じ） */
export const TRANSMITTANCE_STEPS = 64

export interface Medium {
  /** 減衰係数 1/km */
  extinction: Rgb
  rayleighScattering: Rgb
  mieScattering: number
}

/**
 * 高さ h km の媒質。`haze` はミーの倍率（web-ocean の `A.haze.x`、既定 1）
 */
export function medium(h: number, haze = 1): Medium {
  const hh = Math.max(h, 0)
  const dR = Math.exp(-hh / RAYLEIGH_SCALE_HEIGHT)
  const dM = Math.exp(-hh / MIE_SCALE_HEIGHT)
  const dO = Math.max(0, 1 - Math.abs(hh - OZONE_CENTER) / OZONE_HALF_WIDTH)
  const rayleighScattering: Rgb = [
    RAYLEIGH_SCATTERING[0] * dR,
    RAYLEIGH_SCATTERING[1] * dR,
    RAYLEIGH_SCATTERING[2] * dR,
  ]
  const mieExt = MIE_EXTINCTION * dM * haze
  return {
    rayleighScattering,
    mieScattering: MIE_SCATTERING * dM * haze,
    extinction: [
      rayleighScattering[0] + mieExt + OZONE_ABSORPTION[0] * dO,
      rayleighScattering[1] + mieExt + OZONE_ABSORPTION[1] * dO,
      rayleighScattering[2] + mieExt + OZONE_ABSORPTION[2] * dO,
    ],
  }
}

/**
 * 原点を中心とする半径 R の球と、点 ro から向き rd の光線の交点の距離（近い方、遠い方）。
 * 交わらなければ [-1, -1]
 */
export function raySphere(
  ro: readonly [number, number, number],
  rd: readonly [number, number, number],
  radius: number,
): [number, number] {
  const l = Math.hypot(ro[0], ro[1], ro[2])
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2]
  const c = (l - radius) * (l + radius)
  const d = b * b - c
  if (d < 0) return [-1, -1]
  const s = Math.sqrt(d)
  return [-b - s, -b + s]
}

const rhoOf = (r: number) => Math.sqrt(Math.max(0, (r - GROUND_RADIUS) * (r + GROUND_RADIUS)))
const H = Math.sqrt(TOP_RADIUS * TOP_RADIUS - GROUND_RADIUS * GROUND_RADIUS)

/** 半径 r と天頂角の余弦 mu から、透過率の LUT の uv（Bruneton の写し方） */
export function transmittanceRMuToUv(r: number, mu: number): [number, number] {
  const rho = rhoOf(r)
  const disc = r * r * (mu * mu - 1) + TOP_RADIUS * TOP_RADIUS
  const d = Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)))
  const dMin = TOP_RADIUS - r
  const dMax = rho + H
  return [(d - dMin) / (dMax - dMin), rho / H]
}

/** `transmittanceRMuToUv` の逆 */
export function transmittanceUvToRMu(u: number, v: number): [number, number] {
  const rho = H * v
  const r = Math.sqrt(rho * rho + GROUND_RADIUS * GROUND_RADIUS)
  const dMin = TOP_RADIUS - r
  const dMax = rho + H
  const d = dMin + u * (dMax - dMin)
  let mu = 1
  if (d > 0) mu = (H * H - rho * rho - d * d) / (2 * r * d)
  return [r, Math.min(1, Math.max(-1, mu))]
}

/**
 * 半径 r から天頂角の余弦 mu の向きに、大気の上端までの透過率。
 *
 * 刻みは `TRANSMITTANCE_STEPS` の中点則（web-ocean の `TRANS_LUT` と同じ）。
 * **地面に当たる向きでも上端まで積分する。**LUT の側は地平線より下の値を使わない
 */
export function transmittanceToTop(r: number, mu: number, haze = 1): [number, number, number] {
  const ro: [number, number, number] = [0, r, 0]
  const rd: [number, number, number] = [Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0]
  const tMax = raySphere(ro, rd, TOP_RADIUS)[1]
  const dt = tMax / TRANSMITTANCE_STEPS
  const od = [0, 0, 0]
  for (let i = 0; i < TRANSMITTANCE_STEPS; i++) {
    const t = (i + 0.5) * dt
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t]
    const ext = medium(Math.hypot(p[0]!, p[1]!, p[2]!) - GROUND_RADIUS, haze).extinction
    od[0]! += ext[0] * dt
    od[1]! += ext[1] * dt
    od[2]! += ext[2] * dt
  }
  return [Math.exp(-od[0]!), Math.exp(-od[1]!), Math.exp(-od[2]!)]
}

/** 透過率の LUT の画素 (x, y) の値。GPU 版と同じく画素の中心で引く */
export function transmittanceTexel(x: number, y: number, haze = 1): [number, number, number] {
  const [r, mu] = transmittanceUvToRMu(
    (x + 0.5) / TRANSMITTANCE_WIDTH,
    (y + 0.5) / TRANSMITTANCE_HEIGHT,
  )
  return transmittanceToTop(r, mu, haze)
}

// ---- LUT を引く ----

/** RGB の 2D の表。GPU のテクスチャの写し。`data` は行ごと（y が外側）に RGB */
export interface RgbTable {
  width: number
  height: number
  data: Float64Array
}

/** 表を作る。`texel(x, y)` を画素ごとに呼ぶ */
export function buildTable(
  width: number,
  height: number,
  texel: (x: number, y: number) => readonly [number, number, number],
): RgbTable {
  const data = new Float64Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = texel(x, y)
      const i = (y * width + x) * 3
      data[i] = v[0]
      data[i + 1] = v[1]
      data[i + 2] = v[2]
    }
  }
  return { width, height, data }
}

/**
 * 表を uv で線形補間して引く。端は画素の中心で止める（GPU の `clamp-to-edge` と
 * 線形補間の組と同じ）
 */
export function sampleTable(table: RgbTable, u: number, v: number): [number, number, number] {
  const fx = Math.min(Math.max(u * table.width - 0.5, 0), table.width - 1)
  const fy = Math.min(Math.max(v * table.height - 0.5, 0), table.height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, table.width - 1)
  const y1 = Math.min(y0 + 1, table.height - 1)
  const tx = fx - x0
  const ty = fy - y0
  const at = (x: number, y: number, c: number) => table.data[(y * table.width + x) * 3 + c]!
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx
    const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx
    out[c] = a * (1 - ty) + b * ty
  }
  return out
}

/** 透過率の LUT を作る（GPU の `TRANS_LUT` と同じ画素の並び） */
export function buildTransmittanceTable(haze = 1): RgbTable {
  return buildTable(TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT, (x, y) => transmittanceTexel(x, y, haze))
}

/** 透過率の LUT を半径と余弦で引く */
export function sampleTransmittance(table: RgbTable, r: number, mu: number): [number, number, number] {
  const [u, v] = transmittanceRMuToUv(r, mu)
  return sampleTable(table, u, v)
}

/** 太陽が地平線の下にあるか（半径 r の点から見て） */
export function sunBelowHorizon(r: number, mu: number): boolean {
  return mu < -rhoOf(r) / r
}

/** LUT の端の画素の中心を 0 と 1 に合わせる写し方（Hillaire） */
export const fromUnitToSubUvs = (u: number, res: number) => (u + 0.5 / res) * (res / (res + 1))
export const fromSubUvsToUnit = (u: number, res: number) => (u - 0.5 / res) * (res / (res - 1))

// ---- 多重散乱の LUT ----

/** 多重散乱の LUT の一辺 */
export const MULTISCATTER_SIZE = 32
/** 方向の標本の一辺（8 x 8 = 64 方向）と、1 方向の刻み */
export const MULTISCATTER_DIRECTIONS = 8
export const MULTISCATTER_STEPS = 20
/** 地面の反射率（takram の 0.1。web-ocean は 0.06） */
export const GROUND_ALBEDO = 0.1

/**
 * 多重散乱の LUT の画素 (x, y) の値（web-ocean の `MS_LUT` の写し）。
 * x が太陽の天頂角の余弦、y が高さ
 */
export function multiscatterTexel(
  transmittance: RgbTable,
  x: number,
  y: number,
  haze = 1,
): [number, number, number] {
  const u = fromSubUvsToUnit((x + 0.5) / MULTISCATTER_SIZE, MULTISCATTER_SIZE)
  const v = fromSubUvsToUnit((y + 0.5) / MULTISCATTER_SIZE, MULTISCATTER_SIZE)
  const cosSun = u * 2 - 1
  const h = Math.max(v * (TOP_RADIUS - GROUND_RADIUS), 0.01)
  const r = GROUND_RADIUS + h
  const ro: [number, number, number] = [0, r, 0]
  const sun: [number, number, number] = [Math.sqrt(Math.max(0, 1 - cosSun * cosSun)), cosSun, 0]
  const lSum = [0, 0, 0]
  const fSum = [0, 0, 0]
  const n = MULTISCATTER_DIRECTIONS
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const th = Math.acos(1 - (2 * (b + 0.5)) / n)
      const ph = (2 * Math.PI * (a + 0.5)) / n
      const rd: [number, number, number] = [
        Math.sin(th) * Math.cos(ph),
        Math.cos(th),
        Math.sin(th) * Math.sin(ph),
      ]
      const tTop = raySphere(ro, rd, TOP_RADIUS)
      const tGr = raySphere(ro, rd, GROUND_RADIUS)
      const hitG = tGr[0] > 0
      const tMax = hitG ? tGr[0] : tTop[1]
      const dt = tMax / MULTISCATTER_STEPS
      const T = [1, 1, 1]
      const L = [0, 0, 0]
      const F = [0, 0, 0]
      for (let s = 0; s < MULTISCATTER_STEPS; s++) {
        const t = (s + 0.5) * dt
        const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t] as const
        const pr = Math.hypot(p[0], p[1], p[2])
        const m = medium(pr - GROUND_RADIUS, haze)
        const smu = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / pr
        const sunT = sunBelowHorizon(pr, smu) ? [0, 0, 0] : sampleTransmittance(transmittance, pr, smu)
        for (let c = 0; c < 3; c++) {
          const scat = m.rayleighScattering[c]! + m.mieScattering
          const ts = Math.exp(-m.extinction[c]! * dt)
          const ext = Math.max(m.extinction[c]!, 1e-9)
          const S = (scat * sunT[c]!) / (4 * Math.PI)
          L[c]! += (T[c]! * (S - S * ts)) / ext
          F[c]! += (T[c]! * (scat - scat * ts)) / ext
          T[c]! *= ts
        }
      }
      if (hitG) {
        const pg = [ro[0] + rd[0] * tMax, ro[1] + rd[1] * tMax, ro[2] + rd[2] * tMax] as const
        const len = Math.hypot(pg[0], pg[1], pg[2])
        const smu = (pg[0] * sun[0] + pg[1] * sun[1] + pg[2] * sun[2]) / len
        const tg = sampleTransmittance(transmittance, GROUND_RADIUS, smu)
        for (let c = 0; c < 3; c++) {
          L[c]! += (T[c]! * tg[c]! * Math.max(smu, 0) * GROUND_ALBEDO) / Math.PI
        }
      }
      for (let c = 0; c < 3; c++) {
        lSum[c]! += L[c]!
        fSum[c]! += F[c]!
      }
    }
  }
  const inv = 1 / (n * n)
  return [0, 1, 2].map((c) => (lSum[c]! * inv) / (1 - fSum[c]! * inv)) as [number, number, number]
}

/** 多重散乱の LUT を作る */
export function buildMultiscatterTable(transmittance: RgbTable, haze = 1): RgbTable {
  return buildTable(MULTISCATTER_SIZE, MULTISCATTER_SIZE, (x, y) =>
    multiscatterTexel(transmittance, x, y, haze),
  )
}

/** 多重散乱の LUT を太陽の天頂角の余弦と高さで引く */
export function sampleMultiscatter(table: RgbTable, sunMu: number, h: number): [number, number, number] {
  return sampleTable(
    table,
    fromUnitToSubUvs(sunMu * 0.5 + 0.5, MULTISCATTER_SIZE),
    fromUnitToSubUvs(Math.min(Math.max(h / (TOP_RADIUS - GROUND_RADIUS), 0), 1), MULTISCATTER_SIZE),
  )
}

// ---- 空の放射輝度 ----

export const phaseRayleigh = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c)
export function phaseMie(c: number, g: number): number {
  const g2 = g * g
  return (
    ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) /
    ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5))
  )
}
/** ミーの位相関数の非対称の度合い（takram の 0.8。web-ocean は 0.84） */
export const MIE_G = 0.8
/** 空の見え方の LUT の 1 本の視線の刻み */
export const SKY_VIEW_STEPS = 48

/**
 * 高さ altitude km の点から向き viewDir を見た空の放射輝度（太陽の照度 1 あたり）。
 *
 * web-ocean の `SKYVIEW_LUT` の 1 画素ぶんの積分の写し。太陽は xy 平面に置く
 * （太陽の天頂角の余弦 sunMu、方位は +x）。刻みは 2 乗で配り、区間の 0.3 の位置で
 * 引く（Hillaire）
 */
export function skyRadiance(
  transmittance: RgbTable,
  multiscatter: RgbTable,
  altitude: number,
  viewDir: readonly [number, number, number],
  sunMu: number,
  haze = 1,
): [number, number, number] {
  const r = GROUND_RADIUS + altitude
  const ro: [number, number, number] = [0, r, 0]
  const sun: [number, number, number] = [Math.sqrt(Math.max(0, 1 - sunMu * sunMu)), sunMu, 0]
  const tTop = raySphere(ro, viewDir, TOP_RADIUS)
  const tGr = raySphere(ro, viewDir, GROUND_RADIUS)
  const tMax = tGr[0] > 0 ? tGr[0] : tTop[1]
  const cosT = viewDir[0] * sun[0] + viewDir[1] * sun[1] + viewDir[2] * sun[2]
  const pR = phaseRayleigh(cosT)
  const pM = phaseMie(cosT, MIE_G)
  const L = [0, 0, 0]
  const T = [1, 1, 1]
  let tPrev = 0
  for (let i = 0; i < SKY_VIEW_STEPS; i++) {
    const fa = (i + 1) / SKY_VIEW_STEPS
    const tn = tMax * fa * fa
    const dt = tn - tPrev
    const t = tPrev + dt * 0.3
    tPrev = tn
    const p = [ro[0] + viewDir[0] * t, ro[1] + viewDir[1] * t, ro[2] + viewDir[2] * t] as const
    const pr = Math.hypot(p[0], p[1], p[2])
    const h = pr - GROUND_RADIUS
    const m = medium(h, haze)
    const pmu = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / pr
    const sunT = sunBelowHorizon(pr, pmu) ? [0, 0, 0] : sampleTransmittance(transmittance, pr, pmu)
    const ms = sampleMultiscatter(multiscatter, pmu, h)
    for (let c = 0; c < 3; c++) {
      const S =
        sunT[c]! * (m.rayleighScattering[c]! * pR + m.mieScattering * pM) +
        ms[c]! * (m.rayleighScattering[c]! + m.mieScattering)
      const ts = Math.exp(-m.extinction[c]! * dt)
      const ext = Math.max(m.extinction[c]!, 1e-9)
      L[c]! += (T[c]! * (S - S * ts)) / ext
      T[c]! *= ts
    }
  }
  return [L[0]!, L[1]!, L[2]!]
}

/**
 * 地表の上向きの面が受ける空からの照度を π で割ったもの（太陽の照度 1 あたり）。
 *
 * takram の照度プローブ（`nodeScene.ts` の `refreshRadiance` の空の側、
 * `illuminance(world, up).indirect / π`）と同じ量。半球を天頂角と方位で
 * 刻んで `L cosθ dω` を足す
 */
export function skyIrradianceOverPi(
  transmittance: RgbTable,
  multiscatter: RgbTable,
  sunMu: number,
  zenithSteps = 32,
  azimuthSteps = 64,
  haze = 1,
): [number, number, number] {
  const E = [0, 0, 0]
  for (let i = 0; i < zenithSteps; i++) {
    // cosθ で等分する（立体角が等しくなる）
    const c0 = i / zenithSteps
    const c1 = (i + 1) / zenithSteps
    const cosTh = (c0 + c1) / 2
    const sinTh = Math.sqrt(1 - cosTh * cosTh)
    for (let j = 0; j < azimuthSteps; j++) {
      const ph = (2 * Math.PI * (j + 0.5)) / azimuthSteps
      const dir: [number, number, number] = [sinTh * Math.cos(ph), cosTh, sinTh * Math.sin(ph)]
      const L = skyRadiance(transmittance, multiscatter, 0, dir, sunMu, haze)
      const dOmega = (c1 - c0) * ((2 * Math.PI) / azimuthSteps)
      for (let c = 0; c < 3; c++) E[c]! += L[c]! * cosTh * dOmega
    }
  }
  return [E[0]! / Math.PI, E[1]! / Math.PI, E[2]! / Math.PI]
}

// ---- 空の見え方の LUT ----

/** 空の見え方の LUT の大きさ（web-ocean と同じ） */
export const SKY_VIEW_WIDTH = 256
export const SKY_VIEW_HEIGHT = 144

/**
 * 空の見え方の LUT の画素 (x, y) の視線の向き（太陽の方位を +x とする枠）。
 * web-ocean の `SKYVIEW_LUT` の前半の写し。地平線の付近に画素を寄せる写し方
 */
export function skyViewDirection(x: number, y: number, altitude: number): [number, number, number] {
  const u = fromSubUvsToUnit((x + 0.5) / SKY_VIEW_WIDTH, SKY_VIEW_WIDTH)
  const v = fromSubUvsToUnit((y + 0.5) / SKY_VIEW_HEIGHT, SKY_VIEW_HEIGHT)
  const r = GROUND_RADIUS + altitude
  const cosBeta = rhoOf(r) / r
  const beta = Math.acos(Math.min(1, Math.max(-1, cosBeta)))
  const zha = Math.PI - beta
  let vza: number
  if (v < 0.5) {
    const coord = 1 - 2 * v
    vza = zha * (1 - coord * coord)
  } else {
    const coord = v * 2 - 1
    vza = zha + beta * coord * coord
  }
  const lvc = -(u * u * 2 - 1)
  const lvs = Math.sqrt(Math.max(0, 1 - lvc * lvc))
  return [Math.sin(vza) * lvc, Math.cos(vza), Math.sin(vza) * lvs]
}

/** 空の見え方の LUT を作る（GPU の `skyViewFragmentNode` と同じ画素の並び） */
export function buildSkyViewTable(
  transmittance: RgbTable,
  multiscatter: RgbTable,
  altitude: number,
  sunMu: number,
): RgbTable {
  return buildTable(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT, (x, y) =>
    skyRadiance(transmittance, multiscatter, altitude, skyViewDirection(x, y, altitude), sunMu),
  )
}
