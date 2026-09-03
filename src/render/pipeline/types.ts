import type * as THREE from 'three'
import type { RenderBackend } from '../backend'
import type { ChaseCamera } from '../camera'
import type { CloudsUpdate } from '../clouds/cloudsPass'
import type { AircraftView } from '../aircraftView'
import type { TargetViews } from '../targetView'
import type { EnemyViews } from '../enemyView'
import type { Tracers } from '../weapons/tracers'
import type { MissileViews } from '../weapons/missileView'
import type { MissileSmoke } from '../weapons/missileSmoke'
import type { DamageSmokeView } from '../damageSmoke'
import type { Explosions } from '../weapons/explosions'
import type { Flares } from '../weapons/flares'
import type { AircraftTrails } from '../aircraft/trails'
import type { TerrainMesh, TerrainSharedUniforms } from '../terrain/terrainMesh'
import type { Water } from '../terrain/water'
import type { Terrain } from '../../sim/terrain'
import type { PresetName, QualityOverride, QualitySettings } from '../quality'

/**
 * 描画パイプラインの継ぎ目。
 *
 * **バックエンドを差し替えると作り方が変わるものを、ここに集める。**
 * 組み立ての実体は `pipeline/webgl.ts`。段 15 で `pipeline/node.ts` が
 * 同じ形を WebGPU と TSL で組み、`scene.ts` の帳簿は 1 行も動かさない。
 *
 * 帳簿（sim の値をビューへ写す仕事）はこの型だけを見る。レンダラも
 * コンポーザも雲のパスも名前が出てこないのは、そこが差し替わる面だからで、
 * 出てくる `renderer` は段 15 までの過渡的な口。**新しく増やさない。**
 */

/**
 * トーンマッピングの露出。
 *
 * 大気ライブラリが返す相対輝度を表示域へ持ち上げる係数。1 のままだと真昼でも
 * 空の輝度が 255 中 62 にしかならない。5 から 40 まで振って絵で比べ、空に
 * 深みが残り地面の緑も飛ばない 6 を採った。経緯は
 * docs/decisions/0002-atmosphere-integration.md にある。
 */
export const DEFAULT_EXPOSURE = 6

/**
 * 既定の雲量。点在する積雲になる値。
 *
 * **0.3 から 0.29 へ下げた。**密度の側は `threshold = 1 - coverage` を
 * 気象マップの FBM へ当てているので、0.3 付近は分布の裾に載っていて応答が
 * 急峻。0.02 動かすと雲がほぼ消える（実測。0.28 で密度サンプルが 27.3 から
 * 16.2 へ、0.24 では画面から消えた）。
 *
 * 0.29 なら主役の積雲は残り、密度サンプルは `level-afternoon` で 27.3 から
 * 20.4、`terrain-overlook` で 29.1 から 23.7 へ落ちる。
 *
 * **正本はここだけ。**`capture.ts` の URL 既定も `tests/e2e/scenes.mjs` の
 * 構図もこの値に合わせる。以前は写しを持っていて、道具ごとに違う雲量で
 * 撮っていた（`docs/lessons.md`）
 */
export const DEFAULT_COVERAGE = 0.29

/**
 * 同時に出せる標的機の上限。
 *
 * Phase 7 のミッション 01 が敵 8 機撃墜なので、器はそこに合わせておく。
 * 複製は使う数だけ作るので、余らせても費用はかからない。
 */
export const MAX_TARGETS = 8

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
 * 組み立て済みの描画パイプライン。
 *
 * 上半分はビューの実体で、これはバックエンドが変わっても同じもの
 * （three のシーングラフとその更新）。下半分がバックエンドに触る面で、
 * 段 15 で中身が総取り替えになる。**帳簿がレンダラを名指しできないよう、
 * 描画も計測も操作として渡す。**
 */
export interface ScenePipeline {
  readonly backend: RenderBackend
  /**
   * 段 15 までの過渡的な口。
   *
   * いまは誰も読んでいない。WebGPU 経路が立つまでの逃げ道として残す
   */
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly chase: ChaseCamera

