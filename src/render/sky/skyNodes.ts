import {
  Fn,
  If,
  Loop,
  abs,
  acos,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  getViewPosition,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  sin,
  sqrt,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Texture } from 'three'
import type { Node } from 'three/webgpu'
import {
  AERIAL_MAX_KM,
  AERIAL_SIZE,
  AERIAL_SLICES,
  AERIAL_STEPS,
  GROUND_ALBEDO,
  GROUND_RADIUS,
  IRRADIANCE_HEIGHT,
  IRRADIANCE_MU_MIN,
  IRRADIANCE_WIDTH,
  MIE_EXTINCTION,
  MIE_G,
  MIE_SCALE_HEIGHT,
  MIE_SCATTERING,
  MULTISCATTER_DIRECTIONS,
  MULTISCATTER_SIZE,
  MULTISCATTER_STEPS,
  OZONE_ABSORPTION,
  OZONE_CENTER,
  OZONE_HALF_WIDTH,
  RAYLEIGH_SCALE_HEIGHT,
  RAYLEIGH_SCATTERING,
  SKY_VIEW_HEIGHT,
  SKY_VIEW_STEPS,
  SKY_VIEW_WIDTH,
  TOP_RADIUS,
  TRANSMITTANCE_STEPS,
} from './reference'

/**
 * Hillaire の大気の LUT を TSL で焼く（段 S2a）。
 *
 * web-ocean（MIT、a07c7fd）の `TRANS_LUT`・`MS_LUT`・`SKYVIEW_LUT` の写し。web-ocean は
 * コンピュートで焼くが、ここは全画面のクアッドへフラグメントで焼く（`clouds/volume.ts` の
 * `bakePlane`）。WebGL2 と WebGPU の両方のバックエンドで同じ式が走り、自己診断
 * （`?gpu=1|2`）で CPU 参照（`reference.ts`）と比べられる。
 *
 * **式は CPU 参照と 1 対 1 に写す。**刻み・LUT の写し方・定数はすべて `reference.ts` から
 * 読む。CPU 参照の側の検査（`tests/render/skyTruth.test.ts`）が光の強さを縛り、ここは
 * GPU の読み戻しが CPU 参照と相対 1e-3 で一致することで縛る（node-path.spec）。
 *
 * **焼くときは v を裏返す**（`bakeUv`）。node 経路はレンダーターゲットのテクスチャを
 * 引くとき v を裏返すので、焼く側で打ち消すと「LUT の uv」をそのまま `texture()` に
 * 渡せる（`clouds/noiseNodes.ts` の `bakeUv` と同じ約束）。
 *
 * **ループの中のテクスチャは LOD 0 で引く。**分岐の中で微分を使う暗黙の LOD は
 * WGSL で許されない。
 */

/**
 * 名前を付けたループ。**入れ子のループは名前を変える。**名前を付けないと内側も外側も
 * `i` になり、外側の変数を内側で読めなくなる。three の `LoopNode` は `param.name` を
 * 読む（`LoopNode.js` の `getVarName` の手前）が、`@types/three` の
 * `LoopNodeObjectParameter` には無いので、型の逃げ口をここ 1 か所にまとめる
 */
function loopNamed(name: string, count: number, body: (index: N<'int'>) => void): void {
  const run = Loop as unknown as (
    param: { start: N<'int'>; end: N<'int'>; type: 'int'; condition: '<'; name: string },
    func: (inputs: Record<string, N<'int'>>) => void,
  ) => void
  run({ start: int(0) as unknown as N<'int'>, end: int(count) as unknown as N<'int'>, type: 'int', condition: '<', name }, (inputs) =>
    body(inputs[name]!),
  )
}

/** 焼くときの uv。v を裏返す（ファイルの頭の注記） */
export function bakeUv(): Node<'vec2'> {
  return vec2(uv().x, float(1).sub(uv().y)) as unknown as Node<'vec2'>
}

