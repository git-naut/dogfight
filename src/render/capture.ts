import { DEFAULT_COVERAGE, type NodeProbeResult } from './pipeline/types'
import {
  decodeShadowInputs,
  type ShadowInputs,
} from './clouds/shadowInputs'
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
  /**
   * 敵機を描くか。`?enemies=0` で切る。
   *
   * ダメージの煙の断面を測るのに要る。自機が敵の後ろにつくと煙の中を通るが、
   * 敵の機体が煙を隠す境界も差分では輪郭として立つ。`?aircraft=0` と
   * 同じ理由で分けられるようにしておく
   */
  showEnemies: boolean
  /** ダメージの煙を描くか。`?dmgsmoke=0` で切る。差分で断面を測るのに使う */
  showDamageSmoke: boolean
  /** フレアを描くか。`?flares=0` で切る。差分で大きさを測るのに使う */
  showFlares: boolean
  /** 曳光弾を描くか。`?tracers=0` で切る。差分で見え方を測るのに使う */
  showTracers: boolean
  /**
   * 自機を描くか。`?aircraft=0` で切る。
   *
   * 煙や曳光弾の断面を測るのに要る。機体が煙を隠す境界は、差分で見ると
   * 輪郭として立つ。**near 面の切り口と区別が付かない。**実際に排気口の
   * 位置で 54 階調の「断面」を検出して誤診しかけた。機体を消せば分かれる。
   */
  showAircraft: boolean
  /** 翼端渦とコントレイルを描くか。`?trails=0` で切る */
  showTrails: boolean
  /** ミサイルの本体を描くか。`?missiles=0` で切る */
  showMissiles: boolean
  /** ミサイルの煙を描くか。`?smoke=0` で切る。差分で断面を測るのに使う */
  showSmoke: boolean
  /** 爆発を描くか。`?explosions=0` で切る */
  showExplosions: boolean
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
   * 音を鳴らすか。
   *
   * `?sound=1` / `?sound=0` で明示できる。省略したときはライブで鳴らし、
   * キャプチャでは鳴らさない（`showHud` と同型）。**キャプチャは 1 枚
   * 描いて止まるので、鳴らしても意味がないうえに `AudioContext` の
   * 生成が待ち時間になる。**
   */
  sound: boolean
  /**
   * 音の自己診断を走らせるか。
   *
   * `?audioprobe=1`。**音は目で見えない。**ノードが繋がっただけで振幅が
   * 0 という状態は画面にも基準画像にも出ない。`OfflineAudioContext` で
   * 波形を書き出して測り、結果を `hook.audioProbe` に置く。
   * `?bench=` や `?sweep=1` と同じ、計測のためのモード
   */
  audioProbe: boolean
  /**
   * 描画バックエンドの経路。`?gpu=0|1|2`。
   *
   * 0 が既定で、いままでどおり `WebGLRenderer` を直に立てる。1 と 2 は
   * `WebGPURenderer` を立てる第 2 経路で、1 は `forceWebGL: true` で
   * WebGL2 バックエンドへ落とし、2 は WebGPU を要求する。
   *
   * **既定の絵には触らない。**移行が終わるまで 1 と 2 は自己診断であって、
   * 基準画像 42 枚は 0 の経路だけを見る
   */
  gpu: number
  /**
   * 雲ノイズの突き合わせ用の読み戻しを出すか。`?noiseprobe=1`。
   *
   * 形状ノイズの中央スライスの左下 16x16 を `hook.noiseSlice` に置く。
   * **統計だけでは 1 ビットのずれが埋もれる**ので、生バイトを出す
   */
  noiseProbe: boolean
  /**
   * 雲影マップの分布を出すか。`?shadowprobe=1`。
   *
   * 256² を読み戻して 16 ビンに数え、`hook.shadowHistogram` へ置く。
   * 読み戻しは同期なので、頼まれたときだけ走らせる
   */
  shadowProbe: boolean
  /**
   * 雲のマーチを固定の入力で焼いて出すか。`?marchprobe=1`。
   *
   * 密度サンプル数と打ち切りの数と区画平均を `hook.marchProbe` へ置く。
   * TSL 版との突き合わせ専用で、3 枚焼くので頼まれたときだけ走らせる
   */
  marchProbe: boolean
  /**
   * キャプチャで雲を描き重ねる枚数。`?converge=N`。0 なら既定の規則に従う。
   *
   * 既定は雲量 0 なら 2 枚、そうでなければ `CAPTURE_CONVERGE_FRAMES`。
   * **E2E 全体の待ち時間の 30/42 枚がここに乗っている**ので、規則が正しい
   * ことを確かめられるようにしておく
   */
  converge: number
  /**
   * TSL 版の雲影を焼くときの入力。`?shadowinputs=t,cov,sx,sy,sz,cx,cz`。
   *
   * `?gpu=2` の自己診断だけが読む。**GLSL 側が実際に焼いた値を渡す。**
   * 導き直すと、導き方が食い違ったときにヒストグラムの不一致が移植の欠陥に
   * 見える。数が揃わなければ null で、雲影は焼かない
   */
  shadowInputs: ShadowInputs | null
  /**
   * 雲のマーチを打ち切る距離 m。`?cloudfar=` で振る。
   *
   * 遠方の雲海をどこで切るかを絵と費用の両方で測るための口。
   * 指定しなければプリセットの値
   */
  cloudFar: number | null
  /**
   * 起動時にシェーダを全プリセットぶん作るか。
   *
   * `?precompile=0` で省ける。**E2E で使う。**4 段ぶんのコンパイルは
   * SwiftShader で 6.6 秒かかり、並列に走らせると起動待ちが 120 秒を
   * 超えて落ちた（実測。E2E 全体も 11.8 分から 17.2 分へ延びた）。
   *
   * 事前コンパイル自体は専用のテストで見ているので、機能を見るテストで
   * 毎回 4 段ぶん作る必要はない。
   */
  precompile: boolean
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
  /**
   * 測る条件を絞る。`?only=base,enemies` のような ascii 名の並び。
   *
   * **21 条件を全部回すと機械が熱で遅くなる。**知りたい条件だけを回す。
   * 空なら全条件。名前は `bench.ts` の `all` を見る
   */
  sweepOnly: string
}

