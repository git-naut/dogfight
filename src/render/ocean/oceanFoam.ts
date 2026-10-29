import { LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, Vector4 } from 'three'
import {
  Fn,
  If,
  exp,
  float,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  log2,
  max,
  min,
  storageTexture,
  texture,
  uint,
  uniform,
  uvec2,
  vec2,
  vec4,
  wgslFn,
} from 'three/tsl'
import { StorageTexture, type ComputeNode, type Node, type Renderer, type StorageArrayTexture } from 'three/webgpu'
import { createLayeredMips, createLayeredTexture, type LayeredMips } from './oceanMips'
import type { OceanSampler, OceanTextures } from './oceanSurface'

/**
 * 海の泡（段 S4a-2）。web-ocean（MIT、a07c7fd）の `FOAM_TEX` と `FOAM_UPDATE` の写し。
 *
 * - **模様のテクスチャ**（512²、rgba8）。起動時に 1 回作る。R は泡の網目、G は細かい網目、
 *   B は柔らかい濃淡（風の斑にも使う）、A は筋。周期的なノイズなので継ぎ目なく繰り返す
 * - **ワールドのクリップマップ**（1024² × 段、一辺 128 m と 1024 m）。カメラを中心にトーラス状に
 *   番地を振り、毎フレーム、前の泡を風下へ流して減衰させ、面が畳まれる所（ヤコビアン J が小さい
 *   所）に注ぎ足す。R が泡の量、G が新しさ（注いだばかりの濃い泡）、B が J
 *
 * 段の数は品質表の `oceanFoamLevels`。0 段のときはクリップマップを作らず、海面がその場の J から
 * 瞬間の泡だけを描く。
 *
 * 状態は 32 ビットの記憶域に持ち、テクスチャ（16 ビット）へ写してミップを作る（`oceanMips.ts`）。
 * 前の泡はテクスチャから引く（web-ocean と同じ精度）。**時間の刻みは sim の刻みの差から**（実時間を
 * 使わない）。同じ刻みで呼び直すと刻みが 0 になり、泡は変わらない（キャプチャで同じフレームを
 * 何枚描いても同じ）。
 */

type N<T extends string> = Node<T>

/** クリップマップの一辺の texel（web-ocean の `FOAM_RES`）。実機で測ってから変えるか決める（S4a-2 の合意） */
export const FOAM_RESOLUTION = 1024
/** 段ごとの一辺 m（web-ocean の `FOAM_LEVEL_SIZE`） */
export const FOAM_LEVEL_SIZES: readonly number[] = [128, 1024]
/** 模様のテクスチャの一辺 */
export const FOAM_PATTERN_SIZE = 512

// web-ocean の既定（`P.foam` = 1）の値
/** 泡の減衰 1/s */
const FOAM_DECAY = 0.22
/** 新しさの減衰 1/s */
const FRESH_DECAY = 1.6
/** 注ぐ J の閾値（0.52 + 0.16 × 泡の強さ 1） */
const FOAM_THRESHOLD = 0.68
const FOAM_GAIN = 2
const FOAM_GROWTH = 1
/** 泡が風下へ流れる速さ m/s。風速に掛ける */
const FOAM_DRIFT_PER_WIND = 0.03
/** 泡の量の上限 */
const FOAM_MAX = 1.6

// ---- 模様のテクスチャ（`NOISE_WGSL`・`PERIODIC_WGSL`・`FOAM_TEX`）----
/**
 * WGSL の関数。`@types/three` の include の型は `wgslFn` の戻り値を受けないが、実行時は受ける
 * （three の `FunctionNode` が include の関数の節点を辿る）。型の逃げ口をここに 1 か所
 */
const wgsl = (code: string, includes: unknown[] = []) => wgslFn(code, includes as never)
// 名前の頭に `ocn` を付ける。生成される WGSL の中でほかの関数と名前がぶつからないように

const pcgHash = wgsl(`
fn ocnPcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}`)

const hashGrad = wgsl(
  `
fn ocnHashGrad(i: vec2i) -> vec2f {
  let h = ocnPcgHash(u32(i.x) * 1664525u + ocnPcgHash(u32(i.y) + 1013904223u));
  let a = f32(h) * (6.28318530718 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}`,
  [pcgHash],
)

