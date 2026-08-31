import * as THREE from 'three'
import type { AircraftSample, AircraftTrailSource } from '../sim/aircraft'
import type { TargetSample } from '../sim/target'
import type { LookOffset } from '../input/mouseLook'
import { createChaseCamera, type ChaseCamera } from './camera'
import { createAircraftView, type AircraftView } from './aircraftView'
import { loadAircraftModel, type AircraftModel } from './aircraft/model'
import { loadCarrier, placeCarrier, type Carrier } from './carrier'
import { createTargetViews, type TargetViews } from './targetView'
import { createEnemyViews, type EnemyViews } from './enemyView'
import { createDamageSmoke, type DamageSmokeView } from './damageSmoke'
import type { DamageSmokeSource } from '../sim/damage'
import { createTracers, type Tracers } from './weapons/tracers'
import { createMissileViews, type MissileViews } from './weapons/missileView'
import { createMissileSmoke, type MissileSmoke } from './weapons/missileSmoke'
import { createFlares, type Flares } from './weapons/flares'
import { FLARE_CAPACITY, type Flare } from '../sim/weapons/flare'
import { createExplosions, type Explosions } from './weapons/explosions'
import type { ExplosionSource } from '../sim/effects'
import { BULLET_POOL, type BulletSource } from '../sim/weapons/gun'
import type { SmokeSource } from '../sim/weapons/missile'
import { MISSILE_COUNT } from '../sim/combat'
import { ENEMY_MISSILE_COUNT } from '../sim/ai/fighter'
import { EXPLOSION_POOL } from '../sim/effects'

/** 描画へ渡すミサイルの姿勢。補間済みの値を main が詰める */
export interface MissilePose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

export function createMissilePose(): MissilePose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
}
import { createAtmosphere, DEFAULT_HOUR, type AtmosphereHandle } from './atmosphere'
import { createComposer, type ComposerHandle } from './composer'
import {
  applyQualityOverride,
  getQuality,
  type QualityOverride,
  type PresetName,
  type QualitySettings,
  PRESET_ORDER,} from './quality'
import { createGpuTimer, type GpuTimer } from './gpuTimer'
import { createEnvironmentProbe, type EnvironmentProbe } from './environment'
import { createAircraftTrails, type AircraftTrails } from './aircraft/trails'
import {
  createAircraftShadow,
  type AircraftShadow,
  type ShadowLight,
} from './aircraftShadow'
import { generateCloudNoise, type CloudNoise } from './clouds/noise'
import { CloudsPass, SHADOW_EXTENT } from './clouds/cloudsPass'
import { cloudTime } from './clouds/geometry'
import {
  createTerrainMesh,
  createTerrainUniforms,
  type TerrainMesh,
} from './terrain/terrainMesh'
import { createWater, type Water } from './terrain/water'
import {
  createHeightTexture,
  createNormalTexture,
} from './terrain/heightTexture'
import { defaultTerrain, type Terrain, type TerrainStats } from '../sim/terrain'
import { FIXED_DT } from '../sim/loop'

/**
 * Phase 2 のシーン。
 *
 * 空は @takram/three-atmosphere による物理ベースの大気散乱。ライティングも
 * 大気の LUT から導かれるので、時刻を変えれば光の色と強さが一貫して変わる。
 *
 * 地面は起伏する地形と海面。高さ場は sim が持っていて、ここはそれを
 * テクスチャへ上げて頂点シェーダで引くだけ。
 */

/**
 * 大気ライブラリへ渡す地面のアルベド。
 *
 * 自前の地形と海面は 48 km と 300 km で切れるので、その先は大気ライブラリが
 * 持つ楕円体の地面が見える。島嶼と外洋の題材なので、境目が目立たないよう
 * 深い海の色に寄せる。
 */
const ATMOSPHERE_GROUND_ALBEDO = new THREE.Color(0x0a1c26)

/**
 * 計測用の描画の切り替え。
 *
 * 地形の費用は雲と違って実行量を数えられない。頂点とラスタライズが主なので、
 * 切って差分で測るしかない。省略した項目は現状のまま。
 */
/**
 * 切り替えの項目をすべて必須にした型。
 *
 * **`runBenchSweep` の `base` はこれを満たさないと型検査で落ちる。**
 * `setMeasureConfig` は `undefined` の項目を触らないので、`base` に無い
 * 項目は一度切ると二度と戻らない。実際に `enemies` で踏んだ。順番を
 * 1 周ごとにずらすので、最初の周で「敵機なし」を通った時点から全条件が
 * 敵機なしで測られ、三角形の総数が全行で同じ数のまま並んだ。
 *
 * 数値の項目（`lodDistanceScale` など）は除く。切り替えではないので
 * 戻し漏れが起きない。
 */
export type MeasureToggles = {
  [K in keyof MeasureConfig as boolean extends MeasureConfig[K] ? K : never]-?: boolean
}

export interface MeasureConfig {
  terrain?: boolean
  water?: boolean
  clouds?: boolean
  /** 空のフルスクリーンクアッド。遮蔽物を消すと逆に増える費用の切り分けに使う */
  sky?: boolean
  /** 地表の法線摂動。1 画素あたり値ノイズ 10 回ぶん */
  detailNormals?: boolean
  /** 機体 */
  aircraft?: boolean
  /** 環境反射。scene.environment を外す */
  environment?: boolean
  /** 機体の影。シェーダ側の参照を切る */
  aircraftShadow?: boolean
  /** コントレイルと翼端渦 */
  trails?: boolean
  /** 標的機 */
  targets?: boolean
  /** 敵機 */
  enemies?: boolean
  /** ダメージの煙 */
  damageSmoke?: boolean
  /** フレア */
  flares?: boolean
  /** 曳光弾 */
  tracers?: boolean
  /** ミサイルの本体 */
  missiles?: boolean
  /** ミサイルの煙 */
  smoke?: boolean
  /** 爆発 */
  explosions?: boolean
  lodDistanceScale?: number
  terrainPatchCells?: number
}