export const DEFAULT_SEED = 20260816

/**
 * 既定の雲量。**正本は `pipeline/types.ts`。**
 *
 * ノイズを Nyquist 内へ収めた際に塊が育つ方向へ変わったので、点在する
 * 見え方を保つために 0.35 から下げた。写しを持っていた名残でここにも
 * 定義があったが、値は 1 つにした
 */
export { DEFAULT_COVERAGE } from './pipeline/types'

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
    showEnemies: params.get('enemies') !== '0',
    showDamageSmoke: params.get('dmgsmoke') !== '0',
    showFlares: params.get('flares') !== '0',
    showTracers: params.get('tracers') !== '0',
    showAircraft: params.get('aircraft') !== '0',
    showTrails: params.get('trails') !== '0',
    showMissiles: params.get('missiles') !== '0',
    showSmoke: params.get('smoke') !== '0',
    showExplosions: params.get('explosions') !== '0',
    showHud: params.has('hud')
      ? params.get('hud') === '1'
      : params.get('capture') !== '1',
    sound: params.has('sound')
      ? params.get('sound') === '1'
      : params.get('capture') !== '1',
    audioProbe: params.get('audioprobe') === '1',
    gpu: clampInt(params.get('gpu'), 0, 2, 0),
    noiseProbe: params.get('noiseprobe') === '1',
    shadowProbe: params.get('shadowprobe') === '1',
    marchProbe: params.get('marchprobe') === '1',
    converge: clampInt(params.get('converge'), 0, 16, 0),
    shadowInputs: decodeShadowInputs(params.get('shadowinputs')),
    cloudFar: params.has('cloudfar')
      ? clampNumber(params.get('cloudfar'), 500, 60_000, 26_000)
      : null,
    precompile: params.get('precompile') !== '0',
    bench: clampInt(params.get('bench'), 0, 200, 0),
    sweep: params.get('sweep') === '1',
    sweepOnly: params.get('only') ?? '',
  }
}

