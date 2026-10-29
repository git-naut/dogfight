import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  type Vector3,
} from 'three'
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  clamp,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  fwidth,
  instanceIndex,
  instancedArray,
  int,
  length,
  log2,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  reflect,
  smoothstep,
  sqrt,
  step,
  texture,
  uint,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  MeshBasicNodeMaterial,
  type ComputeNode,
  type Node,
  type Renderer,
  type StorageArrayTexture,
  type StorageTexture,
} from 'three/webgpu'
import { createUnitGrid } from '../terrain/terrainMesh'
import { createLayeredMips, createLayeredTexture } from './oceanMips'
import { FOAM_LEVEL_SIZES, createFoamPattern, createOceanFoam } from './oceanFoam'
import { createCalmNodes, type CalmNodes } from './oceanCalmNodes'
import type { CarrierPose } from './oceanCalm'
import { FIXED_DT } from '../../sim/loop'
import { createOceanSimulation, type OceanSimulation } from './oceanNodes'
import {
  OCEAN_EDGE_FADE,
  OCEAN_LOD_BIAS,
  OCEAN_PATCH_CELLS,
  oceanCoverage,
  oceanRootSize,
  oceanUvOffset,
  selectOceanPatches,
  type OceanPatch,
} from './oceanLayout'
import { OCEAN_LOOP_TICKS, oceanParamsFor, type OceanSpectrumParams } from './reference'
import type { QualitySettings } from '../quality'

/**
 * FFT の海面（段 S4a-1、`?ocean=1` の裏）。
 *
 * 1. FFT の出力（32 ビットの記憶域）を、ミップ付きの配列テクスチャ 2 枚へ写す（`createOceanTextures`）。
 *    16 ビットと 32 ビットを `?oceantex=` で切り替え、絵と費用を比べる
 * 2. カメラを中心にした CDLOD（`oceanLayout.ts`）を 1 回の描画で敷き、頂点で変位を足す。
 *    頂点の間隔に合わせてミップの段を選ぶ（web-ocean の `OCEAN` の頂点シェーダ）
 * 3. 変位のある範囲の外は、高さ 0 の板が同じ陰影で水平線まで覆う。板は範囲の内側を描かない
 * 4. 陰影は web-ocean の `OCEAN` の画素シェーダから、空の映り込み（フレネル）・太陽・水の色だけを
 *    移した。光は自前の空（`sky/hillaireSky.ts`）から。LEAN・きらめき・泡は段 S4a-2、浅瀬と
 *    空母は段 S4a-3
 *
 * 霞は掛けない。場面の合成（`nodeOutput.ts`）が深度から掛ける（今の板の海と同じ）。
 */

type N<T extends string> = Node<T>

/** テクスチャの精度。16 ビット（rgba16float）か 32 ビット（rgba32float） */
export type OceanTexturePrecision = 16 | 32

/** インスタンスの上限。実測でパッチは high 531・ultra 684 枚（高度 2.5 m、`oceanLayout.test.ts`） */
const MAX_PATCHES = 1024

/** キャプチャで泡を作るために前から回す回数と刻み（S4a-2 の合意: 4 フレーム刻みで 16 回） */
export const FOAM_WARMUP_STEPS = 16
export const FOAM_WARMUP_STRIDE = 4
/** 刻みがこれより飛んだら前から回し直す（0.25 秒）。ライブの 1 フレームは 1〜4 刻み */
const FOAM_WARMUP_JUMP = 30
/** ライブで泡を一度に進める上限 s（web-ocean の 0.1） */
const MAX_FOAM_DT = 0.1

/** 板の一辺 m。今の板の海（`terrain/water.ts`）と同じ */
const PLATE_EXTENT = 300_000

/**
 * 板が描かない範囲の縁の重ね m。CDLOD の外周のパッチは T 字の継ぎ目で板と画素未満の
 * 隙間を作りうるので、板を少しだけ内へ入れて重ねる。重なりでは変位がほぼ 0（`oceanEdgeFade`
 * が縁で 0）で、両方とも同じ陰影なので深度の競合は見えない（推測。絵で確かめる）
 */
const PLATE_OVERLAP = 2

// ---- web-ocean の水の値（`ocean.html` の `f[76..83]`）----
/** 水中から戻る散乱の色の元（web-ocean の `waterCol.rgb` は (0.016, 0.080, 0.096) × 濁り） */
const WATER_BODY_BASE: readonly [number, number, number] = [0.016, 0.08, 0.096]
/** 濁りの既定（web-ocean の `P.turbidity`、沿岸の値）。外洋の値は S4b の絵の承認で選ぶ（S4a-3 の合意） */
export const OCEAN_TURBIDITY = 1.6
/** 解けない細かい傾きの分散（web-ocean の `waterCol.w`） */
const UNRESOLVED_SLOPE_VARIANCE = 0.0024
/** 波頭の透過光の色と強さ（web-ocean の `sssCol`） */
const SSS_COLOR: readonly [number, number, number] = [0.035, 0.12, 0.085]
const SSS_STRENGTH = 2.6
/** その場の J から出す泡（web-ocean の `foamP`、泡の強さ 1） */
const FOAM_FRESH_THRESHOLD = 0.48
const FOAM_FRESH_GAIN = 2.5
const FOAM_COVER = 1

export interface OceanTextures {
  /** (Dx, Dy, Dz, jxz) */
  readonly displacement: StorageArrayTexture
  /** (sx, sz, jxx, jzz) */
  readonly derivatives: StorageArrayTexture
  /** LEAN のモーメント (sx², sz², sx·sz, 0)。ミップは積のまま平均する（`oceanMips.ts`） */
  readonly moments: StorageArrayTexture
  readonly precision: OceanTexturePrecision
  /** 写してミップを作る。海を解いたあとに呼ぶ */
  update(renderer: Renderer): void
  dispose(): void
}

