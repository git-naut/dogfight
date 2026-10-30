import { Fn, If, abs, clamp, dot, exp, float, getViewPosition, int, length, max, min, mix, normalize, pow, smoothstep, sqrt, uniform, vec2, vec3, vec4, wgslFn } from 'three/tsl'
import { Vector3 } from 'three'
import type { Node } from 'three/webgpu'
import {
  HIGH_LAYER_ALTITUDE,
  HIGH_LAYER_SIGMA,
  LOW_LAYER_ALTITUDE,
  LOW_LAYER_SIGMA,
  veilFor,
} from './cloudLayersReference'
import { GROUND_RADIUS } from './reference'

/**
 * 層の雲（段 S4c）。web-ocean（MIT、a07c7fd）の `SKY_CLOUD_FUNCS` の写し。
 *
 * 1.5 km の積雲と 4.5 km の高層雲の 2 枚の薄い層を、場面の合成の中で画素ごとに求める。出力は
 * 前乗算の色（rgb, 隠す割合）で、体積の雲（`clouds/cloudsNodePass.ts`）と同じく合成が霞の上に
 * 重ねる（`overlayNodes.ts`）。
 *
 * - **縁と密度とノイズは WGSL のまま**（`wgslFn`。計画で認めた数値核の WGSL 併用）。CPU 参照は
 *   `cloudLayersReference.ts`、自己診断が点で突き合わせる
 * - **下から見る陰影は web-ocean のまま**（自己影 3 点・縁の光・透過・多重散乱・底の寒色の環境光・
 *   水平線の手前の晴れ間）
 * - **上から見る陰影は新しく作った**（web-ocean は見上げるだけ）。太陽の当たる上面が明るく、
 *   環境光は上の空から。係数は推測で、絵の承認（段 S4b）で確かめる
 * - **カメラが層の高さを通る前後 100 m は層を薄くする**（推測の幅）。薄い板を突き抜けるときに
 *   絵が飛ばないように
 * - 場面の物（機体・海・空母）が層より手前なら雲を描かない（深度から求めた距離と比べる）
 *
 * 縁のアンチエイリアスは画素の大きさから見積もる（web-ocean のコンピュートの逃げ道）。画面の
 * 微分を使わないので、雲の無い画素を分岐で早く抜けられる。
 */

type N<T extends string> = Node<T>

/**
 * WGSL の関数。`@types/three` の include の型は `wgslFn` の戻り値を受けないが、実行時は受ける。
 * 型の逃げ口をここに 1 か所（`ocean/oceanFoam.ts` と同じ）
 */
const wgsl = (code: string, includes: unknown[] = []) => wgslFn(code, includes as never)

const pcgHash = wgsl(`
fn clPcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}`)

const hashGrad = wgsl(
  `
fn clHashGrad(i: vec2i) -> vec2f {
  let h = clPcgHash(u32(i.x) * 1664525u + clPcgHash(u32(i.y) + 1013904223u));
  let a = f32(h) * (6.28318530718 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}`,
  [pcgHash],
)

const gnoise = wgsl(
  `
fn clGnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(clHashGrad(i), f);
  let b = dot(clHashGrad(i + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(clHashGrad(i + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(clHashGrad(i + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`,
  [hashGrad],
)

const cloudFbm = wgsl(
  `
fn clFbm(p: vec2f, fp: f32, oct: i32, billow: f32) -> f32 {
  let rot = mat2x2f(0.8, 0.6, -0.6, 0.8);
  var s = 0.0;
  var a = 0.5;
  var q = p;
  var f = 1.0;
  for (var i = 0; i < oct; i++) {
    let w = 1.0 - smoothstep(0.08, 0.28, fp * f);
    var n = clGnoise(q);
    if (i >= 2) { n = mix(n, abs(n) * 2.0 - 0.38, billow); }
    s += a * n * w;
    q = rot * q * 2.03 + vec2f(13.1, 7.7);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}`,
  [gnoise],
)