  readonly terrain: Terrain
  readonly terrainUniforms: TerrainSharedUniforms
  readonly terrainMesh: TerrainMesh
  readonly water: Water
  readonly aircraft: AircraftView
  readonly targetViews: TargetViews
  readonly enemyViews: EnemyViews
  readonly tracers: Tracers
  readonly missileViews: MissileViews
  readonly missileSmoke: MissileSmoke
  readonly damageSmoke: DamageSmokeView
  readonly explosions: Explosions
  readonly flares: Flares
  readonly trails: AircraftTrails

  /** 太陽高度 rad */
  readonly sunElevation: number
  /** 太陽光と天空光の放射輝度。大気の LUT が決める */
  readonly sunRadiance: THREE.Vector3
  readonly skyRadiance: THREE.Vector3
  /** 太陽の向き。影の箱と雲のライティングが使う */
  readonly sunDirectionWorld: THREE.Vector3
  /**
   * 太陽光と天空光の基準位置を機体に合わせる。
   *
   * 高度によって透過率が変わるので要る。ライト本体の位置は
   * `updateAtmosphere()` が太陽方向から決めるので、こちらでは触らない
   */
  setLightAnchor(x: number, y: number, z: number): void
  /** 太陽の位置と輝度を出し直す。影の箱を動かしたあとに呼ぶ */
  updateAtmosphere(): void
  setHour(hour: number): void

  /** 雲の状態を渡す。時刻はフレーム番号から導いた値を受ける */
  updateClouds(update: CloudsUpdate): void
  /** 雲ノイズの生成にかかったミリ秒 */
  readonly noiseMs: number
  /** 雲ノイズが空でないことの確認用 */
  readonly noiseStats: { min: number; max: number; mean: number }
  /** 形状ノイズの中央スライスの左下 16x16。TSL 版との突き合わせに使う */
  readonly noiseSlice: Uint8Array
  /** 気象マップの左下 16x16。`?noiseprobe=1` のときだけ読む */
  readonly weatherSlice: Uint8Array
  /** 雲のバッファが 16bit 浮動小数か。8bit だと横線が出る */
  readonly cloudHdrTarget: boolean
  /** 雲の密度サンプル数の統計。?probe=1 のときだけ意味を持つ */
  readCloudProbe(): { mean: number; max: number; p99: number }
  /**
   * 雲影マップ 256² の分布。16 ビンで合計 1。
   *
   * TSL 版との突き合わせに使う。**生の 26 万バイトは持ち回らない**
   */
  readShadowHistogram(): { bins: number[]; tiles: number[] }
  /**
   * 固定の入力で雲のマーチを 1 枚焼いて読み戻す。TSL 版との突き合わせ専用。
   *
   * 入力は `clouds/marchProbe.ts` が唯一の定義で、TSL 側も同じものを読む
   */
  readMarchProbe(mode: 0 | 1 | 2): number[]
  /** 時間方向の足し込みを 1 枚焼いて読み戻す。TSL 版との突き合わせ専用 */
  readResolveProbe(): number[]
  /** 円形スプライトを 1 枚焼いて読み戻す。TSL 版との突き合わせ専用 */
  readSpriteProbe(opaqueCore: boolean): number[]

  /** 影の箱を機体に合わせる。太陽の向きはパイプラインが持つ値を使う */
  updateAircraftShadow(position: THREE.Vector3): void
  readonly aircraftShadowReady: boolean
  readonly environmentReady: boolean

  readonly gpuFrameMs: number
  readonly gpuFrameMaxMs: number
  readonly gpuCloudMs: number
  readonly gpuCloudMaxMs: number
  readonly gpuTimerSupported: boolean
  readonly drawCalls: number
  readonly drawnTriangles: number
  /** 高さ場の生成にかかったミリ秒 */
  readonly terrainMs: number

  /**
   * カメラのワールド位置。LOD の判定に使う。
   *
   * 帳簿が毎フレーム `updateCameraWorld()` で取り直す。器を使い回すので、
   * 返る `Vector3` を持ち回らずその場で読むこと
   */
  readonly cameraWorld: THREE.Vector3
  /** カメラのワールド位置を取り直して返す。追従カメラを動かしたあとに呼ぶ */
  updateCameraWorld(): THREE.Vector3

