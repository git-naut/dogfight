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
 * 組むときに踏んだ落とし穴が 4 つある。
 *
 * 設定ごとにまとめて測ってはいけない。計測中に機械の状態が動くので、順番が
 * 結果に乗る。1 回ずつ総当たりで回せば、動きは全設定に等しく乗る。
 *
 * 代表値は最小値にする。割り込みは時間を増やす方向にしか効かない。
 *
 * キャプチャモードは DPR を 1 に固定しているので、そのままでは実際に遊ぶ
 * 解像度と画素数が 2.25 倍違う。計測モードだけ実 DPR を使う（main.ts）。
 *
 * そして GPU タイマーのクエリは、同じタスクの中では結果が揃わない。
 * `gl.finish()` を挟んで待っても揃わなかった。フレームをまたいで回収する。
 */

export interface BenchRow {
  label: string
  /**
   * GPU クエリで測った ms。拡張が無い、または結果が回収できなければ null。
   *
   * CPU 側の経過と両方出す。片方だけを見て判断しないため。CPU 側は
   * Chrome が `performance.now()` を 0.1 ms に丸めるうえ、描画の完了を
   * 待ち切れているかどうかを外から確かめられない。
   */
  gpuMinMs: number | null
  gpuMedianMs: number | null
  /** CPU 側の経過 ms。最小値を代表値として読む */
  cpuMinMs: number
  cpuMedianMs: number
  cpuMaxMs: number
  triangles: number
}

export interface BenchTarget {
  readonly renderer: WebGLRenderer
  readonly terrainTriangles: number
  readonly quality: { lodDistanceScale: number; terrainPatchCells: number }
  setMeasureConfig(config: MeasureConfig): void
  renderPlain(): void
}

interface TimerExtension {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

interface Inflight {
  query: WebGLQuery
  caseIndex: number
}

/** 最初に捨てる回数。シェーダのコンパイルとテクスチャの常駐化が混ざる */
const WARMUP = 3

/** 最後にクエリを回収するために回すフレーム数 */
const DRAIN_FRAMES = 90

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

export async function runBenchSweep(
  view: BenchTarget,
  samplesPerCase: number,
): Promise<BenchRow[]> {
  const gl = view.renderer.getContext() as WebGL2RenderingContext
  const ext = gl.getExtension(
    'EXT_disjoint_timer_query_webgl2',
  ) as TimerExtension | null
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
    sky: true,
    detailNormals: true,
    lodDistanceScale: view.quality.lodDistanceScale,
    terrainPatchCells: view.quality.terrainPatchCells,
  }

  const cases: { label: string; config: MeasureConfig }[] = [
    { label: '基準', config: base },
    { label: '空なし', config: { ...base, sky: false } },
    { label: '地形なし', config: { ...base, terrain: false } },
    { label: '海面なし', config: { ...base, water: false } },
    { label: '雲なし', config: { ...base, clouds: false } },
    {
      label: '後処理だけ',
      config: { ...base, sky: false, terrain: false, water: false, clouds: false },
    },
    { label: '法線摂動なし', config: { ...base, detailNormals: false } },
    { label: 'lod 0.65', config: { ...base, lodDistanceScale: 0.65 } },
    { label: 'cells 24', config: { ...base, terrainPatchCells: 24 } },
  ]

  const cpuSamples: number[][] = cases.map(() => [])
  const gpuSamples: number[][] = cases.map(() => [])
  const triangles: number[] = cases.map(() => 0)
  const inflight: Inflight[] = []

  function collect(): void {
    if (ext === null) return
    // 乱れた区間の値は信用できない。読むとフラグは落ちる
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    for (let i = inflight.length - 1; i >= 0; i--) {
      const item = inflight[i]!
      if (disjoint) {
        gl.deleteQuery(item.query)
        inflight.splice(i, 1)
        continue
      }
      const ready = gl.getQueryParameter(
        item.query,
        gl.QUERY_RESULT_AVAILABLE,
      ) as boolean
      if (!ready) continue
      const nanoseconds = gl.getQueryParameter(item.query, gl.QUERY_RESULT) as number
      gpuSamples[item.caseIndex]!.push(nanoseconds / 1e6)
      gl.deleteQuery(item.query)
      inflight.splice(i, 1)
    }
  }

  for (let i = 0; i < WARMUP; i++) {
    view.renderPlain()
    drain()
  }

  for (let round = 0; round < samplesPerCase; round++) {
    await nextFrame()
    collect()

    for (let k = 0; k < cases.length; k++) {
      // 順番を 1 周ごとにずらす。固定にすると、1 周の中の後ろの設定ほど
      // 遅く出た（実測。総当たりにしただけでは足りず、周回内の位置が
      // そのまま結果に乗る）。ずらせば各設定が全部の位置を等しく通る
      const c = (k + round) % cases.length
      view.setMeasureConfig(cases[c]!.config)

      // 設定を変えた直後の 1 枚は測らない。ジオメトリの作り直しや
      // バッファの再アップロードが乗る
      view.renderPlain()
      drain()

      const query = ext !== null ? gl.createQuery() : null
      if (query !== null && ext !== null) gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
      const started = performance.now()
      view.renderPlain()
      if (query !== null && ext !== null) gl.endQuery(ext.TIME_ELAPSED_EXT)
      drain()
      cpuSamples[c]!.push(performance.now() - started)
      if (query !== null) inflight.push({ query, caseIndex: c })

      triangles[c] = view.terrainTriangles
    }
  }

  for (let i = 0; i < DRAIN_FRAMES && inflight.length > 0; i++) {
    await nextFrame()
    collect()
  }
  for (const item of inflight) gl.deleteQuery(item.query)

  // 測り終えたら元に戻す。以降の描画が設定違いにならないように
  view.setMeasureConfig(base)

  return cases.map((item, c) => {
    const cpu = [...cpuSamples[c]!].sort((a, b) => a - b)
    const gpu = [...gpuSamples[c]!].sort((a, b) => a - b)
    return {
      label: item.label,
      gpuMinMs: gpu.length > 0 ? gpu[0]! : null,
      gpuMedianMs: gpu.length > 0 ? gpu[Math.floor(gpu.length / 2)]! : null,
      cpuMinMs: cpu[0] ?? 0,
      cpuMedianMs: cpu[Math.floor(cpu.length / 2)] ?? 0,
      cpuMaxMs: cpu[cpu.length - 1] ?? 0,
      triangles: triangles[c] ?? 0,
    }
  })
}