const lowEdge = wgsl(
  `
fn clLowEdge(q: vec2f, fp: f32, oct: i32, coverage: f32, t: f32) -> f32 {
  var p = q * 0.38 + vec2f(t * 0.004, t * 0.0012);
  let w = vec2f(clGnoise(p * 0.3 + vec2f(1.7, 9.2)), clGnoise(p * 0.3 + vec2f(8.3, 2.8)));
  p += w * 1.4;
  let base = clFbm(p * vec2f(1.0, 1.7), fp * 0.65, oct, 0.35) * 1.3 + 0.5;
  let large = clGnoise(q * 0.05 + vec2f(3.1, 1.3)) * 0.7;
  return base + large - (1.0 - coverage);
}`,
  [gnoise, cloudFbm],
)

const lowDensity = wgsl(
  `
fn clLowDensity(q: vec2f, fp: f32, oct: i32, coverage: f32, t: f32) -> f32 {
  let soft = 0.38 + min(fp * 0.65, 1.0) * 0.3;
  return clamp(clLowEdge(q, fp, oct, coverage, t) / soft, 0.0, 1.0);
}`,
  [lowEdge],
)

const highEdge = wgsl(
  `
fn clHighEdge(q: vec2f, fp: f32, oct: i32, veil: f32, t: f32) -> f32 {
  let rot = mat2x2f(0.8, 0.6, -0.6, 0.8);
  let p = rot * (q * vec2f(0.09, 0.20)) + vec2f(t * 0.0015, 0.0);
  let n = clFbm(p, fp * 0.2, oct, 0.0) * 1.25 + 0.5;
  let big = clGnoise(q * 0.012 + vec2f(7.0, 3.0)) * 0.6;
  return n + big - (1.0 - veil);
}`,
  [gnoise, cloudFbm],
)

const highDensity = wgsl(
  `
fn clHighDensity(q: vec2f, fp: f32, oct: i32, veil: f32, t: f32) -> f32 {
  let soft = 0.85 + min(fp * 0.2, 1.0) * 0.3;
  return clamp(clHighEdge(q, fp, oct, veil, t) / soft, 0.0, 1.0);
}`,
  [highEdge],
)

type Fn5 = (q: unknown, fp: unknown, oct: unknown, cov: unknown, t: unknown) => N<'float'>
const call = (f: unknown) => f as unknown as Fn5

/** 自己診断が点で突き合わせるための口。CPU 参照の同じ名前の関数と 1 対 1 */
export const cloudLayerProbeFunctions = {
  gnoise: (p: N<'vec2'>) => (gnoise as unknown as (p: unknown) => N<'float'>)(p),
  lowEdge: (q: N<'vec2'>, fp: N<'float'>, oct: number, cov: N<'float'>, t: N<'float'>) => call(lowEdge)(q, fp, int(oct), cov, t),
  highEdge: (q: N<'vec2'>, fp: N<'float'>, oct: number, veil: N<'float'>, t: N<'float'>) => call(highEdge)(q, fp, int(oct), veil, t),
}

/** Henyey-Greenstein の位相関数（web-ocean の `phaseHG`） */
const phaseHG = (c: N<'float'>, g: number) => {
  const g2 = g * g
  return float((1 - g2) / (4 * Math.PI)).div(pow(max(float(1 + g2).sub(c.mul(2 * g)), 1e-4), 1.5)) as unknown as N<'float'>
}

/** 層の雲が読む光とカメラ */
export interface CloudLayerInputs {
  /** 霞と同じカメラの値（`sky/skyNodes.ts` の `AerialInputs`） */
  view: {
    altitude: N<'float'>
    sunDir: N<'vec3'>
    projectionInverse: N<'mat4'>
    cameraWorld: N<'mat4'>
  }
  /** 向き dir の空の放射輝度（広がり rad でミップを選ぶ） */
  skyRadiance(dir: N<'vec3'>, spread?: N<'float'>): N<'vec3'>
  /** 高さ world.y の太陽の照度（余弦を含まない） */
  sunIlluminance(world: N<'vec3'>): N<'vec3'>
  /** 品質表の `cloudLayerOctaves`。積雲の縁の段の数で、ほかはここから決める */
  octaves: number
}