const PI = Math.PI
const H = Math.sqrt(TOP_RADIUS * TOP_RADIUS - GROUND_RADIUS * GROUND_RADIUS)
const RAYLEIGH = vec3(RAYLEIGH_SCATTERING[0], RAYLEIGH_SCATTERING[1], RAYLEIGH_SCATTERING[2])
const OZONE = vec3(OZONE_ABSORPTION[0], OZONE_ABSORPTION[1], OZONE_ABSORPTION[2])

type N<T extends string> = Node<T>

interface MediumNode {
  extinction: N<'vec3'>
  rayleighScattering: N<'vec3'>
  mieScattering: N<'float'>
}

/** 高さ h km の媒質（`reference.ts` の `medium`、霞の倍率は 1） */
function mediumNode(h: N<'float'>): MediumNode {
  const hh = max(h, 0)
  const dR = exp(hh.negate().div(RAYLEIGH_SCALE_HEIGHT))
  const dM = exp(hh.negate().div(MIE_SCALE_HEIGHT))
  const dO = max(float(0), float(1).sub(abs(hh.sub(OZONE_CENTER)).div(OZONE_HALF_WIDTH)))
  const rayleighScattering = RAYLEIGH.mul(dR) as unknown as N<'vec3'>
  return {
    rayleighScattering,
    mieScattering: dM.mul(MIE_SCATTERING) as unknown as N<'float'>,
    extinction: rayleighScattering.add(dM.mul(MIE_EXTINCTION)).add(OZONE.mul(dO)) as unknown as N<'vec3'>,
  }
}

/**
 * 原点の球と光線の交点の遠い方の距離。上端から出るところ（`reference.ts` の
 * `raySphere` の [1]）。交わらなければ -1
 */
function sphereFar(ro: N<'vec3'>, rd: N<'vec3'>, radius: number): N<'float'> {
  const b = dot(ro, rd)
  const c = dot(ro, ro).sub(radius * radius)
  const d = b.mul(b).sub(c)
  return d.lessThan(0).select(float(-1), b.negate().add(sqrt(max(d, 0)))) as unknown as N<'float'>
}

/** 同じく近い方 */
function sphereNear(ro: N<'vec3'>, rd: N<'vec3'>, radius: number): N<'float'> {
  const b = dot(ro, rd)
  const c = dot(ro, ro).sub(radius * radius)
  const d = b.mul(b).sub(c)
  return d.lessThan(0).select(float(-1), b.negate().sub(sqrt(max(d, 0)))) as unknown as N<'float'>
}

const rhoOf = (r: N<'float'>) =>
  sqrt(max(r.sub(GROUND_RADIUS).mul(r.add(GROUND_RADIUS)), 0)) as unknown as N<'float'>

/** 半径と余弦から透過率の LUT の uv（`transmittanceRMuToUv`） */
export function transmittanceUvNode(r: N<'float'>, mu: N<'float'>): N<'vec2'> {
  const rho = rhoOf(r)
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(TOP_RADIUS * TOP_RADIUS)
  const d = max(r.negate().mul(mu).add(sqrt(max(disc, 0))), 0)
  const dMin = float(TOP_RADIUS).sub(r)
  const dMax = rho.add(H)
  return vec2(d.sub(dMin).div(dMax.sub(dMin)), rho.div(H)) as unknown as N<'vec2'>
}

/** 透過率の LUT を引く */
export function sampleTransmittanceNode(table: Texture, r: N<'float'>, mu: N<'float'>): N<'vec3'> {
  return texture(table, transmittanceUvNode(r, mu), 0).rgb as unknown as N<'vec3'>
}

/** 太陽が地平線の下にあるか（`sunBelowHorizon`） */
function sunBelowHorizonNode(r: N<'float'>, mu: N<'float'>): N<'bool'> {
  return mu.lessThan(rhoOf(r).negate().div(r)) as unknown as N<'bool'>
}

const fromUnitToSubUvs = (u: N<'float'>, res: number) =>
  u.add(0.5 / res).mul(res / (res + 1)) as unknown as N<'float'>