  render(): void
  /** 内側の計測を挟まずに 1 枚描く。計測モード専用 */
  renderPlain(): void
  setSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void
  /**
   * いまの CSS 高さ。
   *
   * 曳光弾の幅を画面基準にするのに帳簿が読む。画角と合わせて
   * 1 画素が張る角度を出す
   */
  readonly cssHeight: number
  readonly quality: QualitySettings
  setQuality(preset: PresetName): void
  setExposure(value: number): void
  compile(): Promise<void>
  compileAllPresets(
    current: PresetName,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void>
  /** 計測用に描画の一部を切り替える */
  setMeasureConfig(config: MeasureConfig): void
  dispose(): void
}

/**
 * node 経路の自己診断の結果。
 *
 * 段 9 で `?gpu=1|2` の第 2 経路を立てたときに埋まる。**移行の前提を
 * 1 ページで測るためのもの**で、既定の絵とは関係がない。
 */
export interface NodeProbeResult {
  /** 要求した経路。1 = `forceWebGL: true`、2 = WebGPU */
  requested: number
  /** 実際に立ったバックエンド */
  backend: 'node-webgl' | 'node-webgpu'
  /** WebGPU を要求して WebGL2 へ落ちたか */
  fellBack: boolean
  /**
   * `three` と `three/webgpu` がコアクラスの実体を共有しているか。
   *
   * **ここが false なら移行は総取り替えになる。**`Mesh` が 2 種類できると
   * `instanceof` が通らず、既存のローダもビューも node 経路で使えない。
   * 実測では両方の build が `three.core.js` から import しているので true
   */
  sharedCore: boolean
  /** シーンに入れたメッシュの数 */
  meshes: number
  /**
   * シーンに入れた `ShaderMaterial` の数。
   *
   * **node 経路では 0 でなければならない。**`StandardNodeLibrary` に
   * 登録がない。glb の材質は `MeshStandardMaterial` なので通る。
   *
   * 入れても例外にはならない。実測では `THREE.NodeBuilder: Material
   * "ShaderMaterial" is not compatible.` をコンソールへ出したまま描画が進む
   * （`initError` も立たない）ので、数で見張る
   */
  shaderMaterials: number
  drawCalls: number
  triangles: number
  programs: number
  /**
   * TSL で焼いた形状ノイズの中央スライスの左下 16x16。RGBA8 の 1,024 個。
   *
   * **GLSL 版（`?gpu=0` の `hook.noiseSlice`）とビット一致しなければ、
   * 以降の雲の絵はすべて別物になる。**
   */
  noiseSlice: number[]
  /**
   * TSL で焼いた気象マップの左下 16x16。RGBA8 の 1,024 個。
   *
   * **雲の配置を決めるのはこちら。**GLSL 版とずれると雲の湧く場所が
   * 変わるが、雲影の分布では捕まらない
   */
  weatherSlice: number[]
  /**
   * ハッシュの上位 8 ビットを 16x16 の格子で焼いたもの。RGB の 768 個。
   *
   * CPU 参照（`hashReference.ts` の `hashProbeExpected`）と突き合わせる。
   * **GLSL と WGSL と JS の 3 つが同じ整数を出すことの直接の証拠になる**
   */
  hashProbe: number[]
  /**
   * TSL で焼いた雲影マップ 256² の分布。16 ビンで合計 1。
   *
   * `?shadowinputs=` を渡したときだけ埋まる。**段 12 の合格条件**は、
   * GLSL 版（`?shadowprobe=1` の `hook.shadowHistogram`）との L1 距離が
   * 0.01 未満であること
   */
  shadowHistogram: number[] | null
  /**
   * TSL で焼いた雲影マップを 4x4 に区切った区画ごとの平均透過率。16 個。
   *
   * **分布だけでは配置を見張れない。**ノイズの体積を上下反転しても
   * 16 ビンの分布は 0.01 の内側に収まることを実測した
   */
  shadowTiles: number[] | null
  /**
   * TSL で焼いたマーチの突き合わせ。`?marchprobe=1` のときだけ埋まる。
   *
   * **`samples` と `exhausted` は整数。**歩き方が同じなら GLSL 版と完全に
   * 一致するはずで、ここが移植で一番壊れやすいループと分岐を直に見張る。
   * `tiles` は絵を 4x4 に区切った平均で、浮動小数の演算順序の差には鈍い
   */
  march: {
    samples: { total: number; max: number; hit: number }
    exhausted: number
    tiles: number[]
    /** 時間方向の足し込みの生バイト。GLSL 版とバイトで比べる */
    resolve: number[]
  } | null
  /**
   * TSL で引いた高さ場 64 点 m。`?heightprobe=1` のときだけ埋まる。
   *
   * `src/sim/terrain.ts` の `heightAt` と 1e-3 m 以内で一致するはず
   */
  heightProbe: number[] | null
  /**
   * TSL で焼いた円形スプライトの生バイト。`?spriteprobe=1` のときだけ埋まる。
   *
   * `soft` は爆発と暈、`core` は不透明な芯（`OPAQUE_CORE`）
   */
  sprite: { soft: number[]; core: number[] } | null
  /**
   * node 経路の影の測り。`?nodeshadow=1` のときだけ埋まる。
   *
   * **`frameCallsWith` が `frameCallsWithout` の 1 つ多いだけのはず。**
   * それより多ければ影マップを 1 フレームに 2 回以上焼いている
   */
  nodeShadow: {
    filter: string
    /** 影を投げるメッシュの数。**ドローコールとは一致しない** */
    casters: number
    /** 機体を消したときの差。影のパスが払うはずのドローコール */
    aircraftDrawCalls: number
    drawCallsWithout: number
    drawCallsWith: number
    /**
     * 描いたパスの数。
     *
     * **影マップを 2 回焼けば 1 つ増える。**ドローコールでは視錐台の切り方の
     * 違いが混ざって当てにならない（実測で機体の 31 回に対して影のパスは
     * 47 回だった）
     */
    frameCallsWithout: number
    frameCallsWith: number
    frameCallsSecond: number
    /**
     * 影を有効にしたが投げ手を切った状態のパスの数。
     *
     * **ここで既に増えているなら、増えたぶんは影マップではない**
     */
    frameCallsEnabledNoCaster: number
    /**
     * 影を入れて動いたバイトの数と最大の差。
     *
     * **区画平均では鈍すぎる。**機体の影は画面のごく一部しか覆わない
     */
    changed: number
    changedMax: number
  } | null
  /**
   * 形状 64³・ディテール 32³・気象 512² を焼くのにかかったミリ秒。
   *
   * GLSL 版の `hook.noiseMs` と並べる。node 経路でも起動時の費用になる
   */
  volumeMs: number
  /** 大気を node 経路で組んだか */
  atmosphere: boolean
  /**
   * 大気の LUT を GPU で計算するのにかかったミリ秒。
   *
   * **これが段 10 の主目的。**4.1 MB の EXR を配るのをやめられるかは、
   * この値で決まる。SwiftShader で 1 ページあたり 3 秒を超えるなら
   * `atmosphereLutScale` を落とすか、オフラインで焼いたものを差す
   */
  lutMs: number
  /** LUT の解像度の倍率。プリセットの `atmosphereLutScale` */
  lutScale: number
  /** `compileAsync` にかかったミリ秒。ここで `setup()` が走る */
  buildMs: number
  /**
   * 太陽高度 deg。
   *
   * WebGL 経路の `hook.sunElevation` と突き合わせる。**同じ時刻から同じ
   * 太陽が出ることを数値で確かめる。**絵を見比べても分からない
   */
  sunElevationDeg: number
  /** `renderer.init()` にかかったミリ秒 */
  initMs: number
  /**
   * 1 枚目にかかったミリ秒。
   *
   * シェーダの生成とテクスチャの常駐化が乗るので、定常の値ではない。
   * バックエンドの比較には使わない
   */
  firstFrameMs: number
  /**
   * 定常状態の 1 枚のミリ秒。**最小値。**
   *
   * `bench.ts` と同じ代表値の取り方。平均は他プロセスの割り込みを拾う
   */
  renderMs: number
  /** 定常状態で測った枚数 */
  frames: number
}