const pnoise = wgsl(
  `
fn ocnPnoise(p: vec2f, period: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let i00 = (i % period + period) % period;
  let i10 = ((i + vec2i(1, 0)) % period + period) % period;
  let i01 = ((i + vec2i(0, 1)) % period + period) % period;
  let i11 = ((i + vec2i(1, 1)) % period + period) % period;
  let a = dot(ocnHashGrad(i00), f);
  let b = dot(ocnHashGrad(i10), f - vec2f(1.0, 0.0));
  let c = dot(ocnHashGrad(i01), f - vec2f(0.0, 1.0));
  let d = dot(ocnHashGrad(i11), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`,
  [hashGrad],
)

const pfbm = wgsl(
  `
fn ocnPfbm(p: vec2f, period: i32, oct: i32) -> f32 {
  var s = 0.0; var a = 0.5; var q = p; var per = period;
  for (var o = 0; o < oct; o++) {
    s += a * ocnPnoise(q, per);
    q *= 2.0; per *= 2; a *= 0.5;
  }
  return s;
}`,
  [pnoise],
)

const h2 = wgsl(
  `
fn ocnH2(i: vec2i, salt: u32) -> vec2f {
  let h = ocnPcgHash((u32(i.x) * 73856093u) ^ ocnPcgHash(u32(i.y) * 19349663u + salt));
  let h2v = ocnPcgHash(h + 0x9e3779b9u);
  return vec2f(f32(h >> 8u), f32(h2v >> 8u)) / 16777216.0;
}`,
  [pcgHash],
)

const bubbles = wgsl(
  `
fn ocnBubbles(uv: vec2f, period: i32, salt: u32, rmin: f32, rmax: f32) -> f32 {
  let w = vec2f(ocnPfbm(uv * f32(period) * 0.5, period / 2, 3), ocnPfbm(uv * f32(period) * 0.5 + 17.0, period / 2, 3));
  let p = uv * f32(period) + w * 0.9;
  let ip = vec2i(floor(p));
  let fp = p - floor(p);
  var v = 9.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let o = vec2i(i, j);
      let cell = ((ip + o) % period + period) % period;
      let hh = ocnH2(cell, salt);
      let r = vec2f(o) + hh * 0.9 + 0.05 - fp;
      let rad = mix(rmin, rmax, ocnH2(cell, salt + 7u).x);
      v = min(v, length(r) / rad);
    }
  }
  return smoothstep(0.8, 1.25, v);
}`,
  [pfbm, h2],
)

/** 模様の 1 texel（`FOAM_TEX` の `main` の本体） */
const foamTexel = wgsl(
  `
fn ocnFoamTexel(uv: vec2f) -> vec4f {
  let w1 = vec2f(ocnPfbm(uv * 5.0, 5, 3), ocnPfbm(uv * 5.0 + vec2f(3.7, 9.1), 5, 3));
  let m1 = smoothstep(-0.14, 0.06, ocnPfbm(uv * 10.0 + w1 * 1.4, 10, 5));
  let w2 = vec2f(ocnPfbm(uv * 12.0 + 1.3, 12, 2), ocnPfbm(uv * 12.0 + 7.9, 12, 2));
  let m2 = smoothstep(-0.16, 0.04, ocnPfbm(uv * 27.0 + w2 * 0.9, 27, 4));
  let b3 = ocnBubbles(uv, 29, 37u, 0.06, 0.45);
  let b4 = ocnBubbles(uv, 61, 53u, 0.05, 0.42);
  let dens = ocnPfbm(uv * 4.0, 4, 5) * 0.5 + 0.5;
  let fineD = ocnPfbm(uv * 16.0, 16, 3) * 0.5 + 0.5;
  let big = m1 * (0.55 + 0.45 * m2) * (0.75 + 0.25 * b3);
  let fine = 0.45 + 0.55 * b3 * (0.7 + 0.3 * b4);
  let streak = ocnPfbm(uv * vec2f(4.0, 16.0), 4, 5) * 0.5 + 0.5;
  return vec4f(clamp(big * 0.6 + dens * 0.4, 0.0, 1.0), clamp(fine * 0.8 + fineD * 0.2, 0.0, 1.0), dens, streak);
}`,
  [pfbm, bubbles],
)

