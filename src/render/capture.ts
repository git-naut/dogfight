import { resolvePreset, type PresetName } from './quality'
import { DEFAULT_HOUR } from './atmosphere'

/**
 * 決定論キャプチャモード。
 *
 * スクリーンショット回帰テストは「同じ入力から同じピクセル」が前提になる。
 * 実時間、Math.random()、経過時間依存のアニメーションが混ざると成立しない。
 * 太陽の位置も実時間の Date から決まるので、時刻を固定できるようにする。
 *
 * ?capture=1&script=bank-left&frame=600&hour=18 で起動すると、実時間を
 * 使わず名前付き入力スクリプトを指定フレームまで再生し、大気の LUT を
 * 読み終えてから 1 枚描いて止まり、captureReady を立てる。
 */
export interface CaptureConfig {
  enabled: boolean
  /** 何ステップ進めた時点を撮るか */
  frame: number
  /** 再生する入力スクリプト名 */
  script: string
  preset: PresetName
  /** 局所時刻 0〜24。12 が南中 */
  hour: number
  /** トーンマッピングの露出。未指定なら既定値 */
  exposure: number | null
  /** 雲量 0..1 */
  coverage: number
  /** 雲のレイマーチ解像度の上書き。実機で振って GPU 時間を測る用 */
  cloudScale: number | null
  /** 主マーチのステップ数の上書き */
  cloudSteps: number | null
  /** 光マーチの段数の上書き */
  cloudLight: number | null
  /** 地形の LOD 切り替え距離の倍率の上書き */
  lodScale: number | null
  /** 地形パッチの一辺のセル数の上書き */
  terrainCells: number | null
  /** 1 = 密度サンプル数、2 = 歩数を使い切ったか */
  probe: number
  /** 時間方向の足し込みを切るか。比較用 */
  noTemporal: boolean
  /** 自動降格を止める。実機で品質を固定して計測するため */
  noDegrade: boolean
  /**
   * 地形と海面を描くか。`?terrain=0` `?water=0` で切る。
   *
   * どちらが GPU 時間を食っているかは、切ってみないと分からない。
   * 雲では `?probe` で実行量を数えたが、地形は頂点とラスタライズの費用が
   * 主なので数えられない。差分で測る
   */
  showTerrain: boolean
  showWater: boolean
  /** 環境反射を使うか。`?env=0` で切る。質感の比較に使う */
  showEnvironment: boolean
  /** 機体の影を使うか。`?shadow=0` で切る。切り分けと計測に使う */
  showAircraftShadow: boolean
  /**
   * 標的機を描くか。`?targets=0` で切る。
   *
   * 差分で標的の画素だけを取り出すのに使う。**背景を行の中央値で近似すると
   * 嘘が出る**（地形や空のグラデーションを拾う）ので、消した版を焼いて
   * 引くのが正しい。翼端渦で同じ作法を採った
   */
  showTargets: boolean
  /** 曳光弾を描くか。`?tracers=0` で切る。差分で見え方を測るのに使う */
  showTracers: boolean
  /**
   * HUD を出すか。
   *
   * `?hud=1` / `?hud=0` で明示できる。省略したときはライブで出し、
   * キャプチャでは出さない。**HUD は画面の広い範囲に線を引くので、
   * 全カットに入れるとピッチラダーの刻みを 1 度動かすだけで基準画像が
   * 全部差分を出す。**地形・雲・機体・渦の見張りを HUD の調整から切り離す。
   */
  showHud: boolean
  /**
   * 描画を繰り返して 1 回あたりの時間を測る回数。0 なら測らない。
   *
   * SwiftShader は CPU ラスタライザなので、時間はシェーダの実行量にほぼ
   * 比例する。実機の絶対値は出ないが、視点どうしや最適化の前後を
   * 比べるには使える。実機の GPU 時間は ?debug=1 で読む
   */
  bench: number
  /**
   * 設定を振りながら同じ 1 枚を測るか。
   *
   * 実機で `?debug=1` の最大値を目で読む方式では 1 ms の差を分離できず、
   * 描画を減らしたはずの設定のほうが遅いという矛盾した並びが出た。
   */
  sweep: boolean
}

export const DEFAULT_SEED = 20260816

/**
 * 既定の雲量。
 *
 * ノイズを Nyquist 内へ収めた際に塊が育つ方向へ変わったので、点在する
 * 見え方を保つために 0.35 から下げた。
 */
export const DEFAULT_COVERAGE = 0.3

export function readCaptureConfig(search: string): CaptureConfig {
  const params = new URLSearchParams(search)
  return {
    enabled: params.get('capture') === '1',
    frame: clampInt(params.get('frame'), 0, 100_000, 240),
    script: params.get('script') ?? 'level',
    preset: resolvePreset(params.get('preset')),
    hour: clampNumber(params.get('hour'), 0, 24, DEFAULT_HOUR),
    exposure: params.has('exposure')
      ? clampNumber(params.get('exposure'), 0.01, 1000, 1)
      : null,
    coverage: clampNumber(params.get('coverage'), 0, 1, DEFAULT_COVERAGE),
    cloudScale: params.has('cloudScale')
      ? clampNumber(params.get('cloudScale'), 0.05, 1, 0.25)
      : null,
    cloudSteps: params.has('cloudSteps')
      ? clampInt(params.get('cloudSteps'), 8, 512, 96)
      : null,
    cloudLight: params.has('cloudLight')
      ? clampInt(params.get('cloudLight'), 1, 8, 6)
      : null,
    lodScale: params.has('lod') ? clampNumber(params.get('lod'), 0.2, 3, 1) : null,
    terrainCells: params.has('cells')
      ? clampInt(params.get('cells'), 4, 64, 32)
      : null,
    probe: clampInt(params.get('probe'), 0, 2, 0),
    noTemporal: params.get('ta') === '0',
    noDegrade: params.get('nodegrade') === '1',
    showTerrain: params.get('terrain') !== '0',
    showWater: params.get('water') !== '0',
    showEnvironment: params.get('env') !== '0',
    showAircraftShadow: params.get('shadow') !== '0',
    showTargets: params.get('targets') !== '0',
    showTracers: params.get('tracers') !== '0',
    showHud: params.has('hud')
      ? params.get('hud') === '1'
      : params.get('capture') !== '1',
    bench: clampInt(params.get('bench'), 0, 200, 0),
    sweep: params.get('sweep') === '1',
  }
}

