import {
  BufferAttribute,
  DynamicDrawUsage,
  FloatType,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  type Vector3,
} from 'three'
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  clamp,
  dot,
  exp,
  float,
  floor,
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
  storageTexture,
  texture,
  uint,
  uniform,
  uvec2,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { MeshBasicNodeMaterial, StorageArrayTexture, type ComputeNode, type Node, type Renderer } from 'three/webgpu'
import { createUnitGrid } from '../terrain/terrainMesh'
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
import { oceanParamsFor, type OceanSpectrumParams } from './reference'
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

/** 板の一辺 m。今の板の海（`terrain/water.ts`）と同じ */
const PLATE_EXTENT = 300_000

/**
 * 板が描かない範囲の縁の重ね m。CDLOD の外周のパッチは T 字の継ぎ目で板と画素未満の
 * 隙間を作りうるので、板を少しだけ内へ入れて重ねる。重なりでは変位がほぼ 0（`oceanEdgeFade`
 * が縁で 0）で、両方とも同じ陰影なので深度の競合は見えない（推測。絵で確かめる）
 */
const PLATE_OVERLAP = 2

// ---- web-ocean の水の値（`ocean.html` の `f[76..83]`、濁り 1.6）----
/** 水中から戻る散乱の色（web-ocean の `waterCol.rgb` = (0.016, 0.080, 0.096) × 濁り 1.6） */
const WATER_BODY: readonly [number, number, number] = [0.0256, 0.128, 0.1536]
/** 解けない細かい傾きの分散（web-ocean の `waterCol.w`） */
const UNRESOLVED_SLOPE_VARIANCE = 0.0024

export interface OceanTextures {
  readonly displacement: StorageArrayTexture
  readonly derivatives: StorageArrayTexture
  readonly precision: OceanTexturePrecision
  /** 記憶域からテクスチャの段 0 へ写す */
  readonly copy: ComputeNode
  /** ミップの段 1 から最後まで（段ごとに 1 回）。配列ごと `renderer.compute` に渡す */
  readonly mips: ComputeNode[]
  /** 写してミップを作る。海を解いたあとに呼ぶ */
  update(renderer: Renderer): void
  dispose(): void
}