export interface SceneHandle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  chase: ChaseCamera
  /** 太陽高度 rad。デバッグ表示と E2E の検証に使う */
  readonly sunElevation: number
  /**
   * 太陽光と天空光の放射輝度。
   *
   * 外に出しておく理由がある。ライブラリのコンストラクタ引数の名前違いで
   * 太陽光の色が白のまま固定されていたのを、この値を実測して見つけた。
   * E2E から読めれば「時刻を変えると色が変わる」を数値で検査できる。
   */
  readonly sunRadiance: THREE.Vector3
  readonly skyRadiance: THREE.Vector3
  /** 雲ノイズの生成にかかったミリ秒。性能の記録用 */
  readonly noiseMs: number
  /** 雲ノイズが空でないことの確認用 */
  readonly noiseStats: { min: number; max: number; mean: number }
  /** GPU のフレーム時間 ms。拡張が無ければ 0 */
  readonly gpuFrameMs: number
  /** 直近しばらくの GPU フレーム時間の最大 ms。予算の判断はこちらで行う */
  readonly gpuFrameMaxMs: number
  /** そのうち雲のパスが占める ms */
  readonly gpuCloudMs: number
  /** 雲のパスの直近の最大 ms */
  readonly gpuCloudMaxMs: number
  /** GPU 時間の計測が使えるか */
  readonly gpuTimerSupported: boolean
  /** 雲の密度サンプル数の統計。?probe=1 のときだけ意味を持つ */
  readCloudProbe(): { mean: number; max: number; p99: number }
  /** 雲のバッファが 16bit 浮動小数か。8bit だと横線が出る */
  readonly cloudHdrTarget: boolean
  /** 高さ場の生成にかかったミリ秒 */
  readonly terrainMs: number
  /** 高さ場の中身。min と max が同じなら生成に失敗している */
  readonly terrainStats: TerrainStats
  /** 描いている地形パッチの枚数と三角形数。予算の確認に使う */
  readonly terrainPatches: number
  readonly terrainTriangles: number
  /** 機体の三角形数。読み込めていなければ 0 */
  readonly aircraftTriangles: number
  /** 作った標的機の複製の数。三角形はこの数だけ増える */
  readonly targetInstances: number
  /** 作った敵機の複製の数。三角形はこの数だけ増える */
  readonly enemyInstances: number
  /** 敵機 1 機の三角形数。読み込めていなければ 0 */
  readonly enemyTriangles: number
  /** 敵機 1 機の動かせた舵面の枚数 */
  readonly enemySurfaces: number
  /** 描いた曳光弾の線分の数。5 発に 1 発なので飛行中の弾の 1/5 前後 */
  readonly tracersDrawn: number
  /** 描いたミサイルの数 */
  readonly missilesDrawn: number
  /** 描いた爆発の数 */
  readonly explosionsDrawn: number
  /**
   * ビュー射影行列。列優先 16 要素。
   *
   * HUD がこれだけを受け取って投影する。**HUD 側は three に触らない。**
   * 行列の出どころは three のカメラ 1 つのままで、投影の算術は node の
   * 単体テストで固定できる（`src/hud/project.ts`）。
   */
  readonly viewProjection: ArrayLike<number>
  /** 動かせた舵面の枚数。6 枚あるはず */
  readonly aircraftSurfaces: number
  /** 環境反射が焼けているか。プリセットで切っていれば false */
  readonly environmentReady: boolean
  /** 機体の影マップが焼けているか。プリセットで切っていれば false */
  readonly aircraftShadowReady: boolean
  /**
   * 直前のフレームで実際に投入したドローコールと三角形。
   *
   * 予算の確認に使う。それ以上に、何かが描かれていないことの検出に使う。
   * 影を入れたときに地形が消えた事故は、この数字を見て切り分けた。
   */
  readonly drawCalls: number
  readonly drawnTriangles: number
  readonly quality: QualitySettings
  /**
   * sim の状態を描画へ反映する。
   *
   * @param frame sim のフレーム番号。雲の流れをここから導くので実時間は渡さない
   */
  sync(
    sample: AircraftSample,
    targets: readonly TargetSample[],
    enemies: readonly AircraftSample[],
    missiles: readonly MissilePose[],
    frame: number,
    dt: number,
    look: LookOffset,
    snap?: boolean,
  ): void
  render(): void
  /**
   * 内側の計測を挟まずに 1 枚描く。計測モード専用。
   *
   * 通常の render() はフレーム全体と雲のパスを 1 枚おきに交互で測っている
   * （TIME_ELAPSED は入れ子にできないため）。計測中にそれが混ざると 1 枚ごとに
   * クエリの有無が変わって値が揺れる。外側からクエリを張れるように、
   * ここでは内側の計測を一切しない。
   */
  renderPlain(): void
  /**
   * シェーダを先に全部コンパイルする。
   *
   * **three は「マテリアルを作ったとき」ではなく「それを持つオブジェクトを
   * 最初に描くとき」にコンパイルする。**爆発・フレア・曳光弾・ミサイルは
   * 出るまで描かれないので、初登場のフレームでまとめて走る。
   *
   * 実測（SwiftShader、`?script=mission-01`）。起動直後は 25 プログラム。
   * 初弾を撃った瞬間に 13 個が増え、そのフレームが 772.9 ms かかった。
   * フレアの初投下で +2（192.4 ms）、爆発とミサイルの初回で +1（143.4 ms）。
   *
   * `renderer.compile` は `scene.traverse` で回るので、`visible = false` や
   * インスタンス数 0 のものも拾う。`compileAsync` は
   * `KHR_parallel_shader_compile` があればドライバに並列で投げる。
   *
   * 読み込み表示を出している間に呼ぶ。**遊び始めてからの予算を空ける。**
   */
  compileShaders(): Promise<void>
  /**
   * 4 段のプリセットぶんのシェーダを先に作る。
   *
   * **品質を落とすと全マテリアルのプログラムが作り直される。**プリセットで
   * 影のマップ解像度が変わり、それが `getProgramCacheKey` に入るため
   * （実測で `...,306,512,...` と `...,306,256,...` の 1 か所だけが違った）。
   *
   * `PerformanceGovernor` は 3 秒連続で 55 fps を割ると 1 段落とす。その
   * 瞬間に機体のマテリアル 13 個がまとめてコンパイルされ、実測で 772.9 ms
   * 止まった（SwiftShader）。**軽くするための降格が、その瞬間に最大の
   * スパイクを作っていた。**`?nodegrade=1` にすると消えることを確かめた。
   *
   * 起動時に全段ぶん作っておけば、降格しても切り替えるだけで済む。
   * 読み込み表示を出している間に済ませる。
   */
  compileAllPresets(
    current: PresetName,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void>
  resize(width: number, height: number, devicePixelRatio: number): void
  setQuality(preset: PresetName): void
  /**
   * 軌跡の履歴を読む先を渡す。
   *
   * サンプルには載せない。毎フレーム 256 本を写すのは無駄なので、
   * `Aircraft` から直接読む。ワールドを作り直したら呼び直す。
   */
  setTrailSource(source: AircraftTrailSource | null): void
  /**
   * 弾を読む先を渡す。
   *
   * サンプルには載せない。飛行中の弾は 250 発あり、毎フレーム写すのは無駄。
   * 履歴と同じ作法で `Gun` から直接読む。ワールドを作り直したら呼び直す。
   *
   * **複数ある。**自機と生きている敵機がそれぞれ自分の機銃を持つ
   */
  setBulletSources(sources: readonly BulletSource[]): void
  /** 煙の履歴を読む先を渡す。ワールドを作り直したら呼び直す */
  setSmokeSources(sources: readonly SmokeSource[]): void
  /** ダメージの煙の履歴を読む先を渡す。ワールドを作り直したら呼び直す */
  setDamageSmokeSources(sources: readonly DamageSmokeSource[]): void
  /** フレアの読み口。`World.countermeasures.flares` を渡す */
  setFlareSources(sources: readonly Flare[]): void
  /** 爆発を読む先を渡す。ワールドを作り直したら呼び直す */
  setExplosionSource(source: ExplosionSource | null): void
  /** 計測用に描画の一部を切り替える。?sweep=1 のときだけ使う */
  setMeasureConfig(config: MeasureConfig): void
  setHour(hour: number): void
  setExposure(value: number): void
  dispose(): void
}

