import { Fn, If, clamp, float, floor, length, screenUV, tanh, uint, uniformArray, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { OceanSimulation } from './oceanNodes'
import { amplitude, latticeBands, latticeIndex, type OceanSpectrumParams } from './reference'

/**
 * FFT の海を目で見る画面（段 S3、`?ocean=debug`）。
 *
 * カスケードごとに 1 行、列は左から高さ・傾き・ヤコビアン（泡のもと）。値の幅はカスケードで
 * 桁が違うので、スペクトルから求めた標準偏差で割って見せる。高さは灰色（中央が 0）、傾きは
 * 大きさを灰色で、ヤコビアンは 1 を灰色の中ほどにし、0.3 を下回る所（面が畳まれかけて泡が
 * 出る所）を赤で塗る。
 *
 * 場面は描かない。トーンマッピングも通さない（`nodeScene.ts` が出力の色の変換を切る）。
 * 海の計算だけの費用を測るための画面でもある。
 */

/** カスケードごとの高さと傾きの標準偏差（スペクトルの和、`Var = Σ 2(a(n)² + a(-n)²)`） */
export function oceanFieldScales(p: OceanSpectrumParams): { height: number[]; slope: number[] } {
  const N = p.size
  const bands = latticeBands(p)
  const height: number[] = []
  const slope: number[] = []
  for (let c = 0; c < p.cascades.length; c++) {
    const s = (2 * Math.PI) / p.cascades[c]!
    let vh = 0
    let vs = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const [nx, ny] = latticeIndex(x, y, N)
        const a = amplitude(nx, ny, c, p, bands)
        const b = amplitude(-nx, -ny, c, p, bands)
        const e = 2 * (a * a + b * b)
        vh += e
        vs += e * (nx * nx + ny * ny) * s * s
      }
    }
    height.push(Math.sqrt(vh))
    slope.push(Math.sqrt(vs))
  }
  return { height, slope }
}

export function createOceanDebugNode(sim: OceanSimulation, p: OceanSpectrumParams): Node<'vec4'> {
  const N = sim.size
  const C = sim.cascades
  const scales = oceanFieldScales(p)
  const pad = (a: number[]) => [...a, ...new Array(8 - a.length).fill(1)]
  const heightScale = uniformArray(pad(scales.height), 'float')
  const slopeScale = uniformArray(pad(scales.slope), 'float')
  const at = (arr: unknown, c: Node<'uint'>) =>
    (arr as { element(i: unknown): unknown }).element(c) as unknown as Node<'float'>
  const read = (buffer: unknown, i: Node<'uint'>) =>
    (buffer as { element(i: unknown): Node<'vec4'> }).element(i)

  return Fn(() => {
    // 画面を 3 列 × C 行に分ける。screenUV は左上が原点
    const uv = screenUV as unknown as Node<'vec2'>
    const column = uint(clamp(floor(uv.x.mul(3)), 0, 2)).toVar()
    const row = uint(clamp(floor(uv.y.mul(C)), 0, C - 1)).toVar()
    const local = uv.mul(vec3(3, C, 0).xy).sub(vec3(float(column), float(row), 0).xy).toVar()
    const x = uint(clamp(floor(local.x.mul(N)), 0, N - 1))
    const y = uint(clamp(floor(local.y.mul(N)), 0, N - 1))
    const idx = row.mul(N * N).add(y.mul(N)).add(x).toVar()
    const d = read(sim.displacement, idx).toVar()
    const g = read(sim.derivatives, idx).toVar()
    const color = vec3(0, 0, 0).toVar()
    If(column.equal(uint(0)), () => {
      color.assign(vec3(tanh(d.y.div(at(heightScale, row).mul(2))).mul(0.5).add(0.5)))
    })
      .ElseIf(column.equal(uint(1)), () => {
        color.assign(vec3(clamp(length(g.xy).div(at(slopeScale, row).mul(3)), 0, 1)))
      })
      .Else(() => {
        const J = g.z.add(1).mul(g.w.add(1)).sub(d.w.mul(d.w)).toVar()
        color.assign(vec3(clamp(J.mul(0.5), 0, 1)))
        If(J.lessThan(0.3), () => {
          color.assign(vec3(0.9, 0.1, 0.1))
        })
      })
    return vec4(color, 1)
  })() as unknown as Node<'vec4'>
}
