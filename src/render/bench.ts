import type { MeasureConfig, MeasureToggles } from './scene'
import type { RenderBackend } from './backend'

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
  /**
   * 描画バックエンド。排出と GPU タイマーの取得に使う。
   *
   * **WebGPU 経路では `getContext()` が空になる。**計測の口をここへ寄せて
   * あるので、段 16 で作り直すときに触るのはこのファイルとバックエンドだけ
   */
  readonly backend: RenderBackend
  readonly terrainTriangles: number
  /** 直前のフレームで実際に投入した三角形。切り替えが効いたかの確認に使う */
  readonly drawnTriangles: number
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

/**
 * 代表値。GPU クエリが使えるならそちら、無ければ CPU 側で。
 *
 * 表と警告で同じ値を使う。別々に書くと判定が食い違う。
 */
/** 条件 1 つ。`key` は `?only=` で選ぶための ascii 名 */
export interface BenchCase {
  key: string
  label: string
  config: MeasureConfig
}

export function benchKey(row: BenchRow): number {
  return row.gpuMinMs ?? row.cpuMinMs
}

/**
 * ばらつきの目安 ms。
 *
 * 最小値と中央値の差を全条件で見て、その中央を取る。最小値を代表値に
 * するのは割り込みが時間を増やす方向にしか効かないからだが、**それでも
 * 最小値そのものが振れる。**この幅より小さい差は読まない。
 *
 * 実機の計測で、武装を切った差が +0.01〜+0.13 ms で並んだ。**すべて正の値**
 * （切ったほうが遅い）だったので、差ではなくばらつきだったと分かる。
 */
export function benchNoiseFloor(rows: readonly BenchRow[]): number {
  const spreads = rows
    .map((r) =>
      r.gpuMinMs !== null && r.gpuMedianMs !== null ? r.gpuMedianMs - r.gpuMinMs : null,
    )
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  return spreads.length > 0 ? spreads[spreads.length >> 1]! : 0
}

/**
 * いちばん大きい短縮 ms。負の値。切っても縮まなければ 0。
 *
 * 基準は先頭の行。
 */
export function benchBestGain(rows: readonly BenchRow[]): number {
  const base = rows[0]
  if (base === undefined) return 0
  let best = 0
  for (const row of rows) {
    if (row === base) continue
    best = Math.min(best, benchKey(row) - benchKey(base))
  }
  return best
}

/**
 * この計測が読めないか。
 *
 * **「有意」が 1 つも無い表は、費用が無いのではなく測れていない。**
 * 実機の計測で 1 度、ばらつき 3.84 ms に対していちばん大きい差が 2.24 ms で
 * 全行が「誤差以下」か「逆」になった。後処理の連鎖は別の回に 2.75〜3.39 ms
 * と出ているので、費用が無いわけではない。
 *
 * 全行を突き合わせないと気づけないので、表に判定させる。
 */
export function benchUnreadable(rows: readonly BenchRow[]): boolean {
  if (rows.length < 2) return false
  return Math.abs(benchBestGain(rows)) < benchNoiseFloor(rows)
}

/**
 * 条件を絞る。
 *
 * `?only=base,enemies` のように渡す。**基準は必ず先頭に入る。**差の基準に
 * なるので、外すと比べる相手がいない。知らない名前は黙って捨てず、そのまま
 * 落とす（絞り込みが効いていないのに全条件が回るのを避ける）。
 *
 * @param keys 選ぶ ascii 名。空なら全条件
 */
export function selectBenchCases(all: readonly BenchCase[], keys: string): BenchCase[] {
  const wanted = keys
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (wanted.length === 0) return [...all]
  const set = new Set(wanted)
  const picked = all.filter((c) => c.key === 'base' || set.has(c.key))
  // 基準しか残らなかったら絞り込みが噛んでいない。全条件へ戻す
  return picked.length > 1 ? picked : [...all]
}