/**
 * トーンマッピングの露出。
 *
 * 大気ライブラリが返す相対輝度を表示域へ持ち上げる係数。1 のままだと真昼でも
 * 空の輝度が 255 中 62 にしかならない。5 から 40 まで振って絵で比べ、空に
 * 深みが残り地面の緑も飛ばない 6 を採った。経緯は
 * docs/decisions/0002-atmosphere-integration.md にある。
 */
export const DEFAULT_EXPOSURE = 6

/** 既定の雲量。点在する積雲になる値 */
export const DEFAULT_COVERAGE = 0.3

/**
 * 同時に出せる標的機の上限。
 *
 * Phase 7 のミッション 01 が敵 8 機撃墜なので、器はそこに合わせておく。
 * 複製は使う数だけ作るので、余らせても費用はかからない。
 */
export const MAX_TARGETS = 8

/** 同時に描けるミサイルの数。自機ぶん + 敵 8 機ぶん */
const MISSILE_CAPACITY = MISSILE_COUNT + MAX_TARGETS * ENEMY_MISSILE_COUNT

export interface SceneOptions {
  preset: PresetName
  hour?: number
  /** 雲量 0..1 */
  coverage?: number
  /** トーンマッピングの露出。調整用に上書きできる */
  exposure?: number
  /** 大気の LUT を置いた URL */
  texturesUrl: string
  /** 機体モデルの glb の URL */
  aircraftUrl: string
  /** 敵機モデルの glb の URL */
  enemyUrl: string
  /**
   * 空母の glb の URL。省略すると出さない。
   *
   * **省略できるようにしてある。**基準画像 42 枚のうち 38 枚は空母の無い
   * 海を撮ってあるので、既定で出すとその 38 枚が差分を出す。台本が要求した
   * ときだけ置く。枚数は `tests/tools/scenes.test.ts` が固定する
   */
  carrierUrl?: string
  /** 空母を置く位置と艦首の向き。`carrierUrl` があるときだけ意味を持つ */
  carrier?: { x: number; z: number; heading: number }
  /** プリセットの上書き。実機でつまみを振るときに使う */
  qualityOverride?: QualityOverride
  /** 雲バッファの持ち方の比較用。決着したら消す */
  /** 1 = 密度サンプル数、2 = 歩数を使い切ったか */
  cloudProbe?: number
  /** 時間方向の足し込みを使うか。比較用 */
  cloudTemporal?: boolean
  /** キャプチャモードか。雲の収束の重み付けが変わる */
  cloudCaptureMode?: boolean
  /** 地形と海面を描くか。GPU 時間の内訳を差分で測るための切り替え */
  showTerrain?: boolean
  showWater?: boolean
  /** 環境反射を使うか。質感の比較に使う */
  showEnvironment?: boolean
  /** 機体の影を使うか。切り分けと計測に使う */
  showAircraftShadow?: boolean
  /** 標的機を描くか。差分で標的の画素だけを取り出すのに使う */
  showTargets?: boolean
  /** 敵機を描くか。差分で敵の画素だけを取り出すのに使う */
  showEnemies?: boolean
  /** ダメージの煙を描くか。差分で断面を測るのに使う */
  showDamageSmoke?: boolean
  showFlares?: boolean
  /** 曳光弾を描くか。差分で見え方を測るのに使う */
  showTracers?: boolean
  /** 自機を描くか。煙や曳光弾の断面を測るのに使う */
  showAircraft?: boolean
  /** 翼端渦とコントレイルを描くか。断面を測るのに使う */
  showTrails?: boolean
  /** ミサイルの本体を描くか */
  showMissiles?: boolean
  /** ミサイルの煙を描くか。差分で断面を測るのに使う */
  showSmoke?: boolean
  /** 爆発を描くか。差分で寄与を測るのに使う */
  showExplosions?: boolean
}