const fromSubUvsToUnit = (u: N<'float'>, res: number) =>
  u.sub(0.5 / res).mul(res / (res - 1)) as unknown as N<'float'>

/** 透過率の LUT を 1 画素ずつ焼く断片（`transmittanceTexel`） */
export function transmittanceFragmentNode(): N<'vec4'> {
  return Fn(() => {
    const p = bakeUv()
    const rho = float(H).mul(p.y).toVar()
    const r = sqrt(rho.mul(rho).add(GROUND_RADIUS * GROUND_RADIUS)).toVar()
    const dMin = float(TOP_RADIUS).sub(r)
    const dMax = rho.add(H)
    const d = dMin.add(p.x.mul(dMax.sub(dMin))).toVar()
    const mu = float(1).toVar()
    If(d.greaterThan(0), () => {
      mu.assign(float(H * H).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2)))
    })
    mu.assign(clamp(mu, -1, 1))
    const ro = vec3(0, r, 0)
    const rd = vec3(sqrt(max(float(1).sub(mu.mul(mu)), 0)), mu, 0)
    const tMax = sphereFar(ro, rd, TOP_RADIUS).toVar()
    const dt = tMax.div(TRANSMITTANCE_STEPS).toVar()
    const od = vec3(0, 0, 0).toVar()
    Loop({ start: int(0), end: int(TRANSMITTANCE_STEPS), type: 'int', condition: '<' }, ({ i }) => {
      const t = float(i).add(0.5).mul(dt)
      const q = ro.add(rd.mul(t))
      od.addAssign(mediumNode(length(q).sub(GROUND_RADIUS)).extinction.mul(dt))
    })
    return vec4(exp(od.negate()), 1)
  })() as unknown as N<'vec4'>
}

/** 多重散乱の LUT を 1 画素ずつ焼く断片（`multiscatterTexel`） */
export function multiscatterFragmentNode(transmittance: Texture): N<'vec4'> {
  return Fn(() => {
    const p = bakeUv()
    const u = fromSubUvsToUnit(p.x, MULTISCATTER_SIZE)
    const v = fromSubUvsToUnit(p.y, MULTISCATTER_SIZE)
    const cosSun = u.mul(2).sub(1).toVar()
    const h = max(v.mul(TOP_RADIUS - GROUND_RADIUS), 0.01)
    const r = h.add(GROUND_RADIUS).toVar()
    const ro = vec3(0, r, 0).toVar()
    const sun = vec3(sqrt(max(float(1).sub(cosSun.mul(cosSun)), 0)), cosSun, 0).toVar()
    const lSum = vec3(0, 0, 0).toVar()
    const fSum = vec3(0, 0, 0).toVar()
    const n = MULTISCATTER_DIRECTIONS
    loopNamed('a', n, (a) => {
      loopNamed('b', n, (b) => {
        const th = acos(float(1).sub(float(b).add(0.5).mul(2 / n)))
        const ph = float(a).add(0.5).mul((2 * PI) / n)
        const rd = vec3(sin(th).mul(cos(ph)), cos(th), sin(th).mul(sin(ph))).toVar()
        const tTop = sphereFar(ro, rd, TOP_RADIUS)
        const tGr = sphereNear(ro, rd, GROUND_RADIUS).toVar()
        const hitG = tGr.greaterThan(0).toVar()
        const tMax = hitG.select(tGr, tTop).toVar()
        const dt = tMax.div(MULTISCATTER_STEPS).toVar()
        const T = vec3(1, 1, 1).toVar()
        const L = vec3(0, 0, 0).toVar()
        const F = vec3(0, 0, 0).toVar()
        loopNamed('s', MULTISCATTER_STEPS, (s) => {
          const q = ro.add(rd.mul(float(s).add(0.5).mul(dt))).toVar()
          const pr = length(q).toVar()
          const m = mediumNode(pr.sub(GROUND_RADIUS))
          const smu = dot(q, sun).div(pr).toVar()
          const sunT = sampleTransmittanceNode(transmittance, pr, smu).toVar()
          If(sunBelowHorizonNode(pr, smu), () => {
            sunT.assign(vec3(0, 0, 0))
          })
          const scat = m.rayleighScattering.add(m.mieScattering).toVar()
          const ts = exp(m.extinction.negate().mul(dt)).toVar()
          const ext = max(m.extinction, vec3(1e-9, 1e-9, 1e-9)).toVar()
          const S = scat.mul(sunT).div(4 * PI).toVar()
          L.addAssign(T.mul(S.sub(S.mul(ts))).div(ext))
          F.addAssign(T.mul(scat.sub(scat.mul(ts))).div(ext))
          T.mulAssign(ts)
        })
        If(hitG, () => {
          const pg = ro.add(rd.mul(tMax)).toVar()
          const smu = dot(pg.div(length(pg)), sun).toVar()
          L.addAssign(
            T.mul(sampleTransmittanceNode(transmittance, float(GROUND_RADIUS), smu))
              .mul(max(smu, 0))
              .mul(GROUND_ALBEDO / PI),
          )
        })
        lSum.addAssign(L)
        fSum.addAssign(F)
      })
    })
    const inv = 1 / (n * n)
    return vec4(lSum.mul(inv).div(vec3(1, 1, 1).sub(fSum.mul(inv))), 1)
  })() as unknown as N<'vec4'>
}