/**
 * 画素シェーダで引くテクスチャの異方性フィルタの上限。海面は水平線へ向けて斜めに見るので、
 * 等方のミップでは遠くの傾きが潰れる（web-ocean の `sampRepeat` と同じ 16）
 */
const OCEAN_ANISOTROPY = 16

/** FFT の出力を写す配列テクスチャ。層がカスケード */
export function createOceanTextures(
  sim: OceanSimulation,
  precision: OceanTexturePrecision,
  anisotropy = OCEAN_ANISOTROPY,
): OceanTextures {
  const N = sim.size
  const C = sim.cascades
  const displacement = createLayeredTexture(N, C, precision, 'OceanDisplacement')
  const derivatives = createLayeredTexture(N, C, precision, 'OceanDerivatives', anisotropy)
  const moments = createLayeredTexture(N, C, precision, 'OceanMoments', anisotropy)
  const chain = createLayeredMips(
    N,
    C,
    [
      { source: sim.displacement, texture: displacement },
      { source: sim.derivatives, texture: derivatives },
      {
        source: sim.derivatives,
        texture: moments,
        map: (d) => vec4(d.x.mul(d.x), d.y.mul(d.y), d.x.mul(d.y), 0) as unknown as N<'vec4'>,
      },
    ],
    'Ocean',
  )
  return {
    displacement,
    derivatives,
    moments,
    precision,
    update(renderer) {
      chain.update(renderer)
    },
    dispose() {
      displacement.dispose()
      derivatives.dispose()
      moments.dispose()
      chain.dispose()
    },
  }
}

/** カスケードを引く道具。uv の起点（覆う範囲の角）と、その端数を持つ */
export interface OceanSampler {
  readonly params: OceanSpectrumParams
  /** カスケード c を xz で引く。lod を渡せばその段、渡さなければ画面の微分から（画素シェーダ） */
  cascade(textureOf: StorageArrayTexture, c: number, xz: N<'vec2'>, lod?: N<'float'>): N<'vec4'>
  /**
   * 勾配を明示して引く（`gx`・`gy` は xz の画面の微分、m）。分岐の中で引くときに使う。WGSL は
   * 暗黙の微分で引くことを一様でない分岐の中で許さない
   */
  cascadeGrad(textureOf: StorageArrayTexture, c: number, xz: N<'vec2'>, gx: N<'vec2'>, gy: N<'vec2'>): N<'vec4'>
  /** 最後の段（1 × 1、場全体の平均） */
  cascadeTop(textureOf: StorageArrayTexture, c: number): N<'vec4'>
  /** 頂点の間隔 cell m の変位 (Dx, Dy, Dz)。粗すぎるカスケードは足さない */
  displacement(textures: OceanTextures, xz: N<'vec2'>, cell: N<'float'>): N<'vec3'>
  /** 頂点の間隔からカスケード c の段（`oceanCascadeLod`） */
  lod(c: number, cell: N<'float'>): N<'float'>
  /** uv の起点を置き直す。端数は倍精度で求めて渡す */
  setOrigin(x: number, z: number): void
}

export function createOceanSampler(params: OceanSpectrumParams): OceanSampler {
  const Nn = params.size
  const origin = uniform(vec2(0, 0))
  const offX = params.cascades.map(() => uniform(0))
  const offZ = params.cascades.map(() => uniform(0))
  const logN = Math.log2(Nn)

  const sampler: OceanSampler = {
    params,
    cascade(textureOf, c, xz, lod) {
      const L = params.cascades[c]!
      const uv = xz
        .sub(origin as unknown as N<'vec2'>)
        .div(L)
        .add(vec2(offX[c]!, offZ[c]!))
        .add(0.5 / Nn) as unknown as N<'vec2'>
      const t = (texture(textureOf, uv) as unknown as { depth(d: unknown): { level(l: unknown): unknown } }).depth(int(c))
      return (lod === undefined ? t : t.level(lod)) as unknown as N<'vec4'>
    },
    cascadeGrad(textureOf, c, xz, gx, gy) {
      const L = params.cascades[c]!
      const t = sampler.cascade(textureOf, c, xz) as unknown as { grad(x: unknown, y: unknown): unknown }
      return t.grad(gx.div(L), gy.div(L)) as unknown as N<'vec4'>
    },
    cascadeTop(textureOf, c) {
      const t = texture(textureOf, vec2(0.5, 0.5)) as unknown as { depth(d: unknown): { level(l: unknown): unknown } }
      return t.depth(int(c)).level(float(logN)) as unknown as N<'vec4'>
    },
    lod(c, cell) {
      const texel = params.cascades[c]! / Nn
      return log2(max(cell.div(texel), 1)).add(OCEAN_LOD_BIAS) as unknown as N<'float'>
    },
    displacement(textures, xz, cell) {
      return Fn(() => {
        const sum = vec3(0, 0, 0).toVar()
        for (let c = 0; c < params.cascades.length; c++) {
          const lod = sampler.lod(c, cell).toVar()
          // 1 × 1 の段は平均 0（`oceanCascadeSkipped`）
          If(lod.lessThan(logN), () => {
            sum.addAssign(sampler.cascade(textures.displacement, c, xz, lod as unknown as N<'float'>).xyz)
          })
        }
        return sum
      })() as unknown as N<'vec3'>
    },
    setOrigin(x, z) {
      ;(origin.value as { set(x: number, y: number): void }).set(x, z)
      for (let c = 0; c < params.cascades.length; c++) {
        offX[c]!.value = oceanUvOffset(x, params.cascades[c]!)
        offZ[c]!.value = oceanUvOffset(z, params.cascades[c]!)
      }
    },
  }
  return sampler
}

