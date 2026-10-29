import { FloatType, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping } from 'three'
import { Fn, instanceIndex, instancedArray, int, storageTexture, uint, uvec2 } from 'three/tsl'
import { StorageArrayTexture, type ComputeNode, type Node, type Renderer } from 'three/webgpu'

/**
 * 記憶域（層 × N² の vec4）を配列テクスチャへ写し、ミップを作る（段 S4a-1、S4a-2 で汎用にした）。
 *
 * **three の生成（`generateMipmaps`）を使わない。**層 × 段 × 枚数の描画パス（high で 64 本）に
 * なり、GPU の時刻の道具で測れない（計時の付かないパスで走る）。ここは 32 ビットの記憶域の
 * ピラミッドで 2 × 2 を平均して、各段へ書く。同じテクスチャを読みながら別の段へ書くと、ビューの
 * 用途が衝突する（読む側のビューが全段を含む）ので、前の段は記憶域から読む。
 *
 * 写す前に値を変換できる（`map`）。LEAN のモーメント（傾きの 2 乗と積）は、傾きの記憶域から
 * 積を作って写し、**積のまま平均する**（平均の積ではない。粗い段で分散が残る理由）。
 */

type N<T extends string> = Node<T>

/** 写す元と先。元は層 × N² の vec4、要素の番号は `(層 × N + y) × N + x` */
export interface LayeredField {
  source: unknown
  texture: StorageArrayTexture
  /** 写す前の変換。無ければそのまま */
  map?: (v: N<'vec4'>) => N<'vec4'>
}

export interface LayeredMips {
  /** 段 0 へ写す */
  readonly copy: ComputeNode
  /** 段 1 から最後まで（段ごとに 1 回）。配列ごと `renderer.compute` に渡す */
  readonly mips: ComputeNode[]
  update(renderer: Renderer): void
  dispose(): void
}

/** ミップ付きの配列テクスチャ。中身は `createLayeredMips` が書く */
export function createLayeredTexture(
  size: number,
  layers: number,
  bits: 16 | 32,
  name: string,
  anisotropy = 1,
): StorageArrayTexture {
  const t = new StorageArrayTexture(size, size, layers)
  t.type = bits === 32 ? FloatType : HalfFloatType
  t.format = RGBAFormat
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.magFilter = LinearFilter
  t.minFilter = LinearMipmapLinearFilter
  t.anisotropy = anisotropy
  // 段の数を確保させるために立てる。中身は自前のコンピュートで作るので、three の生成は止める
  // （`mipmapsAutoUpdate` が false なら `Textures.js` も `Bindings.js` も作らない）
  t.generateMipmaps = true
  ;(t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false
  t.name = name
  return t
}

/**
 * 写しとミップの計算を組む。
 *
 * @param label 計時の名札の頭（`'Ocean'` なら `Ocean [ Copy ]`・`Ocean [ Mip ]`）
 */
export function createLayeredMips(N: number, layers: number, fields: readonly LayeredField[], label: string): LayeredMips {
  const read = (buffer: unknown, i: N<'uint'>) => (buffer as { element(i: unknown): N<'vec4'> }).element(i)
  const write = (buffer: unknown, i: N<'uint'>, v: N<'vec4'>) =>
    (buffer as { element(i: unknown): { assign(v: unknown): void } }).element(i).assign(v)
  const store = (t: StorageArrayTexture, layer: N<'uint'>, xy: N<'uvec2'>, value: N<'vec4'>, level: number) =>
    (
      storageTexture(t) as unknown as {
        setMipLevel(l: number): { depth(d: unknown): { store(uv: unknown, v: unknown): unknown } }
      }
    )
      .setMipLevel(level)
      .depth(int(layer))
      .store(xy, value)
  const mapped = (f: LayeredField, v: N<'vec4'>) => (f.map === undefined ? v : f.map(v))

  const copy = Fn(() => {
    const idx = uint(instanceIndex).toVar()
    const c = idx.div(N * N).toVar()
    const rem = idx.mod(N * N)
    const xy = uvec2(rem.mod(N), rem.div(N)).toVar() as unknown as N<'uvec2'>
    for (const f of fields) store(f.texture, c, xy, mapped(f, read(f.source, idx)), 0)
  })().compute(layers * N * N, [64]) as unknown as ComputeNode
  ;(copy as unknown as { name: string }).name = `${label} [ Copy ]`

  const levels = Math.log2(N)
  const offsets: number[] = []
  let total = 0
  for (let l = 1; l <= levels; l++) {
    offsets.push(total)
    total += layers * (N >> l) ** 2
  }
  const pyramids = fields.map(() => instancedArray(total, 'vec4'))
  const mips: ComputeNode[] = []
  for (let l = 1; l <= levels; l++) {
    const n = N >> l
    const pn = n * 2
    const srcOffset = l === 1 ? 0 : offsets[l - 2]!
    const dstOffset = offsets[l - 1]!
    const node = Fn(() => {
      const idx = uint(instanceIndex).toVar()
      const c = idx.div(n * n).toVar()
      const rem = idx.mod(n * n)
      const x = rem.mod(n).toVar()
      const y = rem.div(n).toVar()
      const i00 = c.mul(pn * pn).add(y.mul(2 * pn)).add(x.mul(2)).add(srcOffset).toVar()
      const xy = uvec2(x, y) as unknown as N<'uvec2'>
      fields.forEach((f, k) => {
        // 段 1 は元の記憶域から（変換してから平均）、段 2 からはピラミッドから
        const at = (i: N<'uint'>) => (l === 1 ? mapped(f, read(f.source, i)) : read(pyramids[k], i))
        const v = at(i00)
          .add(at(i00.add(1) as unknown as N<'uint'>))
          .add(at(i00.add(pn) as unknown as N<'uint'>))
          .add(at(i00.add(pn + 1) as unknown as N<'uint'>))
          .mul(0.25)
          .toVar() as unknown as N<'vec4'>
        write(pyramids[k], idx.add(dstOffset) as unknown as N<'uint'>, v)
        store(f.texture, c, xy, v, l)
      })
    })().compute(layers * n * n, [64]) as unknown as ComputeNode
    mips.push(node)
  }
  // 計時の名札は `renderer.compute` に渡したものの `name`（`passInspector.ts`）。配列に付ける
  ;(mips as unknown as { name: string }).name = `${label} [ Mip ]`

  return {
    copy,
    mips,
    update(renderer) {
      renderer.compute(copy)
      renderer.compute(mips as never)
    },
    dispose() {
      for (const node of [copy, ...mips]) {
        ;(node as unknown as { dispose?: () => void }).dispose?.()
      }
    },
  }
}