/** FFT の出力を写す配列テクスチャ。層がカスケード */
export function createOceanTextures(sim: OceanSimulation, precision: OceanTexturePrecision): OceanTextures {
  const N = sim.size
  const C = sim.cascades
  const make = (name: string) => {
    const t = new StorageArrayTexture(N, N, C)
    t.type = precision === 32 ? FloatType : HalfFloatType
    t.format = RGBAFormat
    t.wrapS = RepeatWrapping
    t.wrapT = RepeatWrapping
    t.magFilter = LinearFilter
    t.minFilter = LinearMipmapLinearFilter
    // 段の数を確保させるために立てる。中身は自前のコンピュートで作るので、three の生成は止める
    // （`mipmapsAutoUpdate` が false なら `Textures.js` も `Bindings.js` も作らない）
    t.generateMipmaps = true
    ;(t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false
    t.name = name
    return t
  }
  const displacement = make('OceanDisplacement')
  const derivatives = make('OceanDerivatives')
  const read = (buffer: unknown, i: N<'uint'>) => (buffer as { element(i: unknown): N<'vec4'> }).element(i)
  const store = (t: StorageArrayTexture, layer: N<'uint'>, xy: N<'uvec2'>, value: N<'vec4'>, level = 0) =>
    (
      storageTexture(t) as unknown as {
        setMipLevel(l: number): { depth(d: unknown): { store(uv: unknown, v: unknown): unknown } }
      }
    )
      .setMipLevel(level)
      .depth(int(layer))
      .store(xy, value)

  const copy = Fn(() => {
    const idx = uint(instanceIndex).toVar()
    const c = idx.div(N * N).toVar()
    const rem = idx.mod(N * N)
    const xy = uvec2(rem.mod(N), rem.div(N)).toVar() as unknown as N<'uvec2'>
    store(displacement, c, xy, read(sim.displacement, idx))
    store(derivatives, c, xy, read(sim.derivatives, idx))
  })().compute(C * N * N, [64]) as unknown as ComputeNode
  ;(copy as unknown as { name: string }).name = 'Ocean [ Copy ]'

  // ---- ミップ。段 l の texel は段 l−1 の 2 × 2 の平均 ----
  //
  // **three の生成（`generateMipmaps`）を使わない。**層 × 段 × 2 枚の描画パス（high で 64 本）に
  // なり、GPU の時刻の道具で測れない（計時の付かないパスで走る）。ここは 32 ビットの記憶域の
  // ピラミッドで平均して、各段へ書く。同じテクスチャを読みながら別の段へ書くと、ビューの用途が
  // 衝突する（読む側のビューが全段を含む）ので、前の段は記憶域から読む
  const levels = Math.log2(N)
  const offsets: number[] = []
  let total = 0
  for (let l = 1; l <= levels; l++) {
    offsets.push(total)
    total += C * (N >> l) ** 2
  }
  const pyramidA = instancedArray(total, 'vec4')
  const pyramidB = instancedArray(total, 'vec4')
  const write = (buffer: unknown, i: N<'uint'>, v: N<'vec4'>) =>
    (buffer as { element(i: unknown): { assign(v: unknown): void } }).element(i).assign(v)
  const mips: ComputeNode[] = []
  for (let l = 1; l <= levels; l++) {
    const n = N >> l
    const pn = n * 2
    const srcA = l === 1 ? sim.displacement : pyramidA
    const srcB = l === 1 ? sim.derivatives : pyramidB
    const srcOffset = l === 1 ? 0 : offsets[l - 2]!
    const dstOffset = offsets[l - 1]!
    const node = Fn(() => {
      const idx = uint(instanceIndex).toVar()
      const c = idx.div(n * n).toVar()
      const rem = idx.mod(n * n)
      const x = rem.mod(n).toVar()
      const y = rem.div(n).toVar()
      const i00 = c.mul(pn * pn).add(y.mul(2 * pn)).add(x.mul(2)).add(srcOffset).toVar()
      const average = (src: unknown) =>
        read(src, i00)
          .add(read(src, i00.add(1)))
          .add(read(src, i00.add(pn)))
          .add(read(src, i00.add(pn + 1)))
          .mul(0.25)
          .toVar() as unknown as N<'vec4'>
      const a = average(srcA)
      const b = average(srcB)
      write(pyramidA, idx.add(dstOffset), a)
      write(pyramidB, idx.add(dstOffset), b)
      const xy = uvec2(x, y) as unknown as N<'uvec2'>
      store(displacement, c, xy, a, l)
      store(derivatives, c, xy, b, l)
    })().compute(C * n * n, [64]) as unknown as ComputeNode
    mips.push(node)
  }
  // 計時の名札は `renderer.compute` に渡したものの `name`（`passInspector.ts`）。配列に付ける
  ;(mips as unknown as { name: string }).name = 'Ocean [ Mip ]'

  return {
    displacement,
    derivatives,
    precision,
    copy,
    mips,
    update(renderer) {
      renderer.compute(copy)
      renderer.compute(mips as never)
    },
    dispose() {
      displacement.dispose()
      derivatives.dispose()
      for (const node of [copy, ...mips]) {
        ;(node as unknown as { dispose?: () => void }).dispose?.()
      }
    },
  }
}

/** カスケードを引く道具。uv の起点（覆う範囲の角）と、その端数を持つ */
export interface OceanSampler {
  readonly params: OceanSpectrumParams
  /** カスケード c を xz で引く。lod を渡せばその段、渡さなければ画面の微分から（画素シェーダ） */
  cascade(textureOf: StorageArrayTexture, c: number, xz: N<'vec2'>, lod?: N<'float'>): N<'vec4'>
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
  /** 向き dir の空の放射輝度（`HillaireSky.radiance`） */
  skyRadiance(dir: N<'vec3'>): N<'vec3'>
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

/** Schlick、水の F0 = 0.02（web-ocean の `fresnelWater`） */
const fresnelWater = (c: N<'float'>) => {
  const x = float(1).sub(clamp(c, 0, 1))
  const x2 = x.mul(x)
  return float(0.02).add(x2.mul(x2).mul(x).mul(0.98)) as unknown as N<'float'>
}

/** Smith の Λ（傾きの分散が等方のとき。web-ocean の `lambdaSmith` の cov = (σ², σ², 0)） */
const lambdaSmith = (w: N<'vec3'>, variance: N<'float'>) =>
  Fn(() => {
    const xz2 = max(dot(w.xz, w.xz), 1e-8)
    const cotT = w.y.div(sqrt(xz2))
    const a = max(cotT, 1e-3).div(sqrt(variance.mul(2).max(1e-7))).toVar()
    const out = float(0).toVar()
    If(a.lessThan(1.6), () => {
      out.assign(float(1).sub(a.mul(1.259)).add(a.mul(a).mul(0.396)).div(a.mul(3.535).add(a.mul(a).mul(2.181))))
    })
    return out
  })() as unknown as N<'float'>

/**
 * 海面の色（霞の前）。
 *
 * @param xz    変位の前の xz（ラグランジュの座標）。傾きはここで引く
 * @param world 描く点のワールド座標（変位の後）
 */
export function oceanShadeNode(
  sampler: OceanSampler,
  textures: OceanTextures,
  lighting: OceanLighting,
  xz: N<'vec2'>,
  world: N<'vec3'>,
): N<'vec4'> {
  return Fn(() => {
    // 傾き。画素の微分でミップを選ぶ（遠くは平均して滑らかに）
    const s = vec2(0, 0).toVar()
    const jxx = float(0).toVar()
    const jzz = float(0).toVar()
    for (let c = 0; c < sampler.params.cascades.length; c++) {
      const d = sampler.cascade(textures.derivatives, c, xz).toVar()
      s.addAssign(d.xy)
      jxx.addAssign(d.z)
      jzz.addAssign(d.w)
    }
    const jx = max(jxx.add(1), 0.15)
    const jz = max(jzz.add(1), 0.15)
    const slope = vec2(s.x.div(jx), s.y.div(jz)).toVar()
    const nrm = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar()

    const rel = world.sub(lighting.camera).toVar()
    const dist = length(rel).toVar()
    const V = rel.negate().div(max(dist, 1e-3)).toVar()
    const Ld = lighting.sunDirection
    const shade = lighting.sunShade(world)
    const sunE = lighting.sunIlluminance(world).mul(shade).toVar()
    // 上半球の平均の放射輝度。web-ocean は環境キューブの 5 点で求めるが、ここは天空の照度を π で割る
    // （今の板の海と同じ。照度は余弦の重み付きの平均）
    const skyHemi = lighting.skyIlluminance(world).mul(1 / Math.PI).toVar()

    // ---- 太陽の映り込み。傾きの分布はまだ等方の解けない分だけ（LEAN は段 S4a-2）----
    const variance = float(UNRESOLVED_SLOPE_VARIANCE).add(smoothstep(30, 500, dist).mul(0.0035)).toVar()
    const Hv = normalize(V.add(Ld)).toVar()
    const hs = Hv.xz.negate().div(max(Hv.y, 1e-3))
    const dsl = hs.sub(slope).toVar()
    const pdf = exp(dot(dsl, dsl).div(variance).mul(-0.5)).div(variance.mul(2 * Math.PI))
    const hy2 = Hv.y.mul(Hv.y)
    const Dm = pdf.div(max(hy2.mul(hy2), 1e-6))
    const G = float(1).div(float(1).add(lambdaSmith(V, variance)).add(lambdaSmith(Ld, variance)))
    const Fh = fresnelWater(dot(V, Hv))
    const spec = sunE.mul(Fh.mul(Dm).mul(G).div(max(V.y, 0.02).mul(4))).mul(step(0, Ld.y)).toVar()

    // ---- 空の映り込み（web-ocean の R.y の折り返し。地平線の下を引かない）----
    const R = reflect(V.negate(), nrm).toVar()
    const Ry = abs(R.y).mul(0.4).add(max(R.y, 0).mul(0.6))
    const refl = lighting.skyRadiance(normalize(vec3(R.x, Ry, R.z))).toVar()
    // フレネルは長い波の面に、細かい面の分を寄せた法線で（web-ocean の `nF`）
    const nF = normalize(mix(nrm, vec3(0, 1, 0), 0.45))
    const Fr = fresnelWater(max(dot(nF, V), 0)).toVar()

    // ---- 水中から戻る光（拡散。画素ごとの法線は使わない）----
    const body = vec3(WATER_BODY[0], WATER_BODY[1], WATER_BODY[2])
      .mul(skyHemi.mul(1.6).add(sunE.mul(max(Ld.y, 0)).mul(0.8)))
      .toVar()

    const color = body.mul(float(1).sub(Fr)).add(refl.mul(Fr)).add(spec)
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

  /** カスケード数・格子・精度に依る一式。品質が変わったら作り直す */
  function build(q: QualitySettings) {
    const params = oceanParamsFor(q.oceanCascades, q.oceanFftSize)
    const simulation = createOceanSimulation(params)
    simulation.init(renderer)
    const textures = createOceanTextures(simulation, options.precision)
    const sampler = createOceanSampler(params)
    return { params, simulation, textures, sampler, ...buildMaterials(sampler, textures) }
  }

  function buildMaterials(sampler: OceanSampler, textures: OceanTextures) {
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
    const position = Fn(() => {
      // 寄せている間は頂点の間隔が倍へ近づく（web-ocean の `eff`）
      const cell = patchInfo.w.mul(patch.z.add(1))
      // 縁で変位を 0 へ（`oceanEdgeFade`）
      const inset = min(
        min(xz.x.sub(coverNode.x), coverNode.x.add(coverNode.z).sub(xz.x)),
        min(xz.y.sub(coverNode.y), coverNode.y.add(coverNode.z).sub(xz.y)),
      )
      const t = clamp(inset.div(coverNode.w.mul(OCEAN_EDGE_FADE)), 0, 1)
      const fade = t.mul(t).mul(float(3).sub(t.mul(2)))
      const disp = sampler.displacement(textures, xz, cell as unknown as N<'float'>).mul(fade).toVar()
      return vec3(xz.x.add(disp.x), disp.y, xz.y.add(disp.z))
    })()
    // 変位の前の xz を画素へ渡す（傾きは変位の前の座標で引く）
    const xzVarying = varying(xz, 'oceanXZ') as unknown as N<'vec2'>

    const material = new MeshBasicNodeMaterial()
    ;(material as unknown as { positionNode: unknown }).positionNode = position
    // `outputNode` に差す理由は地形と同じ（`createTerrainNodeMaterial` の注記、MRT）
    ;(material as unknown as { outputNode: unknown }).outputNode = oceanShadeNode(
      sampler,
      textures,
      lighting,
      xzVarying,
      positionWorld as unknown as N<'vec3'>,
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
      return oceanShadeNode(sampler, textures, lighting, p as unknown as N<'vec2'>, plateWorld)
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
      parts.simulation.update(r, ticks, 0)
      parts.textures.update(r)
    },
    setQuality(next) {
      const rebuild = next.oceanCascades !== quality.oceanCascades || next.oceanFftSize !== quality.oceanFftSize
      quality = next
      if (!rebuild) return false
      const old = parts
      parts = build(next)
      mesh.material = parts.material
      plate.material = parts.plateMaterial
      old.simulation.dispose()
      old.textures.dispose()
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
      parts.material.dispose()
      parts.plateMaterial.dispose()
    },
  }
}

/**
 * 突き合わせ用に、点 (x, z, 間隔, 0) ごと・カスケードごとの変位を頂点シェーダと同じ引き方で
 * 求めて書く（`oceanProbe.ts` の `compareOceanSurface`）。足さないカスケードは 0
 */
export function createOceanSurfaceProbe(sampler: OceanSampler, textures: OceanTextures, points: Float32Array) {
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
        value.assign(sampler.cascade(textures.displacement, c, pt.xy as unknown as N<'vec2'>, lod as unknown as N<'float'>))
      })
      ;(output as unknown as { element(i: unknown): { assign(v: unknown): void } }).element(k.mul(C).add(c)).assign(value)
    }
  })().compute(M, [64]) as unknown as ComputeNode
  return { node, output }
}