/** 海面の陰影の入力。光は自前の空から */
export interface OceanLighting {
  /** 向き dir の空の放射輝度。`spread` は映り込みの広がり rad（`HillaireSky.radiance`） */
  skyRadiance(dir: N<'vec3'>, spread?: N<'float'>): N<'vec3'>
  /** 余弦を含まない太陽の照度（`scalarIlluminance(world).get('direct')`） */
  sunIlluminance(world: N<'vec3'>): N<'vec3'>
  /** 上向きの面の天空の照度（`scalarIlluminance(world).get('indirect')`） */
  skyIlluminance(world: N<'vec3'>): N<'vec3'>
  sunDirection: N<'vec3'>
  /** 太陽の光の遮り 0..1（雲影 × 機体の影）。今の板の海と同じもの */
  sunShade(world: N<'vec3'>): N<'float'>
  /** 主カメラのワールド位置（`morphOrigin`）。組み込みの `cameraPosition` は読まない */
  camera: N<'vec3'>
}

/** 海面が読む泡（`oceanFoam.ts`） */
/** 陰影の設定。軽くする手（段 S4a-2）と、空母のまわりの凪・水の濁り（段 S4a-3） */
export interface OceanShadeOptions {
  /** 空母のまわりの凪（`oceanCalmNodes.ts`）。傾きに s、モーメントに s² を掛ける */
  calm: CalmNodes
  /** 水の濁り（水中から戻る散乱の色の倍率） */
  turbidity: number
  /** 遠くで最後の段に届く細かいカスケードを引かず、モーメントの最後の段を 1 回引く */
  skipFar: boolean
  /** 空を引く回数。2 なら天頂の空を上半球の平均で代える */
  skyLookups: 2 | 3
  /** 画素で引くテクスチャの異方性の上限（飛ばす判定に使う） */
  anisotropy: number
}

export interface OceanFoamInputs {
  /** 模様（R 網目・G 細かい網目・B 濃淡・A 筋） */
  pattern: StorageTexture
  /** ワールドのクリップマップ。0 段なら null（瞬間の泡だけ） */
  world: StorageArrayTexture | null
  levels: number
  /** 秒。sim のフレーム番号から（模様の流れと風の斑） */
  time: N<'float'>
  /** 風の向き (cos, sin)。x と z */
  wind: readonly [number, number]
}

/** Schlick、水の F0 = 0.02（web-ocean の `fresnelWater`） */
const fresnelWater = (c: N<'float'>) => {
  const x = float(1).sub(clamp(c, 0, 1))
  const x2 = x.mul(x)
  return float(0.02).add(x2.mul(x2).mul(x).mul(0.98)) as unknown as N<'float'>
}

/** Smith の Λ。傾きの共分散 cov = (σxx, σzz, σxz) の向き w の断面で（web-ocean の `lambdaSmith`） */
const lambdaSmith = (w: N<'vec3'>, cov: N<'vec3'>) =>
  Fn(() => {
    const xz2 = max(dot(w.xz, w.xz), 1e-8).toVar()
    const il = float(1).div(sqrt(xz2)).toVar()
    const az = w.xz.mul(il).toVar()
    const sig2 = az.x.mul(az.x).mul(cov.x).add(az.y.mul(az.y).mul(cov.y)).add(az.x.mul(az.y).mul(cov.z).mul(2))
    const cotT = w.y.mul(il)
    const a = max(cotT, 1e-3).div(sqrt(max(sig2, 1e-7).mul(2))).toVar()
    const out = float(0).toVar()
    If(a.lessThan(1.6), () => {
      out.assign(float(1).sub(a.mul(1.259)).add(a.mul(a).mul(0.396)).div(a.mul(3.535).add(a.mul(a).mul(2.181))))
    })
    return out
  })() as unknown as N<'float'>

/** 泡の模様（web-ocean の `foamPattern`） */
const foamPattern = (pattern: StorageTexture, xz: N<'vec2'>, t: N<'float'>) => {
  const a = texture(pattern, xz.mul(0.23).add(vec2(0.013, 0).mul(t))).r
  const b = texture(pattern, xz.mul(0.71).add(vec2(0.37, 0.71))).g
  return a.mul(0.78).add(b.mul(0.22)) as unknown as N<'float'>
}

/**
 * 海面の色（霞の前）。web-ocean の `OCEAN` の画素シェーダの写し。光は自前の空から、霞は場面の
 * 合成が掛ける。環境キューブの代わりに空の見え方の LUT を広がりのミップで引く。
 *
 * @param xz     変位の前の xz（ラグランジュの座標）。傾き・モーメント・泡はここで引く
 * @param world  描く点のワールド座標（変位の後）
 * @param height 変位の高さ（波頭の透過光）。板は 0
 */