export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1'
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampNumber(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === null) return fallback
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** テストから読むためのフック。ここ以外から window を汚さない。 */
export interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
  /** 大気の LUT を読み終えたか */
  atmosphereReady: boolean
  /** 太陽高度 rad。時刻を変えたことの検証に使う */
  sunElevation: number
  /** 太陽光の放射輝度 RGB。時刻で色が変わることの検証に使う */
  sunRadiance: [number, number, number]
  /** 天空光の放射輝度 RGB */
  skyRadiance: [number, number, number]
  /** 雲ノイズの生成にかかったミリ秒 */
  noiseMs: number
  /** 雲ノイズの中身。min と max が同じなら生成に失敗している */
  noiseStats: { min: number; max: number; mean: number }
  /** GPU のフレーム時間 ms。計測できていなければ 0 */
  gpuFrameMs: number
  /** そのうち雲のパスが占める ms */
  gpuCloudMs: number
  gpuTimerSupported: boolean
  /** 雲のバッファが 16bit 浮動小数か。8bit だと等高線状の横線が出る */
  cloudHdrTarget: boolean
  /** ?bench=N のときの 1 描画あたりの ms。測っていなければ 0 */
  benchMs: number
  /** ?sweep=1 のときの設定ごとの計測結果 */
  benchSweep: {
    label: string
    gpuMinMs: number | null
    gpuMedianMs: number | null
    cpuMinMs: number
    cpuMedianMs: number
    cpuMaxMs: number
    triangles: number
  }[]
  /** ?probe=1 のときの密度サンプル数。画素あたり */
  cloudSamples: { mean: number; max: number; p99: number }
  /** 高さ場の生成にかかったミリ秒 */
  terrainMs: number
  /** 高さ場の中身。min と max が同じなら生成に失敗している */
  terrainStats: { min: number; max: number; mean: number }
  /** 描いている地形パッチの枚数と三角形数 */
  terrainPatches: number
  terrainTriangles: number
  /** 機体の三角形数。読み込めていなければ 0 */
  aircraftTriangles: number
  /** HUD が出ているか */
  hudReady: boolean
  /** HUD が出している対気速度 kt。単位変換が表示層だけで起きていることの検査 */
  hudSpeedKt: number
  /** HUD が出している海抜 ft */
  hudAltitudeFt: number
  /** HUD が出している機首方位 度。0..360 */
  hudHeadingDeg: number
  /** フライトパスマーカーが画面に入っているか */
  hudFlightPathOnScreen: boolean
  /** ガンレティクルが画面に入っているか */
  hudGunReticleOnScreen: boolean
  /** sim にいる標的機の数。台本の配置で決まる */
  targetCount: number
  /** 描画が作った標的機の複製の数。sim の数と一致するはず */
  targetInstances: number
  /** 生きている標的の数 */
  targetsAlive: number
  /** 飛行中の弾の数 */
  bulletsInFlight: number
  /** 描いた曳光弾の線分の数。5 発に 1 発なので飛行中の 1/5 前後 */
  tracersDrawn: number
  /** 撃った弾の総数 */
  roundsFired: number
  /** 命中した弾の数 */
  hits: number
  /** 撃墜した数 */
  kills: number
  /** 残弾 */
  rounds: number
  /** ロックの段階。none / acquiring / locked */
  lockState: string
  /** ロックしている標的までの距離 m。捉えていなければ 0 */
  lockRange: number
  /** 接近速度 m/s。正が接近 */
  closingSpeed: number
  /** 機軸からの角度 度 */
  lockAngleDeg: number
  /** 捕捉の進み 0..1 */
  lockProgress: number
  /** ロックボックスが画面に入っているか */
  hudLockBoxOnScreen: boolean
  preset: PresetName
  hour: number
  // 飛行状態
  speed: number
  altitude: number
  /** 対地高度 m と真下の地形の高さ m */
  agl: number
  groundHeight: number
  /** 舵面の位置 −1..1 */
  elevator: number
  aileron: number
  rudder: number
  /** 動かせた舵面の枚数 */
  aircraftSurfaces: number
  /** 環境反射が焼けているか */
  environmentReady: boolean
  /** 機体の影マップが焼けているか */
  aircraftShadowReady: boolean
  /** 直前のフレームのドローコールと三角形。描かれていないものの検出に使う */
  drawCalls: number
  drawnTriangles: number
  angleOfAttack: number
  bank: number
  crashed: boolean
  script: string
}

declare global {
  interface Window {
    __dogfight?: TestHook
  }
}

export function installTestHook(initial: TestHook): TestHook {
  window.__dogfight = initial
  return initial
}