export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1'
}

/**
 * 操作の型を URL から読む。
 *
 * **既定は `expert`。**Phase 6.5 までの手ごたえはこの挙動で測ってあるので、
 * 指定がなければ何も変えない。段 8 で設定画面から選べるようにする。
 *
 * 不正な値は既定へ倒す。`resolvePreset` と同じ作法
 */
export function resolveControlMode(search: string): 'expert' | 'standard' {
  return new URLSearchParams(search).get('control') === 'standard'
    ? 'standard'
    : 'expert'
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
  /** 描画バックエンドの名前。`webgl` / `node-webgl` / `node-webgpu` */
  backend: string
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
  /** sim にいる敵機の数。台本の配置で決まる */
  enemyCount: number
  /** 描画が作った敵機の複製の数。生きている敵の数と一致するはず */
  enemyInstances: number
  /** 生きている敵機の数 */
  enemiesAlive: number
  /** 敵機 1 機の三角形数。読み込めていなければ 0 */
  enemyTriangles: number
  /** 敵機 1 機の動かせた舵面の枚数。5 枚あるはず */
  enemySurfaces: number
  /**
   * 敵機の AI の状態。生きている機だけを並べた文字列。
   *
   * `pursue,recover` のようにカンマで繋ぐ。数値にすると読めないので文字列で
   * 出す。E2E が状態の遷移を検査する
   */
  enemyAiStates: string
  /** 敵機 1 機目の前方の地形との余裕 m。敵がいなければ 0 */
  enemyClearance: number
  /** 敵機 1 機目の残り耐久の割合 0..1。敵がいなければ 0 */
  enemyIntegrityRatio: number
  /** 敵機 1 機目の煙の濃さ 0..1 */
  enemySmoke: number
  /** 傷ついている敵機の数。煙が出ている数と同じ */
  enemyDamaged: number
  /** 敵機が撃った弾の総数（全機の合計） */
  enemyRoundsFired: number
  /** 敵機が撃ったミサイルの総数（全機の合計） */
  enemyMissilesFired: number
  /** 飛んでいる敵のミサイルの数 */
  incomingMissiles: number
  /** ミサイル警告が出ているか */
  missileWarning: boolean
  /** 警告の方位 rad。0 が正面、+ が右、±π が真後ろ */
  missileBearing: number
  /** 警告の着弾までの秒 */
  missileTimeToImpact: number
  /** 残りのフレア */
  flaresLeft: number
  /** 操作の型。'expert' か 'standard' */
  controlMode: string
  /** 効果音の音量 0..1。設定画面から変わる */
  volume: number
  /** 効果音が使える状態か。START を押すまで false */
  audioReady: boolean
  /**
   * 生成済みのシェーダプログラム数（`renderer.info.programs`）。
   *
   * **フレーム中に増えたら、そこでコンパイルが走っている。**three は
   * マテリアルを作った時点ではなく、それを持つオブジェクトを最初に
   * 描くときにコンパイルする。爆発やフレアの初登場でカクつく原因になる
   */
  programs: number
  /** 起動時のシェーダ事前コンパイルにかかったミリ秒 */
  compileMs: number
  /**
   * 自機が降着装置を出しているか。
   *
   * **判定は sim が持つ**（`AircraftSample.gearDown`）。描画側に置くと
   * キャプチャモードで出ない
   */
  gearDown: boolean
  /**
   * 音の自己診断の結果。`?audioprobe=1` のときだけ埋まる。
   *
   * 5 つの音それぞれの rms と peak。**sim を import しない**という
   * `capture.ts` の作法に合わせ、型は素の数値だけで書く
   */
  audioProbe: Record<string, { rms: number; peak: number }> | null
  /**
   * node 経路の自己診断の結果。`?gpu=1` か `?gpu=2` のときだけ埋まる。
   *
   * **これが埋まったフレームは既定の経路を通っていない。**第 2 経路を
   * 立てて glb を 1 枚描いただけの状態で、シムも HUD も動いていない
   */
  gpuProbe: NodeProbeResult | null
  /**
   * 形状ノイズの中央スライスの生バイト。`?noiseprobe=1` のときだけ埋まる。
   *
   * RGBA8 で 1,024 個。JSON で運ぶので素の配列にする
   */
  noiseSlice: number[] | null
  /**
   * 気象マップの左下 16x16 の生バイト。`?noiseprobe=1` のときだけ埋まる。
   *
   * **雲の配置を決めるのは 3D ノイズではなくこちら**
   */
  weatherSlice: number[] | null
  /** 雲影マップ 256² の分布。16 ビン。`?shadowprobe=1` のときだけ埋まる */
  shadowHistogram: number[] | null
  /**
   * 雲影マップを 4x4 に区切った区画ごとの平均透過率。16 個。
   *
   * **分布だけでは影の配置を見張れない。**ノイズや気象マップを上下反転
   * しても 16 ビンの分布は動かないことを実測した
   */
  shadowTiles: number[] | null
  /**
   * その分布を焼いた入力。`?shadowprobe=1` のときだけ埋まる。
   *
   * TSL 版へ `?shadowinputs=` で渡し直すために出す
   */
  shadowInputs: ShadowInputs | null
  /**
   * 固定の入力で焼いた雲のマーチ。`?marchprobe=1` のときだけ埋まる。
   *
   * **`samples` と `exhausted` は整数。**TSL 版と完全に一致するはず
   */
  marchProbe: {
    samples: { total: number; max: number; hit: number }
    exhausted: number
    tiles: number[]
    /** 時間方向の足し込みの生バイト */
    resolve: number[]
    /**
     * 足し込みで現フレームから動いた画素の数。
     *
     * **0 なら履歴を読む枝を通っていない。**再投影が全部外れていても
     * 「両側で一致」にはなるので、通っていることを別に見張る
     */
    resolveChanged: number
  } | null
  /**
   * ミッションの決着。台本にミッションがなければ 'none'。
   *
   * `MissionOutcome` の写しではなく 'none' を足した別物。**sim を import
   * しない**という `capture.ts` の作法に合わせる
   */
  missionOutcome: string
  /** 残り時間 フレーム。ミッションがなければ 0 */
  missionRemaining: number
  /** 燃えているフレアの数 */
  flaresBurning: number
  /** 自機が受けた弾の数 */
  playerTaken: number
  /** 自機の残り耐久 */
  playerIntegrity: number
  /** 自機が撃墜された回数。1 になったらそこで終わり */
  playerLosses: number
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
  /** 飛んでいるミサイルの数 */
  missilesInFlight: number
  /** 描いたミサイルの数。sim の数と一致するはず */
  missilesDrawn: number
  /** 撃ったミサイルの総数 */
  missilesFired: number
  /** 残ミサイル */
  missilesLeft: number
  /** 生きている爆発の数 */
  explosionsAlive: number
  /** 描いた爆発の数。sim の数と一致するはず */
  explosionsDrawn: number
  /** 起こした爆発の総数 */
  explosionCount: number
  /** DLZ の 3 つの半径 m。ロックしていなければすべて 0 */
  dlzMax: number
  dlzNe: number
  dlzMin: number
  /** DLZ バーを出しているか */
  hudDlzBarShown: boolean
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