export function oceanShadeNode(
  sampler: OceanSampler,
  textures: OceanTextures,
  foam: OceanFoamInputs,
  lighting: OceanLighting,
  xz: N<'vec2'>,
  world: N<'vec3'>,
  height: N<'float'>,
  shade: OceanShadeOptions = {
    calm: createCalmNodes(null),
    turbidity: OCEAN_TURBIDITY,
    skipFar: false,
    skyLookups: 3,
    anisotropy: OCEAN_ANISOTROPY,
  },
): N<'vec4'> {
  return Fn(() => {
    const [wx, wz] = foam.wind
    // 風の斑（短い波が強い所と凪いだ所、web-ocean の cat's paws）
    const gustN = texture(foam.pattern, xz.mul(0.011).add(vec2(wx, wz).mul(foam.time.mul(0.0004)))).b
    const gust = mix(0.35, 1.2, smoothstep(0.3, 0.72, gustN)).toVar()

    // 傾き・ヤコビアン・LEAN の共分散。画素の微分でミップを選ぶ
    const s = vec2(0, 0).toVar()
    const jxx = float(0).toVar()
    const jzz = float(0).toVar()
    const jxz = float(0).toVar()
    const cov = vec3(0, 0, 0).toVar()
    const Nn = sampler.params.size
    const logN = Math.log2(Nn)
    // 画面の微分は分岐の外で（一様な制御の中で）求める
    const gx = dFdx(xz).toVar() as unknown as N<'vec2'>
    const gy = dFdy(xz).toVar() as unknown as N<'vec2'>
    const footMajor = max(length(gx), length(gy)).toVar()
    const footMinor = min(length(gx), length(gy)).toVar()
    // 空母のまわりの凪。変位と傾きに s、モーメントに s²（gk に掛けておけば両方に効く）
    const calm = shade.calm.calm(xz).toVar()
    for (let c = 0; c < sampler.params.cascades.length; c++) {
      // 斑は細かいカスケード（c ≥ 3）にだけ掛ける
      const share = c >= 4 ? 1 : c >= 3 ? 0.5 : 0
      const gk = (share === 0 ? calm : mix(float(1), gust, share).mul(calm)) as unknown as N<'float'>
      const accumulate = (dv: N<'vec4'>, mv: N<'vec4'>, av: N<'vec4'>) => {
        s.addAssign(dv.xy)
        jxx.addAssign(dv.z)
        jzz.addAssign(dv.w)
        jxz.addAssign(av.w)
        cov.addAssign(vec3(max(mv.x.sub(dv.x.mul(dv.x)), 0), max(mv.y.sub(dv.y.mul(dv.y)), 0), mv.z.sub(dv.x.mul(dv.y))))
      }
      if (!shade.skipFar) {
        accumulate(
          sampler.cascade(textures.derivatives, c, xz).mul(gk).toVar() as unknown as N<'vec4'>,
          sampler.cascade(textures.moments, c, xz).mul(gk.mul(gk)).toVar() as unknown as N<'vec4'>,
          sampler.cascade(textures.displacement, c, xz).mul(gk) as unknown as N<'vec4'>,
        )
        continue
      }
      // 画素が覆う texel の数から、異方性フィルタが選ぶ段（短い軸か、長い軸 / 異方性の上限）
      const texelsPerMeter = Nn / sampler.params.cascades[c]!
      const lod = log2(max(max(footMajor.div(shade.anisotropy), footMinor).mul(texelsPerMeter), 1e-6))
      If(lod.lessThan(logN - 0.5), () => {
        accumulate(
          sampler.cascadeGrad(textures.derivatives, c, xz, gx, gy).mul(gk).toVar() as unknown as N<'vec4'>,
          sampler.cascadeGrad(textures.moments, c, xz, gx, gy).mul(gk.mul(gk)).toVar() as unknown as N<'vec4'>,
          sampler.cascadeGrad(textures.displacement, c, xz, gx, gy).mul(gk) as unknown as N<'vec4'>,
        )
      }).Else(() => {
        // 傾き・J の横の項は平均 0。モーメントの最後の段（場全体の平均）が分散として残る（LEAN の極限）
        const mv = sampler.cascadeTop(textures.moments, c).mul(gk.mul(gk)).toVar()
        cov.addAssign(vec3(mv.x, mv.y, mv.z))
      })
    }
    const rel = world.sub(lighting.camera).toVar()
    const dist = length(rel).toVar()
    const V = rel.negate().div(max(dist, 1e-3)).toVar()
    const Ld = lighting.sunDirection

    // 解けない細かい傾き。遠くで Cox-Munk 並みの合計へ近づける
    const unres = float(UNRESOLVED_SLOPE_VARIANCE).add(smoothstep(30, 500, dist).mul(0.0035))
    cov.addAssign(vec3(unres, unres, 0))
    const jx = max(jxx.add(1), 0.15)
    const jz = max(jzz.add(1), 0.15)
    const sl = vec2(s.x.div(jx), s.y.div(jz)).toVar()
    const nrm = normalize(vec3(sl.x.negate(), 1, sl.y.negate())).toVar()
    // 鏡面の折り返しを抑える。画素の中の傾きの変化でローブを広げる
    const dsx = dFdx(sl).toVar()
    const dsy = dFdy(sl).toVar()
    const aa = vec3(
      dsx.x.mul(dsx.x).add(dsy.x.mul(dsy.x)),
      dsx.y.mul(dsx.y).add(dsy.y.mul(dsy.y)),
      dsx.x.mul(dsx.y).add(dsy.x.mul(dsy.y)),
    )
      .mul(0.5)
      .toVar()
    cov.addAssign(aa.mul(min(1, float(0.03).div(max(max(aa.x, aa.y), 1e-8)))))
    const J = jxx.add(1).mul(jzz.add(1)).sub(jxz.mul(jxz)).toVar()

    const sunE = lighting.sunIlluminance(world).mul(lighting.sunShade(world)).toVar()
    // 上半球の平均の放射輝度。web-ocean は環境キューブの 5 点、ここは天空の照度を π で割る
    const skyHemi = lighting.skyIlluminance(world).mul(1 / Math.PI).toVar()
    // 天頂と法線の向きの空（web-ocean はキューブの最も粗い段とその 1 つ上）
    // 2 回にするときは、天頂の空を上半球の平均で代える（どちらも画素に依らず滑らか）
    const skyUp = (
      shade.skyLookups === 3 ? lighting.skyRadiance(vec3(0, 1, 0) as unknown as N<'vec3'>, float(Math.PI / 2)) : skyHemi
    ).toVar()
    const skyN = lighting
      .skyRadiance(normalize(vec3(nrm.x, max(nrm.y, 0.05), nrm.z)) as unknown as N<'vec3'>, float(Math.PI / 4))
      .toVar()

    // ---- 太陽のきらめき。傾きの異方のガウス分布 ----
    const Hv = normalize(V.add(Ld)).toVar()
    const hs = Hv.xz.negate().div(max(Hv.y, 1e-3))
    const dsl = hs.sub(sl).toVar()
    const det = max(cov.x.mul(cov.y).sub(cov.z.mul(cov.z)), 1e-10).toVar()
    const e = dsl.x
      .mul(dsl.x)
      .mul(cov.y)
      .add(dsl.y.mul(dsl.y).mul(cov.x))
      .sub(dsl.x.mul(dsl.y).mul(cov.z).mul(2))
      .div(det)
    const pdf = exp(e.mul(-0.5)).div(sqrt(det).mul(2 * Math.PI))
    const hy2 = Hv.y.mul(Hv.y)
    const Dm = pdf.div(max(hy2.mul(hy2), 1e-6))
    const covN = cov as unknown as N<'vec3'>
    const G = float(1).div(float(1).add(lambdaSmith(V, covN)).add(lambdaSmith(Ld, covN)))
    const Fh = fresnelWater(dot(V, Hv))
    const spec = sunE.mul(Fh.mul(Dm).mul(G).div(max(V.y, 0.02).mul(4))).mul(step(0, Ld.y)).toVar()

    // ---- 空の映り込み ----
    // すれすれに見ると、見える面は見る側へ傾いた面に偏り、高く灰色の空を映す
    const sig = sqrt(max(cov.x.add(cov.y), 1e-6).mul(0.5)).toVar()
    const vh = normalize(vec3(V.x, 0, V.z).add(vec3(1e-5, 0, 0))).toVar()
    const sigV = sqrt(
      max(vh.x.mul(vh.x).mul(cov.x).add(vh.z.mul(vh.z).mul(cov.y)).add(vh.x.mul(vh.z).mul(cov.z).mul(2)), 1e-6),
    ).toVar()
    const aV = max(V.y, 1e-3).div(max(sqrt(float(1).sub(V.y.mul(V.y))), 1e-3)).div(sigV.mul(1.4142))
    const tilt = sigV.mul(0.32).mul(float(1).sub(smoothstep(0, 2.5, aV)))
    const nV = normalize(nrm.add(vh.mul(tilt))).toVar()
    const R = reflect(V.negate(), nV).toVar()
    const Ry = abs(R.y).mul(0.4).add(max(R.y, 0).mul(0.6))
    // 広がりは傾きの標準偏差の 2 倍（web-ocean の `envLod` の `2 * sig`）
    const refl = lighting.skyRadiance(normalize(vec3(R.x, Ry, R.z)) as unknown as N<'vec3'>, sig.mul(2)).toVar()
    const nF = normalize(mix(nrm, vec3(0, 1, 0), 0.45))
    const Fr = fresnelWater(max(dot(nF, V), 0)).toVar()

    // ---- 水中から戻る光と、逆光の波頭の透過光 ----
    const ambient = skyUp.mul(1.3).add(skyN.mul(0.5)).toVar()
    const t = shade.turbidity
    const body = vec3(WATER_BODY_BASE[0] * t, WATER_BODY_BASE[1] * t, WATER_BODY_BASE[2] * t)
      .mul(skyHemi.mul(1.6).add(sunE.mul(max(Ld.y, 0)).mul(0.8)))
      .toVar()
    const crest = clamp(height.sub(0.05).div(0.9), 0, 1)
    const toSun = max(dot(Ld, V.negate()), 0)
    const thin = clamp(float(0.5).sub(dot(Ld, nrm).mul(0.5)), 0, 1).pow(3)
    const k1 = float(SSS_STRENGTH).mul(crest).mul(crest).mul(toSun.pow(4)).mul(thin).mul(exp(dist.div(-600)))
    const sss = vec3(SSS_COLOR[0], SSS_COLOR[1], SSS_COLOR[2])
    body.addAssign(sss.mul(sunE).mul(k1))

    // ---- 泡 ----
    // 残る泡はワールドのクリップマップから（近くは細かい段、遠くは粗い段）、その外はその場の J から
    const fwl = vec4(0, 0, 0, 0).toVar()
    const w1 = float(0).toVar()
    if (foam.world !== null && foam.levels > 0) {
      const cheb = max(abs(xz.x.sub(lighting.camera.x)), abs(xz.y.sub(lighting.camera.z))).toVar()
      const S0 = FOAM_LEVEL_SIZES[0]!
      const w0 = float(1).sub(smoothstep(0.3 * S0, 0.45 * S0, cheb)).toVar()
      const fw0 = (texture(foam.world, xz.div(S0)) as unknown as { depth(d: unknown): N<'vec4'> }).depth(int(0))
      if (foam.levels > 1) {
        const S1 = FOAM_LEVEL_SIZES[1]!
        w1.assign(float(1).sub(smoothstep(0.3 * S1, 0.45 * S1, cheb)))
        const fw1 = (texture(foam.world, xz.div(S1)) as unknown as { depth(d: unknown): N<'vec4'> }).depth(int(1))
        fwl.assign(mix(fw1, fw0, w0).mul(w1))
      } else {
        w1.assign(w0)
        fwl.assign(fw0.mul(w0))
      }
    }
    const fresh = clamp(float(FOAM_FRESH_THRESHOLD).sub(J).mul(FOAM_FRESH_GAIN), 0, 1).toVar()
    const cover = clamp(max(fwl.x, fresh.mul(float(1).sub(w1.mul(0.7)))).add(fwl.y.mul(0.6)).mul(FOAM_COVER), 0, 1.5).toVar()
    // 古い泡は風に沿った筋へほどけ、新しい波頭の泡は密なまま
    const ws = vec2(dot(xz, vec2(wx, wz)), dot(xz, vec2(-wz, wx)))
    const streak = texture(foam.pattern, ws.mul(vec2(0.035, 0.11))).a
    const freshK = clamp(fwl.y.mul(2).add(fresh), 0, 1)
    cover.mulAssign(mix(smoothstep(0.25, 0.75, streak).mul(1.5), float(1), freshK))
    const pat = foamPattern(foam.pattern, xz, foam.time).toVar()
    const fw = fwidth(pat).add(0.03)
    // 薄い泡は半透明の膜、濃い泡は縁のはっきりした白
    const soft = float(0.04).add(float(1).sub(clamp(cover, 0, 1)).mul(0.14))
    const fm = smoothstep(float(1).sub(cover).sub(fw).sub(soft), float(1).sub(cover).add(fw).add(soft), pat)
    const foamMask = clamp(fm.mul(smoothstep(0, 0.5, cover)), 0, 1)
      .mul(float(0.68).add(smoothstep(0.3, 0.9, cover).mul(0.32)))
      .toVar()
    foamMask.assign(max(foamMask, smoothstep(0.35, 0.9, fwl.y).mul(smoothstep(0.25, 0.6, pat.add(0.25))).mul(0.95)))
    // 泡の下の水は気泡で明るく色づく
    body.addAssign(sss.mul(sunE.mul(0.05).add(ambient.mul(0.35))).mul(clamp(cover, 0, 1)))
    body.addAssign(vec3(0.1, 0.32, 0.3).mul(skyUp).mul(fwl.y).mul(0.35))
    const bub = texture(foam.pattern, xz.mul(1.9).add(vec2(0.21, 0.53))).g
    const foamAlb = vec3(0.82, 0.87, 0.92).mul(float(0.78).add(bub.mul(0.3)))
    // 泡は半球全体（冷たい天頂を含む）から光を受けるので、色の薄い環境光にする
    const foamAmb = skyHemi.add(skyN.mul(0.3)).toVar()
    const foamAmbN = mix(foamAmb, vec3(dot(foamAmb, vec3(0.2126, 0.7152, 0.0722))), 0.85)
    const foamLit = foamAlb.mul(sunE.mul(max(dot(nrm, Ld), 0)).mul(0.318 * 0.5).add(foamAmbN.mul(1.55)))

    const color = body.mul(float(1).sub(Fr)).add(refl.mul(Fr)).add(spec).toVar()
    color.assign(mix(color, foamLit, foamMask.mul(0.95)))
    return vec4(color, 1)
  })() as unknown as N<'vec4'>
}