/** 多重散乱の LUT を太陽の余弦と高さで引く（`sampleMultiscatter`） */
export function sampleMultiscatterNode(table: Texture, sunMu: N<'float'>, h: N<'float'>): N<'vec3'> {
  const uvNode = vec2(
    fromUnitToSubUvs(sunMu.mul(0.5).add(0.5), MULTISCATTER_SIZE),
    fromUnitToSubUvs(clamp(h.div(TOP_RADIUS - GROUND_RADIUS), 0, 1), MULTISCATTER_SIZE),
  )
  return texture(table, uvNode, 0).rgb as unknown as N<'vec3'>
}

/** レイリーとミーの位相関数（`reference.ts` と同じ） */
export const phaseRayleighNode = (c: N<'float'>) => c.mul(c).add(1).mul(3 / (16 * PI)) as unknown as N<'float'>
export function phaseMieNode(c: N<'float'>): N<'float'> {
  const g2 = MIE_G * MIE_G
  return c
    .mul(c)
    .add(1)
    .mul(((3 / (8 * PI)) * (1 - g2)) / (2 + g2))
    .div(pow(max(c.mul(-2 * MIE_G).add(1 + g2), 1e-4), 1.5)) as unknown as N<'float'>
}


/**
 * 視線の向きに沿って空の放射輝度を積分する（`skyRadiance`、太陽の照度 1 あたり）。
 * 太陽は xy 平面（方位 +x）に置き、viewDir はその枠での向き
 */