export interface CloudLayers {
  /** 前乗算の色（rgb, 隠す割合）。`depth` は場面の深度バッファの値、`screen` は画面の uv */
  node(depth: N<'float'>, screen: N<'vec2'>): N<'vec4'>
  /** ワールドの点から太陽へ向かう線が層を横切るときの透過率（海と機体の雲の影） */
  sunTransmittance(world: N<'vec3'>): N<'float'>
  /** 毎フレーム。雲量・風の時刻 s・カメラの位置 m・1 画素の角度 rad */
  update(coverage: number, time: number, camera: Vector3, pixelAngle: number): void
  /** 品質表の `cloudLayerOctaves` が変わった */
  setOctaves(octaves: number): void
}

/** 雲の影は積雲の縁より何段減らして引くか（影は大きく、細かい段は効かない） */
export const CLOUD_SHADOW_OCTAVE_DROP = 3

/** 画面の uv から視線の向き（`skyNodes.ts` の `screenRayNode` と同じ約束） */
const screenRay = (screen: N<'vec2'>, view: CloudLayerInputs['view']) => {
  const p = getViewPosition(screen as never, float(0.5) as never, view.projectionInverse as never)
  const v = normalize(p as unknown as N<'vec3'>) as unknown as N<'vec3'>
  return normalize(view.cameraWorld.mul(vec4(v, 0)).xyz) as unknown as N<'vec3'>
}