export interface OceanSurface {
  /** CDLOD の海面 */
  readonly mesh: Mesh
  /** 外側の板 */
  readonly plate: Mesh
  readonly patchCount: number
  readonly triangleCount: number
  readonly textures: OceanTextures
  readonly simulation: OceanSimulation
  /** 毎フレーム、場面を描く前に呼ぶ。パッチを選び、海を解いてテクスチャへ写す */
  update(renderer: Renderer, camera: Vector3, ticks: number): void
  /** 品質が変わった。カスケード数・格子・精度が変わると作り直す。true なら材質が変わった */
  setQuality(quality: QualitySettings): boolean
  setVisible(visible: boolean): void
  dispose(): void
}

export interface OceanSurfaceOptions {
  quality: QualitySettings
  precision: OceanTexturePrecision
  lighting: OceanLighting
  /** 計測用: 画素で引くテクスチャの異方性の上限（既定は品質表の `oceanAnisotropy`） */
  anisotropy?: number
  /** 計測用: 泡の段数の上書き（既定は品質表の `oceanFoamLevels`） */
  foamLevels?: number
  /** 計測用: 泡のクリップマップの解像度（既定は品質表の `oceanFoamResolution`） */
  foamResolution?: number
  /** 計測用: 遠くの細かいカスケードを飛ばすか（既定 true） */
  skipFar?: boolean
  /** 計測用: 空を引く回数（既定 2） */
  skyLookups?: 2 | 3
  /** 空母の位置と向き。居ない場面では null（凪も喫水線の泡も無い） */
  carrier?: CarrierPose | null
  /** 水の濁り（既定 `OCEAN_TURBIDITY`、`?oceanturbidity=`） */
  turbidity?: number
}