export async function runBenchSweep(
  view: BenchTarget,
  samplesPerCase: number,
  only = '',
): Promise<BenchRow[]> {
  // **`ext` があるなら `gl` もある、を型で表す。**別々の変数にすると
  // 片方だけ null 検査した経路が通ってしまう。WebGPU 経路では
  // `webglContext()` が null を返し、GPU 時間は測らず CPU 時間だけ残る
  const timer = ((): { gl: WebGL2RenderingContext; ext: TimerExtension } | null => {
    const gl = view.backend.webglContext()
    if (gl === null) return null
    const ext = gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as TimerExtension | null
    return ext === null ? null : { gl, ext }
  })()

  // 排出はバックエンドが持つ。`gl.finish()` では足りない理由もそちらに書いた
  const drain = (): void => view.backend.drain()

  // **型で埋め忘れを止める。**`MeasureToggles` はすべての切り替えを必須にする
  const base: MeasureToggles & MeasureConfig = {
    terrain: true,
    water: true,
    clouds: true,
    sky: true,
    detailNormals: true,
    aircraft: true,
    environment: true,
    aircraftShadow: true,
    trails: true,
    targets: true,
    enemies: true,
    damageSmoke: true,
    flares: true,
    tracers: true,
    missiles: true,
    smoke: true,
    explosions: true,
    lodDistanceScale: view.quality.lodDistanceScale,
    terrainPatchCells: view.quality.terrainPatchCells,
  }

  /**
   * 条件の一覧。`key` は URL で絞り込むための ascii 名。
   *
   * **21 条件を全部回すと機械が熱で遅くなる。**実機で 4 回測って、試料を
   * 増やすほど基準そのものが遅くなり、ばらつきも増えた（基準 6.14 →
   * 16.22 ms、ばらつき 0.35 → 6.01 ms）。知りたい条件だけを回せば、
   * 総量が減って熱が乗らない。
   */
  const all: BenchCase[] = [
    { key: 'base', label: '基準', config: base },
    { key: 'sky', label: '空なし', config: { ...base, sky: false } },
    { key: 'terrain', label: '地形なし', config: { ...base, terrain: false } },
    { key: 'water', label: '海面なし', config: { ...base, water: false } },
    { key: 'clouds', label: '雲なし', config: { ...base, clouds: false } },
    {
      key: 'post', label: '後処理だけ',
      config: { ...base, sky: false, terrain: false, water: false, clouds: false },
    },
    { key: 'normals', label: '法線摂動なし', config: { ...base, detailNormals: false } },
    { key: 'aircraft', label: '機体なし', config: { ...base, aircraft: false } },
    { key: 'shadow', label: '影なし', config: { ...base, aircraftShadow: false } },
    { key: 'env', label: '環境反射なし', config: { ...base, environment: false } },
    { key: 'trails', label: '軌跡なし', config: { ...base, trails: false } },
    // Phase 5 の武装。台本に何も出ていなければ差は 0 になる。
    // **0 が出ること自体が「その台本では測れていない」という手がかり。**
    { key: 'targets', label: '標的なし', config: { ...base, targets: false } },
    { key: 'enemies', label: '敵機なし', config: { ...base, enemies: false } },
    // **雲を切った上で敵機を切る。**雲は GPU 時間の最大項（実機で 5.97〜
    // 9.00 ms）で、ばらつきの主因でもある。`only=clouds,cloudsenemies` で
    // この 2 行を並べれば、敵機の費用を静かな場面で読める。差は「雲なし」
    // との引き算で取る（表の差の列は基準との差なので手で引く）
    {
      key: 'cloudsenemies',
      label: '雲なし＋敵機なし',
      config: { ...base, clouds: false, enemies: false },
    },
    { key: 'dmgsmoke', label: 'ダメージの煙なし', config: { ...base, damageSmoke: false } },
    { key: 'flares', label: 'フレアなし', config: { ...base, flares: false } },
    { key: 'tracers', label: '曳光弾なし', config: { ...base, tracers: false } },
    { key: 'missiles', label: 'ミサイルなし', config: { ...base, missiles: false } },
    { key: 'smoke', label: '煙なし', config: { ...base, smoke: false } },
    { key: 'explosions', label: '爆発なし', config: { ...base, explosions: false } },
    {
      key: 'weapons', label: '武装ぜんぶなし',
      config: {
        ...base,
        targets: false,
        tracers: false,
        missiles: false,
        smoke: false,
        explosions: false,
      },
    },
    { key: 'lod', label: 'lod 0.65', config: { ...base, lodDistanceScale: 0.65 } },
    { key: 'cells', label: 'cells 24', config: { ...base, terrainPatchCells: 24 } },
  ]

  const cases = selectBenchCases(all, only)

  const cpuSamples: number[][] = cases.map(() => [])
  const gpuSamples: number[][] = cases.map(() => [])
  const triangles: number[] = cases.map(() => 0)
  const inflight: Inflight[] = []

  function collect(): void {
    if (timer === null) return
    const { gl, ext } = timer
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

      const query = timer?.gl.createQuery() ?? null
      if (timer !== null && query !== null) {
        timer.gl.beginQuery(timer.ext.TIME_ELAPSED_EXT, query)
      }
      const started = performance.now()
      view.renderPlain()
      if (timer !== null && query !== null) {
        timer.gl.endQuery(timer.ext.TIME_ELAPSED_EXT)
      }
      drain()
      cpuSamples[c]!.push(performance.now() - started)
      if (query !== null) inflight.push({ query, caseIndex: c })

      // **地形だけでなく実際に描いた総数を記録する。**`terrainTriangles` は
      // 地形の集計なので、機体や武装を切っても動かない。実機の計測で全条件が
      // 438k のまま並び、「切れているのか」を確かめられなかった
      triangles[c] = view.drawnTriangles
    }
  }

  for (let i = 0; i < DRAIN_FRAMES && inflight.length > 0; i++) {
    await nextFrame()
    collect()
  }
  for (const item of inflight) timer?.gl.deleteQuery(item.query)

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