export function skyRadianceNode(
  transmittance: Texture,
  multiscatter: Texture,
  altitude: N<'float'>,
  viewDir: N<'vec3'>,
  sunMu: N<'float'>,
): N<'vec3'> {
  return Fn(() => {
    const r = altitude.add(GROUND_RADIUS).toVar()
    const ro = vec3(0, r, 0).toVar()
    const sun = vec3(sqrt(max(float(1).sub(sunMu.mul(sunMu)), 0)), sunMu, 0).toVar()
    const tTop = sphereFar(ro, viewDir, TOP_RADIUS)
    const tGr = sphereNear(ro, viewDir, GROUND_RADIUS)
    const tMax = tGr.greaterThan(0).select(tGr, tTop).toVar()
    const cosT = dot(viewDir, sun).toVar()
    const pR = phaseRayleighNode(cosT).toVar()
    const pM = phaseMieNode(cosT).toVar()
    const L = vec3(0, 0, 0).toVar()
    const T = vec3(1, 1, 1).toVar()
    const tPrev = float(0).toVar()
    Loop({ start: int(0), end: int(SKY_VIEW_STEPS), type: 'int', condition: '<' }, ({ i }) => {
      const fa = float(i).add(1).div(SKY_VIEW_STEPS)
      const tn = tMax.mul(fa).mul(fa).toVar()
      const dt = tn.sub(tPrev).toVar()
      // **先に変数へ確定させる。**TSL は式を後で組み立てるので、確定させずに
      // `tPrev` を書き換えると、t は書き換えた後の値で評価される（1 区間先へずれた）
      const t = tPrev.add(dt.mul(0.3)).toVar()
      tPrev.assign(tn)
      const q = ro.add(viewDir.mul(t)).toVar()
      const pr = length(q).toVar()
      const h = pr.sub(GROUND_RADIUS).toVar()
      const m = mediumNode(h)
      const pmu = dot(q, sun).div(pr).toVar()
      const sunT = sampleTransmittanceNode(transmittance, pr, pmu).toVar()
      If(sunBelowHorizonNode(pr, pmu), () => {
        sunT.assign(vec3(0, 0, 0))
      })
      const ms = sampleMultiscatterNode(multiscatter, pmu, h)
      const S = sunT
        .mul(m.rayleighScattering.mul(pR).add(m.mieScattering.mul(pM)))
        .add(ms.mul(m.rayleighScattering.add(m.mieScattering)))
        .toVar()
      const ts = exp(m.extinction.negate().mul(dt)).toVar()
      const ext = max(m.extinction, vec3(1e-9, 1e-9, 1e-9))
      L.addAssign(T.mul(S.sub(S.mul(ts))).div(ext))
      T.mulAssign(ts)
    })
    return L
  })() as unknown as N<'vec3'>
}

/**
 * 空の見え方の LUT の uv から視線の向き（太陽の方位を +x とする枠）を出す
 * （web-ocean の `SKYVIEW_LUT` の前半の写し）
 */
function skyViewDirection(p: N<'vec2'>, altitude: N<'float'>): N<'vec3'> {
  return Fn(() => {
    const u = fromSubUvsToUnit(p.x, SKY_VIEW_WIDTH)
    const v = fromSubUvsToUnit(p.y, SKY_VIEW_HEIGHT)
    const r = altitude.add(GROUND_RADIUS)
    const cosBeta = rhoOf(r).div(r)
    const beta = acos(clamp(cosBeta, -1, 1)).toVar()
    const zha = float(PI).sub(beta).toVar()
    const vza = float(0).toVar()
    If(v.lessThan(0.5), () => {
      const coord = float(1).sub(v.mul(2))
      vza.assign(zha.mul(float(1).sub(coord.mul(coord))))
    }).Else(() => {
      const coord = v.mul(2).sub(1)
      vza.assign(zha.add(beta.mul(coord.mul(coord))))
    })
    const lvc = u.mul(u).mul(2).sub(1).negate().toVar()
    const lvs = sqrt(max(float(1).sub(lvc.mul(lvc)), 0))
    return vec3(sin(vza).mul(lvc), cos(vza), sin(vza).mul(lvs))
  })() as unknown as N<'vec3'>
}

/** 空の見え方の LUT を焼く断片。高さ km と太陽の余弦は焼く前に決める */
export function skyViewFragmentNode(
  transmittance: Texture,
  multiscatter: Texture,
  altitude: N<'float'>,
  sunMu: N<'float'>,
): N<'vec4'> {
  return Fn(() => {
    const dir = skyViewDirection(bakeUv(), altitude)
    return vec4(skyRadianceNode(transmittance, multiscatter, altitude, dir, sunMu), 1)
  })() as unknown as N<'vec4'>
}

/**
 * ワールドの向きから空の見え方の LUT の uv（web-ocean の `skyViewUV`）。
 * Y が上。太陽の方位は `sunDir.xz` で決まる
 */