export interface FoamPattern {
  readonly texture: StorageTexture
  dispose(): void
}

/** 模様のテクスチャを作る（起動時に 1 回）。ミップは three が最初に引くときに作る（1 回だけ） */
export function createFoamPattern(renderer: Renderer): FoamPattern {
  const S = FOAM_PATTERN_SIZE
  const t = new StorageTexture(S, S)
  t.type = UnsignedByteType
  t.format = RGBAFormat
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.magFilter = LinearFilter
  t.minFilter = LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 16
  t.name = 'OceanFoamPattern'
  const node = Fn(() => {
    const id = uint(instanceIndex).toVar()
    const x = id.mod(S)
    const y = id.div(S)
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(S)
    ;(storageTexture(t) as unknown as { store(uv: unknown, v: unknown): unknown }).store(
      uvec2(x, y),
      (foamTexel as unknown as (uv: unknown) => N<'vec4'>)(uv),
    )
  })().compute(S * S, [64]) as unknown as ComputeNode
  ;(node as unknown as { name: string }).name = 'Ocean [ Foam Pattern ]'
  renderer.compute(node)
  return {
    texture: t,
    dispose() {
      t.dispose()
      ;(node as unknown as { dispose?: () => void }).dispose?.()
    },
  }
}

export interface OceanFoam {
  /** 段の数（1 か 2） */
  readonly levels: number
  /** (泡の量, 新しさ, J, 1)。層が段 */
  readonly world: StorageArrayTexture
  /** 同じ値の 32 ビットの記憶域（段 × 1024²）。自己診断が読み戻す */
  readonly state: { value: unknown }
  /**
   * 泡を進める。`dt` は sim の刻みの差から求めた秒（0 なら変わらない）。`reset` を立てると
   * 前の泡を捨てる（最初のフレームと、キャプチャで前から回し直すとき）
   */
  update(renderer: Renderer, cameraX: number, cameraZ: number, dt: number, reset: boolean): void
  dispose(): void
}