export function createOceanSurface(renderer: Renderer, options: OceanSurfaceOptions): OceanSurface {
  let quality = options.quality
  const lighting = options.lighting

  // ---- CDLOD の格子とインスタンス ----
  const grid = createUnitGrid(OCEAN_PATCH_CELLS)
  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(grid.position, 3))
  geometry.setIndex(new BufferAttribute(grid.index, 1))
  const origins = new Float32Array(MAX_PATCHES * 4)
  const morphs = new Float32Array(MAX_PATCHES * 2)
  const originAttribute = new InstancedBufferAttribute(origins, 4)
  const morphAttribute = new InstancedBufferAttribute(morphs, 2)
  originAttribute.setUsage(DynamicDrawUsage)
  morphAttribute.setUsage(DynamicDrawUsage)
  geometry.setAttribute('oceanPatch', originAttribute)
  geometry.setAttribute('oceanMorph', morphAttribute)

  const plateGeometry = new PlaneGeometry(PLATE_EXTENT, PLATE_EXTENT)

  // 覆う範囲 (x0, z0, 一辺, 根の一辺)。縁で変位を絞り、板はその内側を描かない
  const cover = uniform(vec4(0, 0, 0, 1))

  // 空母のまわりの凪と喫水線の泡。空母は動かないので、作るときに位置を焼き込む
  const calmNodes = createCalmNodes(options.carrier ?? null)

  // 泡の模様は品質に依らないので 1 回だけ作る。時刻は sim のフレーム番号から
  const pattern = createFoamPattern(renderer)
  const time = uniform(0)

  /** カスケード数・格子・精度・泡の段に依る一式。品質が変わったら作り直す */
  function build(q: QualitySettings) {
    const params = oceanParamsFor(q.oceanCascades, q.oceanFftSize)
    const simulation = createOceanSimulation(params)
    simulation.init(renderer)
    // 異方性と泡の解像度は品質表から（計測用の口が上書きする）。遠くのカスケードを飛ばす手と
    // 空 2 回は既定で入れる（段 S4a-2 の予算の改訂、2026-10-29）
    const shadeOptions: OceanShadeOptions = {
      calm: calmNodes,
      turbidity: options.turbidity ?? OCEAN_TURBIDITY,
      skipFar: options.skipFar ?? true,
      skyLookups: options.skyLookups ?? 2,
      anisotropy: options.anisotropy ?? q.oceanAnisotropy,
    }
    const textures = createOceanTextures(simulation, options.precision, shadeOptions.anisotropy)
    const sampler = createOceanSampler(params)
    const foamLevels = options.foamLevels ?? q.oceanFoamLevels
    const foam =
      foamLevels > 0
        ? createOceanFoam(
            sampler,
            textures,
            foamLevels,
            { speed: params.windSpeed, direction: params.windDirection },
            options.foamResolution ?? q.oceanFoamResolution,
            calmNodes,
          )
        : null
    const foamInputs: OceanFoamInputs = {
      pattern: pattern.texture,
      world: foam?.world ?? null,
      levels: foam?.levels ?? 0,
      time: time as unknown as N<'float'>,
      wind: [Math.cos(params.windDirection), Math.sin(params.windDirection)],
    }
    return { params, simulation, textures, sampler, foam, ...buildMaterials(sampler, textures, foamInputs, shadeOptions) }
  }

  function buildMaterials(
    sampler: OceanSampler,
    textures: OceanTextures,
    foamInputs: OceanFoamInputs,
    shadeOptions: OceanShadeOptions,
  ) {
    const coverNode = cover as unknown as N<'vec4'>

    // ---- CDLOD の頂点 ----
    const patchInfo = attribute('oceanPatch', 'vec4') as unknown as N<'vec4'>
    const patchMorph = attribute('oceanMorph', 'vec2') as unknown as N<'vec2'>
    const unitGrid = positionGeometry.xy as unknown as N<'vec2'>
    // 寄せた xz と寄せる量。寄せる量は寄せる前の位置とカメラの 3 次元の距離から（`oceanMorph`）
    const patch = Fn(() => {
      const unmorphed = patchInfo.xy.add(unitGrid.mul(patchInfo.z)).toVar()
      const cam = lighting.camera
      const d = length(vec3(unmorphed.x.sub(cam.x), max(cam.y, 0), unmorphed.y.sub(cam.z)))
      const morph = clamp(d.sub(patchMorph.x).div(max(patchMorph.y.sub(patchMorph.x), 1e-4)), 0, 1).toVar()
      // 親の格子は偶数番の頂点（地形の `terrainPatchWorldNode` と同じ）
      const g = unitGrid.mul(patchInfo.z.div(patchInfo.w)).toVar()
      const parent = floor(g.mul(0.5)).mul(2)
      const xz = patchInfo.xy.add(mix(g, parent, morph).mul(patchInfo.w))
      return vec3(xz.x, xz.y, morph)
    })() as unknown as N<'vec3'>
    const xz = patch.xy as unknown as N<'vec2'>
    const displacement = Fn(() => {
      // 寄せている間は頂点の間隔が倍へ近づく（web-ocean の `eff`）
      const cell = patchInfo.w.mul(patch.z.add(1))
      // 縁で変位を 0 へ（`oceanEdgeFade`）
      const inset = min(
        min(xz.x.sub(coverNode.x), coverNode.x.add(coverNode.z).sub(xz.x)),
        min(xz.y.sub(coverNode.y), coverNode.y.add(coverNode.z).sub(xz.y)),
      )
      const t = clamp(inset.div(coverNode.w.mul(OCEAN_EDGE_FADE)), 0, 1)
      const fade = t.mul(t).mul(float(3).sub(t.mul(2)))
      return sampler.displacement(textures, xz, cell as unknown as N<'float'>).mul(fade).mul(calmNodes.calm(xz))
    })() as unknown as N<'vec3'>
    const position = vec3(xz.x.add(displacement.x), displacement.y, xz.y.add(displacement.z))
    // 変位の前の xz と高さを画素へ渡す（傾きは変位の前の座標で引く。高さは波頭の透過光）
    const xzVarying = varying(xz, 'oceanXZ') as unknown as N<'vec2'>
    const heightVarying = varying(displacement.y, 'oceanHeight') as unknown as N<'float'>

    const material = new MeshBasicNodeMaterial()
    ;(material as unknown as { positionNode: unknown }).positionNode = position
    // `outputNode` に差す理由は地形と同じ（`createTerrainNodeMaterial` の注記、MRT）
    ;(material as unknown as { outputNode: unknown }).outputNode = oceanShadeNode(
      sampler,
      textures,
      foamInputs,
      lighting,
      xzVarying,
      positionWorld as unknown as N<'vec3'>,
      heightVarying,
      shadeOptions,
    )

    // ---- 外側の板。変位は無く、範囲の内側を描かない ----
    const plateMaterial = new MeshBasicNodeMaterial()
    const plateWorld = positionWorld as unknown as N<'vec3'>
    ;(plateMaterial as unknown as { outputNode: unknown }).outputNode = Fn(() => {
      const p = plateWorld.xz
      const inside = p.x
        .greaterThan(coverNode.x.add(PLATE_OVERLAP))
        .and(p.x.lessThan(coverNode.x.add(coverNode.z).sub(PLATE_OVERLAP)))
        .and(p.y.greaterThan(coverNode.y.add(PLATE_OVERLAP)))
        .and(p.y.lessThan(coverNode.y.add(coverNode.z).sub(PLATE_OVERLAP)))
      Discard(inside)
      return oceanShadeNode(
        sampler,
        textures,
        foamInputs,
        lighting,
        p as unknown as N<'vec2'>,
        plateWorld,
        float(0) as unknown as N<'float'>,
        shadeOptions,
      )
    })()
    return { material, plateMaterial }
  }

  let parts = build(quality)
  const mesh = new Mesh(geometry, parts.material)
  mesh.name = 'Ocean'
  mesh.frustumCulled = false
  const plate = new Mesh(plateGeometry, parts.plateMaterial)
  plate.name = 'OceanPlate'
  plate.rotation.x = -Math.PI / 2
  plate.frustumCulled = false

  const patches: OceanPatch[] = []
  let patchCount = 0
  /** 最後に海を解いた刻み。null は未だ解いていない（または作り直した） */
  let lastTicks: number | null = null

  /** 刻み t の海を解いてテクスチャへ写し、泡を dt 秒進める */
  function step(r: Renderer, camera: Vector3, t: number, dt: number, reset: boolean): void {
    parts.simulation.update(r, t, 0)
    parts.textures.update(r)
    parts.foam?.update(r, camera.x, camera.z, dt, reset)
  }

  function upload(): void {
    patchCount = Math.min(patches.length, MAX_PATCHES)
    for (let i = 0; i < patchCount; i++) {
      const patch = patches[i]!
      origins[i * 4] = patch.x
      origins[i * 4 + 1] = patch.z
      origins[i * 4 + 2] = patch.size
      origins[i * 4 + 3] = patch.size / OCEAN_PATCH_CELLS
      morphs[i * 2] = patch.morphStart
      morphs[i * 2 + 1] = patch.morphEnd
    }
    originAttribute.needsUpdate = true
    morphAttribute.needsUpdate = true
    geometry.instanceCount = patchCount
  }

  return {
    mesh,
    plate,
    get patchCount() {
      return patchCount
    },
    get triangleCount() {
      return patchCount * OCEAN_PATCH_CELLS * OCEAN_PATCH_CELLS * 2
    },
    get textures() {
      return parts.textures
    },
    get simulation() {
      return parts.simulation
    },
    update(r, camera, ticks) {
      const levels = quality.oceanLodLevels
      const c = oceanCoverage(camera, levels)
      ;(cover.value as { set(x: number, y: number, z: number, w: number): void }).set(c.x0, c.z0, c.size, oceanRootSize(levels))
      parts.sampler.setOrigin(c.x0, c.z0)
      selectOceanPatches(camera, levels, quality.lodDistanceScale, patches)
      upload()
      plate.position.x = camera.x
      plate.position.z = camera.z
      time.value = (ticks % OCEAN_LOOP_TICKS) * FIXED_DT
      // **同じ刻みなら解き直さない。**キャプチャは 1 枚に 8 フレーム描くが、海は変わらない
      if (ticks === lastTicks) return
      if (lastTicks === null || Math.abs(ticks - lastTicks) > FOAM_WARMUP_JUMP) {
        // 前から回して泡を作る（キャプチャと、飛んだあと）。4 フレーム刻みで 16 回（S4a-2 の合意）
        for (let k = FOAM_WARMUP_STEPS - 1; k >= 0; k--) {
          step(r, camera, ticks - k * FOAM_WARMUP_STRIDE, FOAM_WARMUP_STRIDE * FIXED_DT, k === FOAM_WARMUP_STEPS - 1)
        }
      } else {
        step(r, camera, ticks, Math.min(Math.max(ticks - lastTicks, 0) * FIXED_DT, MAX_FOAM_DT), false)
      }
      lastTicks = ticks
    },
    setQuality(next) {
      const rebuild =
        next.oceanCascades !== quality.oceanCascades ||
        next.oceanFftSize !== quality.oceanFftSize ||
        next.oceanFoamLevels !== quality.oceanFoamLevels ||
        next.oceanFoamResolution !== quality.oceanFoamResolution ||
        next.oceanAnisotropy !== quality.oceanAnisotropy
      quality = next
      if (!rebuild) return false
      const old = parts
      parts = build(next)
      lastTicks = null
      mesh.material = parts.material
      plate.material = parts.plateMaterial
      old.simulation.dispose()
      old.textures.dispose()
      old.foam?.dispose()
      old.material.dispose()
      old.plateMaterial.dispose()
      return true
    },
    setVisible(visible) {
      mesh.visible = visible
      plate.visible = visible
    },
    dispose() {
      geometry.dispose()
      plateGeometry.dispose()
      parts.simulation.dispose()
      parts.textures.dispose()
      parts.foam?.dispose()
      parts.material.dispose()
      parts.plateMaterial.dispose()
      pattern.dispose()
    },
  }
}