export function skyViewUvNode(dir: N<'vec3'>, sunDir: N<'vec3'>, altitude: N<'float'>): N<'vec2'> {
  return Fn(() => {
    const r = altitude.add(GROUND_RADIUS)
    const cosBeta = rhoOf(r).div(r).toVar()
    const beta = acos(clamp(cosBeta, -1, 1)).toVar()
    const zha = float(PI).sub(beta).toVar()
    const vzc = clamp(dir.y, -1, 1).toVar()
    const v = float(0).toVar()
    If(vzc.greaterThanEqual(cosBeta.negate()), () => {
      const coord = float(1).sub(acos(vzc).div(zha))
      v.assign(float(1).sub(sqrt(max(coord, 0))).mul(0.5))
    }).Else(() => {
      const coord = acos(vzc).sub(zha).div(beta)
      v.assign(sqrt(max(coord, 0)).mul(0.5).add(0.5))
    })
    const dl = length(dir.xz).toVar()
    const sl = length(sunDir.xz).toVar()
    const lvc = float(1).toVar()
    If(dl.greaterThan(1e-6).and(sl.greaterThan(1e-6)), () => {
      lvc.assign(clamp(dot(dir.xz, sunDir.xz).div(dl.mul(sl)), -1, 1))
    })
    const u = sqrt(max(lvc.mul(-0.5).add(0.5), 0))
    return vec2(fromUnitToSubUvs(u, SKY_VIEW_WIDTH), fromUnitToSubUvs(v, SKY_VIEW_HEIGHT))
  })() as unknown as N<'vec2'>
}



// ---- 天空の照度の表（段 S2b） ----

/** 表を太陽の余弦と高さ km で引く uv（`irradianceUv`） */
export function irradianceUvNode(sunMu: N<'float'>, altitude: N<'float'>): N<'vec2'> {
  const u = clamp(sunMu.sub(IRRADIANCE_MU_MIN).div(1 - IRRADIANCE_MU_MIN), 0, 1)
  const v = sqrt(clamp(altitude.div(TOP_RADIUS - GROUND_RADIUS), 0, 1))
  return vec2(fromUnitToSubUvs(u, IRRADIANCE_WIDTH), fromUnitToSubUvs(v, IRRADIANCE_HEIGHT)) as unknown as N<'vec2'>
}

/**
 * 上向きの面の天空の照度 / π を引く（`sampleIrradiance`）。表は `DataTexture` で、
 * 行 0 が高さ 0 km（描画先ではないので v の裏返しは無い）
 */
export function sampleIrradianceNode(table: Texture, sunMu: N<'float'>, altitude: N<'float'>): N<'vec3'> {
  return texture(table, irradianceUvNode(sunMu, altitude), 0).rgb as unknown as N<'vec3'>
}

// ---- 霞（段 S2b） ----

/**
 * 霞の 1 本の視線を積分する（`aerialPerspective`）。`part` で入る光か透過率の
 * どちらかを返す。**透過率だけなら散乱を引かない**（LUT を読まずに減衰係数だけを
 * 積む）ので、焼くパスを 2 つに分けても透過率の側は軽い
 */