export function createCloudLayers(inputs: CloudLayerInputs): CloudLayers {
  const coverage = uniform(0)
  const veil = uniform(0)
  const time = uniform(0)
  const pixelAngle = uniform(0.001)
  const cameraXZ = uniform(vec2(0, 0))
  // 段の数は uniform にして、品質が変わったら値だけ入れ替える（`setOctaves`）
  const octaves = (uniform as unknown as (v: number, t: string) => { value: number; sub(k: number): N<'int'> })(
    inputs.octaves,
    'int',
  )
  /** 段の数から k 段減らした値（1 段より下げない） */
  const O = (k: number) => max(octaves.sub(k) as never, int(1) as never) as unknown as N<'int'>
  const { view } = inputs
  const sunDir = view.sunDir
  const alt = view.altitude

  /** 1 枚の層の色と隠す割合と距離 km。層に当たらなければ a = 0、距離は大きい値 */
  const layer = (
    dir: N<'vec3'>,
    sceneKm: N<'float'>,
    hc: number,
    sigma: number,
    g: number,
    high: boolean,
  ) =>
    Fn(() => {
      const out = vec4(0, 0, 0, 0).toVar()
      const tHit = float(1e9).toVar()
      const r0 = alt.add(GROUND_RADIUS).toVar()
      const R = GROUND_RADIUS + hc
      // 球との交点（web-ocean の `raySphere`）。原点は地球の中心、カメラは真上
      const b = r0.mul(dir.y).toVar()
      const c = r0.sub(R).mul(r0.add(R))
      const disc = b.mul(b).sub(c).toVar()
      const above = alt.greaterThan(hc)
      If(disc.greaterThan(0), () => {
        const s = sqrt(disc)
        // 下からは上向きの視線の遠い方の交点、上からは下向きの視線の近い方の交点
        If(above.not().and(dir.y.greaterThan(0)), () => {
          tHit.assign(b.negate().add(s))
        }).ElseIf(above.and(b.negate().sub(s).greaterThan(0)), () => {
          tHit.assign(b.negate().sub(s))
        })
      })
      const farLimit = high ? [30, 70] : [18, 36]
      If(tHit.lessThan(farLimit[1]!).and(tHit.lessThan(sceneKm)), () => {
        const p = vec3(dir.x.mul(tHit), r0.add(dir.y.mul(tHit)), dir.z.mul(tHit)).toVar()
        const up = p.div(length(p)).toVar()
        const q = p.xz.add(cameraXZ).toVar() as unknown as N<'vec2'>
        const mu = max(abs(dot(up, dir)), 0.03).toVar()
        // 水平線の手前の晴れ間（低い太陽が雲の下から差す）
        const far = float(1).sub(smoothstep(farLimit[0]!, farLimit[1]!, tHit)).toVar()
        const fp = tHit.mul(pixelAngle).div(mu).toVar()
        const amount = (high ? veil : coverage) as unknown as N<'float'>
        const density = (dq: N<'vec2'>, k: number) => call(high ? highDensity : lowDensity)(dq, fp, O(k), amount, time)
        const e = call(high ? highEdge : lowEdge)(q, fp, O(high ? 1 : 0), amount, time).toVar()
        const soft = high ? float(0.85).add(min(fp.mul(0.2), 1).mul(0.3)) : float(0.38).add(min(fp.mul(0.65), 1).mul(0.3))
        const d = clamp(e.div(soft), 0, 1).mul(far).toVar()
        If(d.greaterThan(0.002), () => {
          const sxz = sunDir.xz.div(max(length(sunDir.xz), 1e-4)).toVar()
          const s1 = density(q.add(sxz.mul(high ? 0.15 : 0.08)) as never, high ? 3 : 2).mul(far).toVar()
          const s2 = density(q.add(sxz.mul(high ? 0.5 : 0.25)) as never, high ? 4 : 3).mul(far).toVar()
          const s3 = high ? s2 : density(q.add(sxz.mul(0.6)) as never, 4).mul(far).toVar()
          const tau = d.mul(sigma).div(mu).toVar()
          const alpha = float(1).sub(exp(tau.negate())).toVar()
          const sunC = inputs.sunIlluminance(vec3(0, hc * 1000, 0) as unknown as N<'vec3'>).toVar()
          const cosT = dot(dir, sunDir).toVar()
          const ph = mix(phaseHG(cosT, g), phaseHG(cosT, -0.2), 0.25)
          const rim = clamp(d.sub(s1).mul(2.5), 0, 1)
          const skyUp = inputs.skyRadiance(vec3(0, 1, 0) as unknown as N<'vec3'>, float(Math.PI / 2))
          const color = vec3(0, 0, 0).toVar()
          If(above, () => {
            // 上から（新しく作った）。太陽の当たる上面を見る。上面の自己影は薄い（推測）
            const tsTop = exp(s1.mul(0.3).add(s2.mul(0.15)).mul(sigma * 0.55).negate())
            const single = sunC.mul(tsTop).mul(ph).mul(alpha).mul(0.55 * 3).mul(sunDir.y.greaterThan(0).select(float(1), float(0)))
            const ms = sunC.mul(rim.mul(0.22).add(0.06)).mul(alpha)
            const horizon = inputs.skyRadiance(normalize(vec3(dir.x, 0.03, dir.z)) as unknown as N<'vec3'>)
            const amb = skyUp.mul(0.6).add(horizon.mul(0.2)).mul(alpha)
            color.assign(single.add(ms).add(amb))
          }).Else(() => {
            // 下から（web-ocean の `shadeLayer`）
            const tauS = d.mul(0.5).add(s1.mul(0.6)).add(s2).add(s3.mul(0.7)).mul(sigma * 0.55)
            const Ts = exp(tauS.negate()).toVar()
            const fwd = smoothstep(-0.2, 0.7, cosT)
            const single = sunC.mul(Ts).mul(ph).mul(mix(alpha.mul(0.55), tau.mul(exp(tau.negate())).mul(2.2), fwd)).mul(3)
            const toward = smoothstep(-0.3, 0.9, cosT)
            const ms = sunC
              .mul(rim.mul(0.22).add(0.025))
              .mul(mix(float(1), Ts, 0.5))
              .mul(alpha)
              .mul(toward.mul(0.75).add(0.25))
            const horizon = inputs.skyRadiance(normalize(vec3(dir.x, 0.03, dir.z)) as unknown as N<'vec3'>)
            const amb = horizon.mul(0.26).add(skyUp.mul(0.42)).mul(alpha).mul(float(1).sub(d.mul(0.35)))
            color.assign(single.add(ms).add(amb))
          })
          // 縁のアンチエイリアス。画素の大きさから見積もる（web-ocean の `aa` が負のときの式）
          const aw = fp.mul(high ? 0.2 * 2.5 : 0.38 * 2.5)
          const edgeAa = smoothstep(0, aw.mul(1.5).add(1e-6), e)
          // 層を抜ける前後 100 m は薄くする（推測）
          const crossing = clamp(abs(alt.sub(hc)).div(0.1), 0, 1)
          // 霞の中へ溶かす（web-ocean の `loVis`・`hiVis`。この作品の霞の濃さ 1 で）
          const vis = exp(tHit.mul(high ? -0.01 : -0.02))
          const k = edgeAa.mul(crossing).mul(vis)
          out.assign(vec4(color.mul(k), alpha.mul(k)))
        })
      })
      return out
    })() as unknown as N<'vec4'>

  /** 層までの距離 km（前後を決めるため。当たらなければ大きい値） */
  const hitDistance = (dir: N<'vec3'>, hc: number) =>
    Fn(() => {
      const r0 = alt.add(GROUND_RADIUS)
      const R = GROUND_RADIUS + hc
      const b = r0.mul(dir.y).toVar()
      const disc = b.mul(b).sub(r0.sub(R).mul(r0.add(R))).toVar()
      const t = float(1e9).toVar()
      If(disc.greaterThan(0), () => {
        const s = sqrt(disc)
        If(alt.lessThan(hc).and(dir.y.greaterThan(0)), () => {
          t.assign(b.negate().add(s))
        }).ElseIf(alt.greaterThanEqual(hc).and(b.negate().sub(s).greaterThan(0)), () => {
          t.assign(b.negate().sub(s))
        })
      })
      return t
    })() as unknown as N<'float'>

  return {
    node(depth, screen) {
      return Fn(() => {
        const dir = screenRay(screen, view).toVar()
        // 場面の物までの距離 km。空の画素（深度 1）は無限
        const sceneKm = float(1e9).toVar()
        If(depth.lessThan(1), () => {
          sceneKm.assign(length(getViewPosition(screen as never, depth as never, view.projectionInverse as never)).div(1000))
        })
        const lo = layer(dir, sceneKm, LOW_LAYER_ALTITUDE, LOW_LAYER_SIGMA, 0.75, false).toVar()
        const hi = layer(dir, sceneKm, HIGH_LAYER_ALTITUDE, HIGH_LAYER_SIGMA, 0.8, true).toVar()
        // 手前の層を奥の層の上に重ねる
        const loFirst = hitDistance(dir, LOW_LAYER_ALTITUDE).lessThan(hitDistance(dir, HIGH_LAYER_ALTITUDE))
        const front = loFirst.select(lo, hi).toVar()
        const back = loFirst.select(hi, lo).toVar()
        return vec4(front.rgb.add(back.rgb.mul(float(1).sub(front.a))), front.a.add(back.a.mul(float(1).sub(front.a))))
      })() as unknown as N<'vec4'>
    },
    sunTransmittance(world) {
      return Fn(() => {
        const tau = float(0).toVar()
        const h = max(world.y, 0).div(1000).toVar()
        If(sunDir.y.greaterThan(0.01), () => {
          for (const [hc, sigma, high] of [
            [LOW_LAYER_ALTITUDE, LOW_LAYER_SIGMA, false],
            [HIGH_LAYER_ALTITUDE, HIGH_LAYER_SIGMA, true],
          ] as const) {
            If(h.lessThan(hc), () => {
              const s = float(hc).sub(h).div(sunDir.y)
              const q = world.xz.div(1000).add(sunDir.xz.mul(s)) as unknown as N<'vec2'>
              const d = call(high ? highDensity : lowDensity)(q, float(0), O(CLOUD_SHADOW_OCTAVE_DROP), high ? veil : coverage, time)
              tau.addAssign(d.mul(sigma).div(sunDir.y))
            })
          }
        })
        return exp(tau.negate())
      })() as unknown as N<'float'>
    },
    setOctaves(n) {
      octaves.value = n
    },
    update(c, t, camera, pa) {
      coverage.value = c
      veil.value = veilFor(c)
      time.value = t
      pixelAngle.value = pa
      ;(cameraXZ.value as { set(x: number, y: number): void }).set(camera.x / 1000, camera.z / 1000)
    },
  }
}