/**
 * 突き合わせ用に、点 (x, z, 間隔, 0) ごと・カスケードごとの変位を頂点シェーダと同じ引き方で
 * 求めて書く（`oceanProbe.ts` の `compareOceanSurface`）。足さないカスケードは 0
 */
export function createOceanSurfaceProbe(
  sampler: OceanSampler,
  textures: OceanTextures,
  points: Float32Array,
  field: 'displacement' | 'moments' = 'displacement',
) {
  const M = points.length / 4
  const C = sampler.params.cascades.length
  const logN = Math.log2(sampler.params.size)
  const input = instancedArray(points, 'vec4')
  const output = instancedArray(M * C, 'vec4')
  const node = Fn(() => {
    const k = uint(instanceIndex).toVar()
    const pt = (input as unknown as { element(i: unknown): N<'vec4'> }).element(k).toVar()
    for (let c = 0; c < C; c++) {
      const lod = sampler.lod(c, pt.z).toVar()
      const value = vec4(0, 0, 0, 0).toVar()
      If(lod.lessThan(logN), () => {
        value.assign(sampler.cascade(textures[field], c, pt.xy as unknown as N<'vec2'>, lod as unknown as N<'float'>))
      })
      ;(output as unknown as { element(i: unknown): { assign(v: unknown): void } }).element(k.mul(C).add(c)).assign(value)
    }
  })().compute(M, [64]) as unknown as ComputeNode
  return { node, output }
}