export function aerialNode(
  transmittance: Texture,
  multiscatter: Texture,
  altitude: N<'float'>,
  viewDir: N<'vec3'>,
  sunDir: N<'vec3'>,
  distance: N<'float'>,
  part: 'inscatter' | 'transmittance',
): N<'vec3'> {
  return Fn(() => {
    const r = altitude.add(GROUND_RADIUS).toVar()
    const ro = vec3(0, r, 0).toVar()
    const tTop = sphereFar(ro, viewDir, TOP_RADIUS)
    const tGr = sphereNear(ro, viewDir, GROUND_RADIUS)
    const tMax = min(distance, tGr.greaterThan(0).select(tGr, tTop)).toVar()
    const cosT = dot(viewDir, sunDir).toVar()
    const pR = phaseRayleighNode(cosT).toVar()
    const pM = phaseMieNode(cosT).toVar()
    const L = vec3(0, 0, 0).toVar()
    const T = vec3(1, 1, 1).toVar()
    const tPrev = float(0).toVar()
    Loop({ start: int(0), end: int(AERIAL_STEPS), type: 'int', condition: '<' }, ({ i }) => {
      const fa = float(i).add(1).div(AERIAL_STEPS)
      const tn = tMax.mul(fa).mul(fa).toVar()
      const dt = tn.sub(tPrev).toVar()
      // 確定させてから `tPrev` を書き換える（`skyRadianceNode` の注記）
      const t = tPrev.add(dt.mul(0.3)).toVar()
      tPrev.assign(tn)
      const q = ro.add(viewDir.mul(t)).toVar()
      const pr = length(q).toVar()
      const h = pr.sub(GROUND_RADIUS).toVar()
      const m = mediumNode(h)
      const ts = exp(m.extinction.negate().mul(dt)).toVar()
      if (part === 'inscatter') {
        const pmu = dot(q, sunDir).div(pr).toVar()
        const sunT = sampleTransmittanceNode(transmittance, pr, pmu).toVar()
        If(sunBelowHorizonNode(pr, pmu), () => {
          sunT.assign(vec3(0, 0, 0))
        })
        const ms = sampleMultiscatterNode(multiscatter, pmu, h)
        const S = sunT
          .mul(m.rayleighScattering.mul(pR).add(m.mieScattering.mul(pM)))
          .add(ms.mul(m.rayleighScattering.add(m.mieScattering)))
          .toVar()
        const ext = max(m.extinction, vec3(1e-9, 1e-9, 1e-9))
        L.addAssign(T.mul(S.sub(S.mul(ts))).div(ext))
      }
      T.mulAssign(ts)
    })
    return part === 'inscatter' ? L : T
  })() as unknown as N<'vec3'>
}

/** 霞の LUT を焼く・引くのに要るカメラの値。毎フレーム書き換える uniform */
export interface AerialInputs {
  /** カメラの高さ km */
  altitude: N<'float'>
  /** ワールドの太陽の向き */
  sunDir: N<'vec3'>
  /** カメラの射影の逆行列（`camera.projectionMatrixInverse`） */
  projectionInverse: N<'mat4'>
  /** カメラのワールド行列（`camera.matrixWorld`） */
  cameraWorld: N<'mat4'>
}

/**
 * 画面の uv（左上が原点、`screenUV` と同じ約束）からワールドの視線の向き。
 * 焼く側と引く側で同じ関数を使い、画面の上下の約束を 1 か所に閉じる
 */
function screenRayNode(screen: N<'vec2'>, inputs: AerialInputs): N<'vec3'> {
  // 深度 0.5 は視線の上の 1 点を取るためだけの値。向きにしか使わない
  const view = getViewPosition(screen as never, float(0.5) as never, inputs.projectionInverse as never)
  return normalize(inputs.cameraWorld.mul(vec4(normalize(view), 0)).xyz) as unknown as N<'vec3'>
}

/**
 * 霞の LUT を焼く断片。横 32 × 32 枚、縦 32 の 2D のアトラス。横の 32 画素ごとに
 * 奥行きの 1 枚で、s 枚目は距離 `aerialSliceDistance(s)` までを積分する
 */
export function aerialFragmentNode(
  transmittance: Texture,
  multiscatter: Texture,
  inputs: AerialInputs,
  part: 'inscatter' | 'transmittance',
): N<'vec4'> {
  return Fn(() => {
    const p = bakeUv()
    const sx = p.x.mul(AERIAL_SLICES).toVar()
    const slice = floor(sx).toVar()
    const screen = vec2(fract(sx), p.y) as unknown as N<'vec2'>
    const dir = screenRayNode(screen, inputs).toVar()
    const f = slice.add(1).div(AERIAL_SLICES)
    const distance = f.mul(f).mul(AERIAL_MAX_KM)
    return vec4(
      aerialNode(transmittance, multiscatter, inputs.altitude, dir, inputs.sunDir, distance as unknown as N<'float'>, part),
      1,
    )
  })() as unknown as N<'vec4'>
}

/** 霞の LUT の焼き先の大きさ（横、縦） */
export const AERIAL_ATLAS_WIDTH = AERIAL_SIZE * AERIAL_SLICES
export const AERIAL_ATLAS_HEIGHT = AERIAL_SIZE