export function createOceanFoam(
  sampler: OceanSampler,
  textures: OceanTextures,
  levels: number,
  wind: { speed: number; direction: number },
  resolution = FOAM_RESOLUTION,
): OceanFoam {
  const R = resolution
  const L = Math.min(levels, FOAM_LEVEL_SIZES.length)
  const ts = FOAM_LEVEL_SIZES.slice(0, L).map((s) => s / R)
  const N = sampler.params.size
  const logN = Math.log2(N)

  const world = createLayeredTexture(R, L, 16, 'OceanFoamWorld', 16)
  const state = instancedArray(L * R * R, 'vec4')
  const chain: LayeredMips = createLayeredMips(R, L, [{ source: state, texture: world }], 'Ocean Foam')

  // 段ごとの (今のカメラの texel x, z, 前の x, z)
  const snap = Array.from({ length: L }, () => uniform(new Vector4()))
  const dtU = uniform(0)
  const drift = vec2(
    Math.cos(wind.direction) * FOAM_DRIFT_PER_WIND * wind.speed,
    Math.sin(wind.direction) * FOAM_DRIFT_PER_WIND * wind.speed,
  )
  const prev = texture(world)
  const write = (i: N<'uint'>, v: N<'vec4'>) =>
    (state as unknown as { element(i: unknown): { assign(v: unknown): void } }).element(i).assign(v)

  const update = Fn(() => {
    const idx = uint(instanceIndex).toVar()
    const lvl = idx.div(R * R).toVar()
    const rem = idx.mod(R * R)
    const id = ivec2(int(rem.mod(R)), int(rem.div(R))).toVar()
    const sn = vec4(snap[0]!).toVar()
    const texel = float(ts[0]!).toVar()
    if (L > 1) {
      If(lvl.equal(uint(1)), () => {
        sn.assign(snap[1]! as unknown as N<'vec4'>)
        texel.assign(ts[1]!)
      })
    }
    // トーラスの番地からワールドの texel（web-ocean の `wrapIdx`）
    const lo = ivec2(int(sn.x), int(sn.y)).sub(R / 2).toVar()
    const wrap = (i: N<'int'>, l: N<'int'>) => l.add(i.sub(l).mod(R).add(R).mod(R))
    const g = ivec2(wrap(id.x as never, lo.x as never), wrap(id.y as never, lo.y as never)).toVar()
    const plo = ivec2(int(sn.z), int(sn.w)).sub(R / 2).toVar()
    const inPrev = g.x
      .greaterThanEqual(plo.x)
      .and(g.y.greaterThanEqual(plo.y))
      .and(g.x.lessThan(plo.x.add(R)))
      .and(g.y.lessThan(plo.y.add(R)))
    const p = vec2(float(g.x).add(0.5), float(g.y).add(0.5)).mul(texel).toVar() as unknown as N<'vec2'>

    // 全カスケードのヤコビアン。texel の大きさに合わせて段を選ぶ（web-ocean は + 0.5 を付けない）
    const jxx = float(0).toVar()
    const jzz = float(0).toVar()
    const jxz = float(0).toVar()
    for (let c = 0; c < sampler.params.cascades.length; c++) {
      const cellTexel = sampler.params.cascades[c]! / N
      const lod = log2(max(texel.div(cellTexel), 1)).toVar() as unknown as N<'float'>
      If(lod.lessThan(logN - 0.5), () => {
        const d = sampler.cascade(textures.derivatives, c, p, lod)
        const a = sampler.cascade(textures.displacement, c, p, lod)
        jxx.addAssign(d.z)
        jzz.addAssign(d.w)
        jxz.addAssign(a.w)
      })
    }
    const J = jxx.add(1).mul(jzz.add(1)).sub(jxz.mul(jxz)).toVar()

    // 前の泡を風下から引く（半ラグランジュの移流）
    const before = vec4(0, 0, 0, 0).toVar()
    If(inPrev, () => {
      const back = vec2(float(id.x).add(0.5), float(id.y).add(0.5))
        .sub(drift.mul(dtU).div(texel))
        .div(R) as unknown as N<'vec2'>
      before.assign((prev as unknown as { sample(uv: unknown): { depth(d: unknown): { level(l: unknown): N<'vec4'> } } })
        .sample(back)
        .depth(int(lvl))
        .level(0))
    })
    const inject = float(FOAM_THRESHOLD).sub(J).mul(FOAM_GAIN).clamp(0, 1).toVar()
    const f = before.x.mul(exp(dtU.mul(-FOAM_DECAY))).toVar()
    f.assign(max(f, inject))
    f.assign(min(f.add(inject.mul(dtU).mul(FOAM_GROWTH)), FOAM_MAX))
    const fresh = max(before.y.mul(exp(dtU.mul(-FRESH_DECAY))), inject)
    write(idx, vec4(f, fresh, J, 1) as unknown as N<'vec4'>)
  })().compute(L * R * R, [64]) as unknown as ComputeNode
  ;(update as unknown as { name: string }).name = 'Ocean [ Foam ]'

  const last: { x: number; z: number }[] = ts.map(() => ({ x: 0, z: 0 }))

  return {
    levels: L,
    world,
    state: state as unknown as { value: unknown },
    update(renderer, cameraX, cameraZ, dt, reset) {
      for (let l = 0; l < L; l++) {
        const cx = Math.floor(cameraX / ts[l]!)
        const cz = Math.floor(cameraZ / ts[l]!)
        // 最初のフレーム: 前の窓を遠くに置いて全部を捨てる（web-ocean の `foamFirst`）
        const px = reset ? cx + 100_000 : last[l]!.x
        const pz = reset ? cz + 100_000 : last[l]!.z
        ;(snap[l]!.value as Vector4).set(cx, cz, px, pz)
        last[l] = { x: cx, z: cz }
      }
      dtU.value = dt
      renderer.compute(update)
      chain.update(renderer)
    },
    dispose() {
      world.dispose()
      chain.dispose()
      ;(update as unknown as { dispose?: () => void }).dispose?.()
    },
  }
}
