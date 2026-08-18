import type { WebGLRenderer } from 'three'
import type { MeasureConfig } from './scene'

/**
 * 同じ 1 枚を設定を変えながら繰り返し描いて、GPU 時間の内訳を測る。
 *
 * 実機の `?debug=1` に出る「GPU 時間の最大値」を目で読む方式では、1 ms の差を
 * 分離できなかった。飛びながら読むので視点が毎回違い、最大値は 1 フレームの
 * 外れ値で決まる。実測で、描画を減らしたはずの設定のほうが遅いという矛盾した
 * 並びが出た。
 *
 * ここではカメラを止め、同じフレームを設定だけ変えて描く。視点も雲の位相も
 * 同じなので、差は設定の差だけになる。
 *
 * 設定ごとにまとめて測ってはいけない。最初にその形で組んだら、後半の設定ほど
 * 遅く出た（SwiftShader の実測で、描画を全部減らした設定が、地形だけ切った
 * 設定より 16 ms 遅い）。計測中に機械の状態が動くので、順番が結果に乗る。
 * 1 回ずつ総当たりで回せば、動きは全設定に等しく乗る。
 */

export interface BenchRow {
  label: string
  /**
   * 最小値。これを代表値として読む。
   *
   * 「この 1 枚を描くのに何 ms かかるか」を知りたいので、外れ値は必ず上へ
   * しか出ない。他の処理が割り込めば遅くなるだけで、速くはならない。
   * 平均や中央値は環境の騒がしさを拾うが、最小値は拾わない。
   */
  minMs: number
  medianMs: number
  maxMs: number
  triangles: number
}

export interface BenchTarget {
  readonly renderer: WebGLRenderer
  readonly terrainTriangles: number
  readonly quality: { lodDistanceScale: number; terrainPatchCells: number }
  setMeasureConfig(config: MeasureConfig): void
  render(): void
}

/** 最初に捨てる回数。シェーダのコンパイルとテクスチャの常駐化が混ざる */
const WARMUP = 3

export function runBenchSweep(view: BenchTarget, samplesPerCase: number): BenchRow[] {
  const gl = view.renderer.getContext()
  const pixel = new Uint8Array(4)

  // gl.finish() では足りない。Chrome は描画コマンドを溜めるので、読み戻しで
  // 排出させないと投入時間しか測れない。実測で全解像度が 1/4 解像度より
  // 速く出て気づいた
  const drain = (): void => {
    gl.finish()
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  }

  const base: MeasureConfig = {
    terrain: true,
    water: true,
    clouds: true,
    lodDistanceScale: view.quality.lodDistanceScale,
    terrainPatchCells: view.quality.terrainPatchCells,
  }

  const cases: { label: string; config: MeasureConfig }[] = [
    { label: '基準', config: base },
    { label: '地形なし', config: { ...base, terrain: false } },
    { label: '海面なし', config: { ...base, water: false } },
    { label: '雲なし', config: { ...base, clouds: false } },
    { label: '地形も海面もなし', config: { ...base, terrain: false, water: false } },
    { label: 'lod 0.65', config: { ...base, lodDistanceScale: 0.65 } },
    { label: 'cells 24', config: { ...base, terrainPatchCells: 24 } },
  ]

  const samples: number[][] = cases.map(() => [])
  const triangles: number[] = cases.map(() => 0)

  for (let i = 0; i < WARMUP; i++) {
    view.render()
    drain()
  }

  for (let round = 0; round < samplesPerCase; round++) {
    for (let c = 0; c < cases.length; c++) {
      view.setMeasureConfig(cases[c]!.config)

      // 設定を変えた直後の 1 枚は測らない。ジオメトリの作り直しや
      // バッファの再アップロードが乗る
      view.render()
      drain()

      const started = performance.now()
      view.render()
      drain()
      samples[c]!.push(performance.now() - started)
      triangles[c] = view.terrainTriangles
    }
  }

  // 測り終えたら元に戻す。以降の描画が設定違いにならないように
  view.setMeasureConfig(base)

  return cases.map((item, c) => {
    const list = [...samples[c]!].sort((a, b) => a - b)
    return {
      label: item.label,
      minMs: list[0] ?? 0,
      medianMs: list[Math.floor(list.length / 2)] ?? 0,
      maxMs: list[list.length - 1] ?? 0,
      triangles: triangles[c] ?? 0,
    }
  })
}