/**
 * シーンを組み立てる。
 *
 * 大気の LUT 読み込みが非同期なので Promise を返す。呼び出し側は await して
 * から描画ループを回すこと。待たずに描くとテクスチャのない絵になる。
 */
export async function createScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<SceneHandle> {
  const qualityOverride = options.qualityOverride ?? {}
  let quality = applyQualityOverride(getQuality(options.preset), qualityOverride)

  const renderer = new THREE.WebGLRenderer({
    canvas,
    // ポストプロセス側で SMAA をかけるので、ここでは無効にする
    antialias: false,
    powerPreference: 'high-performance',
  })
  // トーンマッピングは EffectComposer の最後段が持つ。ここでは二重に掛けない。
  //
  // ただし露出はレンダラ側の値がポスト側のシェーダへ渡る。大気ライブラリは
  // 輝度を「単位放射輝度の太陽の輝度」で正規化して返すので、空はその何桁も
  // 下の値になる。掛け直さないと真昼でも薄暗い絵にしかならない。
  renderer.toneMapping = THREE.NoToneMapping
  // 統計を自動で消させない。既定では renderer.render() ごとに 0 へ戻るので、
  // 最後のポストパスだけが残って「ドローコール 1」に見える。フレームの頭で
  // 自分で消して、合計を読む
  renderer.info.autoReset = false
  renderer.toneMappingExposure = options.exposure ?? DEFAULT_EXPOSURE

  const scene = new THREE.Scene()
  // near 0.5 / far 400,000 だと比が 80 万あり、地形が遠くまで伸びると遠景の
  // 稜線で z ファイティングが出る。追従カメラは機体の 23 m 後方にいるので
  // near 5 m で切れるものはない。far は地形 48 km と海面 300 km を覆えれば
  // 足りる。比が 4 万になり精度は 20 倍良くなる。
  //
  // 対数深度バッファは使えない。雲シェーダが標準の射影式で深度を線形化して
  // いるので、深度の分布を変えると壊れる
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 5, 200_000)
  const chase = createChaseCamera(camera)

  const atmosphere: AtmosphereHandle = await createAtmosphere(renderer, camera, {
    texturesUrl: options.texturesUrl,
    hour: options.hour ?? DEFAULT_HOUR,
    groundAlbedo: ATMOSPHERE_GROUND_ALBEDO,
  })

  scene.add(atmosphere.sky)
  scene.add(atmosphere.sunLight)
  scene.add(atmosphere.sunLight.target)
  scene.add(atmosphere.skyLight)

  // 雲のノイズを焼く。起動時の一度だけで、以降は使い回す
  const noise: CloudNoise = generateCloudNoise(renderer)

  // 地形。高さ場は sim が持つ。ここはテクスチャへ上げて頂点シェーダで引くだけ。
  // 生成時間は sim 層で測れない（performance.now() が使えない）のでここで挟む
  const terrainStart = performance.now()
  const terrain: Terrain = defaultTerrain()
  const terrainMs = performance.now() - terrainStart

  const heightTexture = createHeightTexture(terrain)
  const normalTexture = createNormalTexture(terrain)

  // 地形と海面でユニフォームを共有する。毎フレーム同じ値を 2 回書かない。
  // 雲影のテクスチャは CloudsPass を作ったあとで差し込む
  const terrainUniforms = createTerrainUniforms(terrain, SHADOW_EXTENT)
  terrainUniforms.heightMap.value = heightTexture
  terrainUniforms.terrainNormalMap.value = normalTexture

  const terrainMesh: TerrainMesh = createTerrainMesh(terrain, quality, terrainUniforms)
  terrainMesh.mesh.visible = options.showTerrain ?? true
  scene.add(terrainMesh.mesh)

  const water: Water = createWater(quality, terrainUniforms)
  water.mesh.visible = options.showWater ?? true
  scene.add(water.mesh)

  // glb を読むのはここ 1 回だけ。自機と標的機が同じモデルを共有する。
  // 2 回読むとパースとテクスチャの復号が 2 度走り、実体が複製される
  const aircraftModel: AircraftModel = await loadAircraftModel(options.aircraftUrl)
  const aircraft: AircraftView = createAircraftView(aircraftModel)
  aircraft.object.visible = options.showAircraft ?? true
  scene.add(aircraft.object)

  // 標的機。複製は必要になった時点で作る。Phase 6 のミッションが敵 8 機なので
  // 器はそこまで用意しておく
  const targetViews: TargetViews = createTargetViews(aircraftModel, MAX_TARGETS)
  targetViews.object.visible = options.showTargets ?? true
  scene.add(targetViews.object)

  // 敵機。自機とは別の機体（F-16）なので glb も別。**敵味方が別の形になる
  // ので、ロックボックスが出ていなくても見分けられる**
  const enemyModel: AircraftModel = await loadAircraftModel(options.enemyUrl)
  const enemyViews: EnemyViews = createEnemyViews(enemyModel, MAX_TARGETS)
  enemyViews.object.visible = options.showEnemies ?? true
  scene.add(enemyViews.object)

  /**
   * 空母。**台本が要求したときだけ読む。**
   *
   * 実測で 2,644 三角形（シーン予算 1.5M の 0.18%）、glb 189 KB。
   * 動かないので視錐台の判定は残す
   */
  const carrier: Carrier | null =
    options.carrierUrl !== undefined ? await loadCarrier(options.carrierUrl) : null
  if (carrier !== null) {
    const at = options.carrier ?? { x: 0, z: 0, heading: 0 }
    placeCarrier(carrier, at.x, at.z, at.heading)
    scene.add(carrier.object)
  }

  // 曳光弾。5 発に 1 発なので線分は 55 本ぶん確保すれば足りるが、
  // プールと同じ大きさにしておけば割合を変えても壊れない
  const tracers: Tracers = createTracers(BULLET_POOL)
  tracers.object.visible = options.showTracers ?? true
  scene.add(tracers.object)

  // ミサイルの本体と煙
  // **敵のミサイルぶんも要る。**容量が足りないと、飛んでいるのに描かれない
  const missileViews: MissileViews = createMissileViews(MISSILE_CAPACITY)
  missileViews.object.visible = options.showMissiles ?? true
  scene.add(missileViews.object)
  const missileSmoke: MissileSmoke = createMissileSmoke(MISSILE_CAPACITY, quality)
  missileSmoke.object.visible = options.showSmoke ?? true
  scene.add(missileSmoke.object)

  // ダメージの煙。敵機ごとに 1 本
  const damageSmoke: DamageSmokeView = createDamageSmoke(MAX_TARGETS, quality)
  damageSmoke.object.visible = options.showDamageSmoke ?? true
  scene.add(damageSmoke.object)

  // 爆発。同時に生きるのは撃墜が重なったときくらいなので 8 個
  const explosions: Explosions = createExplosions(EXPLOSION_POOL, quality)
  explosions.object.visible = options.showExplosions ?? true
  scene.add(explosions.object)

  // フレア。積んでいる数ぶんの器を作る。同時に燃えるのはもっと少ないが、
  // 器を増やさないので使い回しで足りる
  // 自機ぶん + 敵 8 機ぶん。同時に燃えるのはずっと少ないが、器を使い回す
  const flares: Flares = createFlares(FLARE_CAPACITY * (1 + MAX_TARGETS), quality)
  flares.object.visible = options.showFlares ?? true
  scene.add(flares.object)

  // 機体の影。影マップ 1 枚で自己遮蔽と対地影の両方をまかなう
  // コントレイルと翼端渦。履歴は sim が持つので、ここは読んで張るだけ
  const trails: AircraftTrails = createAircraftTrails(quality)
  trails.object.visible = options.showTrails ?? true
  scene.add(trails.object)

  const aircraftShadow: AircraftShadow = createAircraftShadow({
    renderer,
    light: atmosphere.sunLight as ShadowLight,
    caster: aircraft.object,
    quality,
  })
  terrainUniforms.aircraftShadowMatrix.value = aircraftShadow.matrix

  // 環境反射を空から焼く。機体を追加したあとに作ると、焼くあいだに機体を
  // 隠す処理が効く（自分の映り込みを取り込まないため）
  const environment: EnvironmentProbe = createEnvironmentProbe({
    renderer,
    scene,
    sky: atmosphere.sky,
    quality,
  })
  scene.environment = (options.showEnvironment ?? true) ? environment.texture : null

  const cloudsPass = new CloudsPass({
    camera,
    noise,
    quality,
    coverage: options.coverage ?? DEFAULT_COVERAGE,
    ...(options.cloudProbe !== undefined ? { probe: options.cloudProbe } : {}),
    ...(options.cloudTemporal !== undefined ? { temporal: options.cloudTemporal } : {}),
    ...(options.cloudCaptureMode !== undefined ? { captureMode: options.cloudCaptureMode } : {}),
  })
  // 雲を大気の合成点へ差し込む。合成の順序はライブラリ側が持つ
  atmosphere.setOverlay({ map: cloudsPass.texture })

  const composer: ComposerHandle = createComposer({
    renderer,
    scene,
    camera,
    aerialPerspective: atmosphere.effect,
    cloudsPass,
    quality,
  })

  terrainUniforms.cloudShadowMap.value = cloudsPass.shadowTexture

  const gpuTimer: GpuTimer = createGpuTimer(renderer)
  /** 雲のパスを描いているか。計測で切ったときは影の焼き込みも止める */
  let cloudsEnabled = true
  let measureClouds = false
  const shadowCenter = new THREE.Vector2()
  const cameraWorld = new THREE.Vector3()
  /** 影の箱を合わせるのに使う。毎フレーム作らない */
  const aircraftPosition = new THREE.Vector3()

  const shadowAllowed = options.showAircraftShadow ?? true
  /** 軌跡の履歴を読む先。main が World を作ったあとに渡す */
  let trailSource: AircraftTrailSource | null = null
  /** 弾を読む先。main が World を作ったあとに渡す */
  let bulletSources: readonly BulletSource[] = []
  /** 煙の履歴を読む先 */
  let smokeSources: readonly SmokeSource[] = []
  let damageSmokeSources: readonly DamageSmokeSource[] = []
  let flareSources: readonly Flare[] = []
  /** 爆発を読む先 */
  let explosionSource: ExplosionSource | null = null
  // 軌跡の先頭。使い回す
  const trailHead = {
    position: new THREE.Vector3(),
    right: new THREE.Vector3(),
    wingtipVapor: 0,
    altitude: 0,
    throttle: 0,
  }
  const trailHeadQuaternion = new THREE.Quaternion()
  // 視線方向。near 面の手前で軌跡を終端するのに使う
  const cameraForward = new THREE.Vector3()
  /** 計測で影を切っているか。setMeasureConfig から動かす */
  let measureShadow = true

  /** 影のユニフォームを入れ直す。描画のたびに呼ぶ */
  function updateShadowUniforms(): void {
    // 型を合わせるため、切っているときも深度テクスチャを束縛したままにする
    terrainUniforms.aircraftShadowMap.value = aircraftShadow.depthTexture
    terrainUniforms.aircraftShadowEnabled.value =
      shadowAllowed && measureShadow && aircraftShadow.ready ? 1 : 0
    terrainUniforms.aircraftShadowTexel.value =
      1 / Math.max(1, quality.aircraftShadowMapSize)
  }
  const quaternion = new THREE.Quaternion()
  /** HUD へ渡すビュー射影行列。毎フレーム組み直す */
  const viewProjection = new THREE.Matrix4()
  let cssWidth = 1280
  let cssHeight = 720
  let dpr = 1

  function applySize(): void {
    const ratio = Math.min(dpr, quality.maxPixelRatio) * quality.renderScale
    renderer.setPixelRatio(ratio)
    // composer が内部でレンダラのサイズも合わせる。CSS は stylesheet 任せ
    composer.setSize(cssWidth, cssHeight, false)
    camera.aspect = cssWidth / cssHeight
    camera.updateProjectionMatrix()
  }

  /**
   * 品質プリセットを当てる。
   *
   * ハンドルの外に置いてあるのは `compileAllPresets` が呼ぶため。
   * メソッドどうしを `this` で呼ぶと、オブジェクトリテラルの推論が
   * `SceneHandle | PromiseLike<SceneHandle>` になって型が付かない
   */
  /**
   * 内側の計測を挟まずに 1 枚描く。
   *
   * ハンドルの外に置いてあるのは `compileAllPresets` が呼ぶため
   */
  function renderPlainImpl(): void {
    renderer.info.reset()
    updateShadowUniforms()
    cloudsPass.setTimingEnabled(false)
    // 雲を切っているときは影も焼かない。切った意味がなくなる
    if (cloudsEnabled) cloudsPass.renderShadow(renderer)
    composer.render()
  }

  function applyPreset(preset: PresetName): void {
    quality = applyQualityOverride(getQuality(preset), qualityOverride)
    composer.setQuality(quality)
    cloudsPass.setQuality(quality)
    terrainMesh.setQuality(quality)
    water.setQuality(quality)
    trails.setQuality(quality)
    missileSmoke.setQuality(quality)
    damageSmoke.setQuality(quality)
    explosions.setQuality(quality)
    environment.setQuality(quality)
    scene.environment = environment.texture
    aircraftShadow.setQuality(quality)
    applySize()
  }

  return {
    renderer,
    scene,
    camera,
    chase,

    get sunRadiance() {
      return atmosphere.sunRadiance
    },

    get skyRadiance() {
      return atmosphere.skyRadiance
    },

    get sunElevation() {
      return atmosphere.sunElevation
    },

    get noiseMs() {
      return noise.elapsedMs
    },

    get noiseStats() {
      return noise.stats
    },

    get gpuFrameMs() {
      return gpuTimer.lastMs
    },

    get gpuFrameMaxMs() {
      return gpuTimer.maxMs
    },

    get gpuCloudMs() {
      return cloudsPass.gpuMs
    },

    get gpuCloudMaxMs() {
      return cloudsPass.gpuMaxMs
    },

    get gpuTimerSupported() {
      return gpuTimer.supported
    },

    get cloudHdrTarget() {
      return cloudsPass.isHdrTarget
    },

    get terrainMs() {
      return terrainMs
    },

    get terrainStats() {
      return terrain.stats
    },

    get aircraftTriangles() {
      return aircraft.triangles
    },

    get aircraftSurfaces() {
      return aircraft.surfaceCount
    },

    get targetInstances() {
      return targetViews.instanceCount
    },

    get enemyInstances() {
      return enemyViews.instanceCount
    },

    get enemyTriangles() {
      return enemyViews.trianglesPerAircraft
    },

    get enemySurfaces() {
      return enemyViews.surfaceCount
    },

    get tracersDrawn() {
      return tracers.drawn
    },

    get missilesDrawn() {
      return missileViews.drawn
    },

    get explosionsDrawn() {
      return explosions.drawn
    },

    get viewProjection() {
      return viewProjection.elements
    },

    get environmentReady() {
      return scene.environment !== null
    },

    get drawCalls() {
      return renderer.info.render.calls
    },

    get drawnTriangles() {
      return renderer.info.render.triangles
    },

    get aircraftShadowReady() {
      return aircraftShadow.ready
    },

    get terrainPatches() {
      return terrainMesh.patchCount
    },

    get terrainTriangles() {
      return terrainMesh.triangleCount
    },

    readCloudProbe() {
      return cloudsPass.readProbe(renderer)
    },

    get quality() {
      return quality
    },

    sync(sample, targets, enemies, missiles, frame, dt, look, snap = false) {
      targetViews.update(targets)
      enemyViews.update(enemies)
      missileViews.update(missiles)

      aircraft.object.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      quaternion.set(
        sample.orientation.x,
        sample.orientation.y,
        sample.orientation.z,
        sample.orientation.w,
      )
      aircraft.object.quaternion.copy(quaternion)
      aircraft.setThrottle(sample.throttle)
      // 舵面は sim が持つ位置をそのまま渡す。描画側で入力を読むと
      // キャプチャモードで再現しない
      aircraft.setControls(sample.elevator, sample.aileron, sample.rudder)
      // **判定は sim が持つ。**ここで高度を見て切り替えると、キャプチャ
      // モード（`sync()` が 1 回だけ）で出ない
      aircraft.setGearDown(sample.gearDown)

      // 太陽光と天空光の基準位置を機体に合わせる。高度によって透過率が変わる。
      // ライト本体の位置は update() が太陽方向から決めるので触らない
      atmosphere.sunLight.target.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      atmosphere.skyLight.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      // 影の箱を機体に合わせる。太陽光の位置は atmosphere.update() が
      // target + sunDirection * distance で決めるので、その前に動かす
      aircraftPosition.set(sample.position.x, sample.position.y, sample.position.z)
      aircraftShadow.update(aircraftPosition, atmosphere.sunDirectionWorld)
      atmosphere.update()

      if (snap) chase.snap(sample, look)
      else chase.update(sample, dt, look)

      // 雲の流れは実時間ではなく sim のフレーム番号から導く。
      // これでキャプチャモードの絵が固定される
      shadowCenter.set(sample.position.x, sample.position.z)
      cloudsPass.update({
        cloudTime: cloudTime(frame, FIXED_DT),
        sunDirection: atmosphere.sunDirectionWorld,
        sunColor: atmosphere.sunRadiance,
        ambientColor: atmosphere.skyRadiance,
        coverage: options.coverage ?? DEFAULT_COVERAGE,
        shadowCenter,
        groundShadow: quality.cloudGroundShadow,
      })

      // 地形と海面が参照する雲影の領域も合わせる
      terrainUniforms.cloudShadowCenter.value.copy(shadowCenter)
      terrainUniforms.cloudShadowEnabled.value = quality.cloudGroundShadow ? 1 : 0

      // ライティングは自前で組む。MeshStandardMaterial を使わないので three の
      // ライトは効かない。大気ライブラリの放射輝度をそのまま渡す
      terrainUniforms.sunDirectionWorld.value.copy(atmosphere.sunDirectionWorld)
      terrainUniforms.sunRadiance.value.copy(atmosphere.sunRadiance)
      terrainUniforms.skyRadiance.value.copy(atmosphere.skyRadiance)

      // LOD はカメラ位置で決める。機体位置ではない（追従カメラは後方にいる）。
      // chase の更新後に読むこと
      camera.getWorldPosition(cameraWorld)

      // HUD へ渡す行列。カメラの位置と画角が決まったあとに組む。
      // Camera.updateMatrixWorld が matrixWorldInverse も作り直す
      camera.updateMatrixWorld()
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

      // 軌跡。リボンをカメラへ向けるのでカメラ位置を渡す。
      // 先頭は履歴ではなく補間した現在の翼端に繋ぐ。履歴は 1/30 秒ごとにしか
      // 記録しないので、そのままだと翼端との間に隙間が空いて直角に切れて見える
      if (trailSource !== null) {
        trailHead.position.set(sample.position.x, sample.position.y, sample.position.z)
        trailHeadQuaternion.set(
          sample.orientation.x,
          sample.orientation.y,
          sample.orientation.z,
          sample.orientation.w,
        )
        trailHead.right.set(1, 0, 0).applyQuaternion(trailHeadQuaternion)
        trailHead.wingtipVapor = sample.wingtipVapor
        trailHead.altitude = sample.altitude
        trailHead.throttle = sample.throttle
        camera.getWorldDirection(cameraForward)
        trails.update(trailSource, cameraWorld, cameraForward, trailHead)
      }
      // 曳光弾。near 面の手前で終端するので視線方向が要る。
      // 軌跡と同じ理由でカメラの向きを渡す
      if (bulletSources.length > 0) {
        camera.getWorldDirection(cameraForward)
        // 画面 1 画素が張る角度。曳光弾の幅を画面基準にするのに渡す。
        // CSS 画素で測る（HUD と同じ基準）。画角は速度で変わるので毎フレーム
        const radiansPerPixel =
          (2 * Math.tan(((camera.fov * Math.PI) / 180) * 0.5)) / cssHeight
        tracers.update(bulletSources, cameraWorld, cameraForward, radiansPerPixel)
      }

      // 煙。**発射した位置から前方へ伸びるので、カメラがその中を通る。**
      // near 面の終端は Ribbon が必ず通すので、視線方向を渡すだけでよい
      camera.getWorldDirection(cameraForward)
      missileSmoke.update(smokeSources, cameraWorld, cameraForward)
      damageSmoke.update(damageSmokeSources, cameraWorld, cameraForward)
      // フレア。**自機のすぐ後ろに出るのでカメラの至近を通る。**
      // 板が near 面を跨がないよう clampRadiusToNear で絞る
      flares.update(flareSources, cameraWorld, cameraForward)

      // 爆発。**経過秒はフレーム番号から出す。**実時間を渡すと
      // キャプチャモードで絵が固定されない
      if (explosionSource !== null) {
        explosions.update(explosionSource, frame, cameraWorld, cameraForward)
      }

      terrainMesh.update(cameraWorld.x, cameraWorld.z)
      water.follow(cameraWorld.x, cameraWorld.z)
      // 波の位相もフレーム番号から導く。実時間を使うと絵が固定されない
      water.setWaveTime(cloudTime(frame, FIXED_DT))
    },

    async compileShaders() {
      await renderer.compileAsync(scene, camera)
    },

    async compileAllPresets(current, onProgress) {
      let done = 0
      for (const name of PRESET_ORDER) {
        onProgress?.(done, PRESET_ORDER.length)
        applyPreset(name)
        await renderer.compileAsync(scene, camera)
        // **実際に 1 枚描く。**`compileAsync` だけでは足りない。影の状態が
        // 変わったことによる作り直しは `WebGLRenderer.setProgram` の中で
        // 判定されるので、描かないと起きない。実測で、medium を当てて
        // `compileAsync` を呼んでも medium 用の機体プログラムは 1 つも
        // 作られなかった（起動後の分布が `306,512` の 10 個だけだった）
        renderPlainImpl()
        done++
      }
      onProgress?.(done, PRESET_ORDER.length)
      // **最後に戻す。**呼ぶ前の見た目に影響を残さない
      applyPreset(current)
      await renderer.compileAsync(scene, camera)
      renderPlainImpl()
    },

    render() {
      renderer.info.reset()
      // 影のテクスチャは three が最初の描画で作る。sync() で入れると
      // 1 枚目が null のままになり、キャプチャモード（sync は 1 回だけ、
      // 描画は 8 回）では影がまったく出ない。毎フレームここで入れ直す
      updateShadowUniforms()

      // TIME_ELAPSED クエリは入れ子にできない。フレーム全体と雲のパスを
      // 1 フレームおきに交互で測る。どちらも定常状態なので値は使える
      measureClouds = !measureClouds
      cloudsPass.setTimingEnabled(measureClouds)

      if (!measureClouds) gpuTimer.begin()
      // 雲影は地面を描く前に焼く。composer の中では手遅れになる
      cloudsPass.renderShadow(renderer)
      composer.render()
      if (!measureClouds) gpuTimer.end()
    },

    renderPlain: renderPlainImpl,

    resize(width, height, devicePixelRatio) {
      cssWidth = width
      cssHeight = height
      dpr = devicePixelRatio
      applySize()
    },

    setTrailSource(source) {
      trailSource = source
    },

    setBulletSources(sources) {
      bulletSources = sources
    },

    setSmokeSources(sources) {
      smokeSources = sources
    },

    setDamageSmokeSources(sources) {
      damageSmokeSources = sources
    },

    setFlareSources(sources) {
      flareSources = sources
    },

    setExplosionSource(source) {
      explosionSource = source
    },

    setMeasureConfig(config) {
      if (config.terrain !== undefined) terrainMesh.mesh.visible = config.terrain
      if (config.water !== undefined) water.mesh.visible = config.water
      if (config.sky !== undefined) atmosphere.sky.visible = config.sky
      if (config.aircraft !== undefined) aircraft.object.visible = config.aircraft
      if (config.environment !== undefined) {
        scene.environment = config.environment ? environment.texture : null
      }
      if (config.aircraftShadow !== undefined) measureShadow = config.aircraftShadow
      if (config.trails !== undefined) trails.object.visible = config.trails
      if (config.targets !== undefined) targetViews.object.visible = config.targets
      if (config.enemies !== undefined) enemyViews.object.visible = config.enemies
      if (config.damageSmoke !== undefined) {
        damageSmoke.object.visible = config.damageSmoke
      }
      if (config.flares !== undefined) flares.object.visible = config.flares
      if (config.tracers !== undefined) tracers.object.visible = config.tracers
      if (config.missiles !== undefined) missileViews.object.visible = config.missiles
      if (config.smoke !== undefined) missileSmoke.object.visible = config.smoke
      if (config.explosions !== undefined) {
        explosions.object.visible = config.explosions
      }
      if (config.detailNormals !== undefined) {
        terrainMesh.setDetailNormals(config.detailNormals)
      }
      if (config.clouds !== undefined) {
        cloudsEnabled = config.clouds
        cloudsPass.enabled = config.clouds
        // 差し込み口も外す。外さないと最後に焼いた雲が残り続ける
        atmosphere.setOverlay(config.clouds ? { map: cloudsPass.texture } : null)
      }
      if (
        config.lodDistanceScale !== undefined ||
        config.terrainPatchCells !== undefined
      ) {
        quality = applyQualityOverride(quality, {
          ...(config.lodDistanceScale !== undefined
            ? { lodDistanceScale: config.lodDistanceScale }
            : {}),
          ...(config.terrainPatchCells !== undefined
            ? { terrainPatchCells: config.terrainPatchCells }
            : {}),
        })
        terrainMesh.setQuality(quality)
        // パッチを選び直さないと、セル数だけ変わって枚数が古いままになる
        terrainMesh.update(cameraWorld.x, cameraWorld.z)
      }
    },

    setQuality: applyPreset,

    setHour(hour) {
      atmosphere.setHour(hour)
      // 空が変わったら環境反射も焼き直す。時刻を変えたときだけなので安い。
      // atmosphere.setHour は次の update() で反映されるので、その後に焼く
      atmosphere.update()
      environment.refresh()
      scene.environment = environment.texture
    },

    setExposure(value) {
      renderer.toneMappingExposure = value
    },

    dispose() {
      gpuTimer.dispose()
      explosions.dispose()
      missileSmoke.dispose()
      damageSmoke.dispose()
      missileViews.dispose()
      tracers.dispose()
      targetViews.dispose()
      enemyViews.dispose()
      aircraft.dispose()
      // ジオメトリとマテリアルの実体はモデルが持つ。自機と標的で共有して
      // いるので、破棄はここで 1 回だけ
      aircraftModel.dispose()
      enemyModel.dispose()
      cloudsPass.dispose()
      noise.dispose()
      atmosphere.dispose()
      composer.dispose()
      terrainMesh.dispose()
      water.dispose()
      trails.dispose()
      environment.dispose()
      heightTexture.dispose()
      normalTexture.dispose()
      renderer.dispose()
    },
  }
}