/**
 * 場面の色に霞を掛ける。`screen` は画素の画面の uv、`depth` は深度バッファの値。
 * **空の画素（深度 1）には触らない。**空は背景に描いてある。
 *
 * 奥行きの 2 枚の間を線形に補間する。0 枚目より手前は「距離 0（入る光 0・透過率 1）」と
 * 0 枚目の間で補間する。横は 1 枚の中で画素の中心の内側に留め、隣の枚へ滲ませない
 */
export function applyAerialNode(
  color: N<'vec4'>,
  depth: N<'float'>,
  screen: N<'vec2'>,
  inscatterAtlas: Texture,
  transmittanceAtlas: Texture,
  inputs: AerialInputs,
  skyScale: N<'vec3'>,
): N<'vec4'> {
  return Fn(() => {
    const out = vec4(color).toVar()
    If(depth.lessThan(1), () => {
      const view = getViewPosition(screen as never, depth as never, inputs.projectionInverse as never)
      const distance = length(view).div(1000)
      const s = sqrt(max(distance, 0).div(AERIAL_MAX_KM)).mul(AERIAL_SLICES).sub(1).toVar()
      const s0 = clamp(floor(s), -1, AERIAL_SLICES - 1).toVar()
      const w = clamp(s.sub(s0), 0, 1).toVar()
      const half = 0.5 / AERIAL_SIZE
      const x = clamp(screen.x, half, 1 - half)
      const at = (slice: N<'float'>) =>
        vec2(clamp(slice, 0, AERIAL_SLICES - 1).add(x).div(AERIAL_SLICES), screen.y)
      const s1 = min(s0.add(1), AERIAL_SLICES - 1)
      const in0 = s0.lessThan(0).select(vec3(0, 0, 0), texture(inscatterAtlas, at(s0), 0).rgb)
      const in1 = texture(inscatterAtlas, at(s1 as unknown as N<'float'>), 0).rgb
      const t0 = s0.lessThan(0).select(vec3(1, 1, 1), texture(transmittanceAtlas, at(s0), 0).rgb)
      const t1 = texture(transmittanceAtlas, at(s1 as unknown as N<'float'>), 0).rgb
      const inscatter = mix(in0, in1, w)
      const trans = mix(t0, t1, w)
      out.assign(vec4(color.rgb.mul(trans).add(inscatter.mul(skyScale)), color.a))
    })
    return out
  })() as unknown as N<'vec4'>
}

/**
 * 地表の上向きの面が受ける天空の照度 / π（太陽の照度 1 あたり）。CPU 参照の
 * `skyIrradianceOverPi` と同じ刻みで、視線ごとに `skyRadianceNode` を積分する。
 * 自己診断（`?skyprobe=1`）だけが使う
 */
export function skyIrradianceOverPiNode(
  transmittance: Texture,
  multiscatter: Texture,
  sunMu: N<'float'>,
  zenithSteps: number,
  azimuthSteps: number,
): N<'vec3'> {
  return Fn(() => {
    const e = vec3(0, 0, 0).toVar()
    loopNamed('zi', zenithSteps, (zi) => {
      const c0 = float(zi).div(zenithSteps)
      const cosTh = c0.add(0.5 / zenithSteps).toVar()
      const sinTh = sqrt(float(1).sub(cosTh.mul(cosTh))).toVar()
      loopNamed('aj', azimuthSteps, (aj) => {
        const ph = float(aj).add(0.5).mul((2 * PI) / azimuthSteps)
        const dir = vec3(sinTh.mul(cos(ph)), cosTh, sinTh.mul(sin(ph))).toVar()
        const L = skyRadianceNode(transmittance, multiscatter, float(0), dir, sunMu)
        e.addAssign(L.mul(cosTh).mul((1 / zenithSteps) * ((2 * PI) / azimuthSteps)))
      })
    })
    return e.div(PI)
  })() as unknown as N<'vec3'>
}
