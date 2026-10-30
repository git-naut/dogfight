import type { HeatHazeState } from '../heatHaze'
import type * as THREE from 'three'
import type { RenderBackend } from '../backend'
import type { FramePassTimes } from './passTimes'
import type { ChaseCamera } from '../camera'
import type { AircraftView } from '../aircraftView'
import type { TargetViews } from '../targetView'
import type { EnemyViews } from '../enemyView'
import type { Tracers } from '../weapons/tracers'
import type { MissileViews } from '../weapons/missileView'
import type { MissileSmoke } from '../weapons/missileSmoke'
import type { DamageSmokeView } from '../damageSmoke'
import type { Explosions } from '../weapons/explosions'
import type { ExplosionTrails } from '../weapons/explosionTrails'
import type { Flares } from '../weapons/flares'
import type { MissileFlames } from '../weapons/missileFlames'
import type { AircraftTrails } from '../aircraft/trails'
import type { PresetName, QualitySettings } from '../quality'

/**
 * 描画パイプラインの継ぎ目。
 *
 * **バックエンドを差し替えると作り方が変わるものを、ここに集める。**
 * 組み立ての実体は `pipeline/nodeScene.ts`（WebGPU と TSL）。段 15 で GLSL の
 * `pipeline/webgl.ts` と同じ形を node 経路で組み、`scene.ts` の帳簿は 1 行も
 * 動かさなかった。段 S1 で GLSL 経路を捨て、組み手は 1 つになった。
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
 * ブルームが光り始める明るさ。**露出を掛けたあとの値で言う。**
 *
 * 空の線形値は 0.1365 / 0.1602 / 0.1844（`weapons/explosions.ts` に
 * rgb(195,201,206) の逆算として記録）。露出 6 を掛けると 0.82 / 0.96 / 1.11。
 * **空だけでなく雲も見る。**最初は雲量 0 の構図で掃引して 1.2 を採ったが、
 * 雲のある絵に当てると積雲が白飛びして輪郭が消えた（実機、2026-09-17）。
 * 雲は空より明るいので、空が +0.3% でも雲は大きく動く。
 *
 * `low-pass-afternoon`（雲量 0.29、順光）で測り直すと、空と雲がどちらも
 * +0.0% になるのは 4.5 から。3.0 では空 +6.2% / 雲 +5.0% でまだ拾っている。
 *
 * **逆光ではさらに上が要る。**`level-backlit`（hour 8）は太陽そのものが空に
 * あるので、4.5 でも空 +25.0% / 雲 +20.6%。実機の絵で積雲の輪郭が消えた。
 * 8 まで上げると雲が残り、太陽の周りだけが滲む。
 *
 * **その代わり順光の排気口は拾わない**（`low-pass-afternoon` で外周 +0.0%）。
 * 排気口の線形輝度は 0.92 で、雲の明るい部分と近い。**閾値だけでは分けられ
 * ない。**発光体だけを光らせるには emissive を MRT へ出す選択的ブルームが
 * 要る（three の `BloomNode` の doc にその形が載っている）。段 27 で MRT を
 * 入れたら測り直す。
 *
 * 鎖へ渡すときは露出で割る（`nodeScene.ts` の `bloomThresholdFor`）。
 * `createNodeOutputNode` が組む鎖は `renderOutput` の内側に無いので、
 * そこを流れる値には露出が掛かっていない。**この 1 段を忘れると 6 倍ずれて、
 * 「ブルームが壊れている」に見える。**
 *
 * 値は掃引で決める（`docs/measuring.md`）。
 */
export const BLOOM_THRESHOLD_AFTER_EXPOSURE = 8

/**
 * 発光体（炎）をブルームの入力へ足す倍率。**初期値。掃引で決め直す。**
 *
 * 閾値は露出前で 8 / 6 ≈ 1.33。炎の色は線形で 0.5〜1 程度なので、2〜3 倍より
 * 上でないと閾値を越えない。出力の絵には足さないので、上げても炎の色は
 * 変わらず、周りの滲みだけが強くなる（`nodeOutput.ts`）
 */
export const EMISSIVE_BLOOM_GAIN = 4

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
 * 海面の描画の費用は実行量を数えられない。頂点とラスタライズが主なので、
 * 切って差分で測るしかない（段 S4b までは地形で同じことをしていた）。省略した項目は現状のまま。
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
  water?: boolean
  clouds?: boolean
  /** 空のフルスクリーンクアッド。遮蔽物を消すと逆に増える費用の切り分けに使う */
  sky?: boolean
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
  /** 海面の CDLOD の分割距離の倍率 */
  lodDistanceScale?: number
}

export interface SceneOptions {
  preset: PresetName
  hour?: number
  /** 雲量 0..1 */
  coverage?: number
  /** トーンマッピングの露出。調整用に上書きできる */
  exposure?: number
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
  /** 海面を描くか。GPU 時間の内訳を差分で測るための切り替え（`?water=0`） */
  showWater?: boolean
  /** 層の雲を合成するか（`?clouds=0`、段 S4b）。画素の逆テストの切り替え */
  showClouds?: boolean
  /** FFT の海を目で見る画面にするか（`?ocean=debug`、段 S3） */
  oceanDebug?: boolean
  /** 計測用: 海のカスケード数と格子の一辺。品質表に載せるのは CP2 のあと */
  oceanCascades?: number
  oceanFftSize?: number
  /** 海面のテクスチャの精度（`?oceantex=16|32`）。既定は 16。段 S4a-1 で絵と費用を比べる */
  oceanTexturePrecision?: 16 | 32
  /** 計測用: 海面のテクスチャの異方性の上限（`?oceananiso=`、既定 16）と泡の段数（`?oceanfoam=`） */
  oceanAnisotropy?: number
  oceanFoamLevels?: number
  /** 計測用: 泡の解像度（`?oceanfoamres=`）・遠くのカスケードを飛ばすか（`?oceanskip=1`）・空を引く回数（`?oceansky=2`） */
  oceanFoamResolution?: number
  oceanSkipFar?: boolean
  oceanSkyLookups?: 2 | 3
  /** 水の濁り（`?oceanturbidity=`、既定は web-ocean の 1.6）。値は S4b の絵の承認で選ぶ */
  oceanTurbidity?: number
  /** 環境反射を使うか。質感の比較に使う */
  showEnvironment?: boolean
  /**
   * ポストの鎖に SMAA を掛けるか。既定は true。
   *
   * **差分の帰属を測るための口（段 20a-4）。**node 経路の 42 枚は全画素が
   * 動くので、原因ごとの寄与は 1 つずつ振って測るしかない
   */
  smaa?: boolean
  /**
   * ポストの鎖にブルームを掛けるか。既定は true。
   *
   * **`quality.bloomStrength` が 0 なら、この値に関わらず鎖に入らない。**
   * low は表の側で切ってある。ここは差分の帰属を測るための口で、
   * `?bloom=0` で外して「ブルームの寄与」だけを数える（段 20a-4 の作法）
   */
  bloom?: boolean
  /** ブルームの閾値の上書き（**露出後の値**）。掃引のための口 */
  bloomThreshold?: number
  /** ブルームの強さの上書き。掃引のための口。プリセットの値を踏み潰す */
  bloomStrength?: number
  /** 機体の外板の細部の上書き。判定道具の口。プリセットの値を踏み潰す */
  materialDetail?: import('../quality').MaterialDetail
  /** キャノピーの clearcoat の上書き。判定道具の口。プリセットの値を踏み潰す */
  canopyClearcoat?: boolean
  /** ベイパーコーンの上書き。判定道具の口。プリセットの値を踏み潰す（段 30f） */
  vaporCone?: boolean
  /** 場面のパスで法線も書き出すか。既定は false。SSR の前提（段 27a） */
  sceneNormals?: boolean
  /** 発光体のブルームの上書き。判定道具の口。プリセットの値を踏み潰す */
  bloomEmissive?: boolean
  /** 発光体をブルームの入力へ足す倍率の上書き。掃引のための口 */
  emissiveGain?: number
  /**
   * 風圧の演出（放射ブラー・色収差・ビネット）を掛けるか。既定は true。
   *
   * **強さは荷重倍数が決める。**1 G では 0 になるので、水平飛行の絵は
   * この値に関わらず動かない。差分の帰属を測るための口
   */
  lens?: boolean
  /** 陽炎を掛けるか。`?haze=0` で外す（ADR 0041） */
  heatHaze?: boolean
  /**
   * 風圧の鎖をどこまで組むか。`?lens=tone|blur`。既定は全部。
   *
   * **差分の帰属を測る口。**1 G では 3 つとも恒等になる設計なので、絵が
   * 動いたらどの段が動かしたのかを 1 つずつ切って見る
   */
  lensStage?: 'tone' | 'blur' | 'full'
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
  /** 爆発の白い煙の尾を描くか。`?explosiontrails=0` で切る（段 29f） */
  showExplosionTrails?: boolean
}
/**
 * 組み立て済みの描画パイプライン。
 *
 * 上半分はビューの実体で、これはバックエンドが変わっても同じもの
 * （three のシーングラフとその更新）。下半分がバックエンドに触る面で、
 * 段 15 で中身が総取り替えになる。**帳簿がレンダラを名指しできないよう、
 * 描画も計測も操作として渡す。**
 */
/**
 * 海面が読む毎フレームの値。
 *
 * **帳簿が uniform を直に触らない。**書き先を知るのはパイプラインだけにする。帳簿が書き先を
 * 知っていると、組み手を替えたときに黙って効かず、太陽の向きもモーフの基準も初期値のまま固まる。
 * 絵は出るので気づけない（段 20a-2-3 で見つけた）。段 S4b で地形と雲影を消し、2 つになった
 */
export interface SurfaceFrame {
  sunDirectionWorld: THREE.Vector3
  /** 海面のモーフの基準。主カメラのワールド位置 */
  morphOrigin: THREE.Vector3
}

/** 雲の状態（段 S4b で層の雲だけになった）。時刻は sim のフレーム番号から導いた秒 */
export interface CloudsUpdate {
  cloudTime: number
  coverage: number
}

export interface ScenePipeline {
  readonly backend: RenderBackend
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly chase: ChaseCamera

  /** FFT の海面（`?ocean=debug` のときは null）。パッチの数と三角形の数を計器が読む */
  readonly ocean: { readonly patchCount: number; readonly triangleCount: number; readonly precision: number } | null
  readonly aircraft: AircraftView
  readonly targetViews: TargetViews
  readonly enemyViews: EnemyViews
  readonly tracers: Tracers
  readonly missileViews: MissileViews
  readonly missileSmoke: MissileSmoke
  readonly damageSmoke: DamageSmokeView
  readonly explosions: Explosions
  readonly explosionTrails: ExplosionTrails
  readonly flares: Flares
  /** ミサイルの発射炎と炎の尾（段 B9） */
  readonly missileFlames: MissileFlames
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

  /**
   * 地表と海面の毎フレームの値をまとめて渡す。
   *
   * **書き先はパイプラインが知る。**帳簿は `terrainUniforms` を触らない
   */
  setSurfaceFrame(frame: SurfaceFrame): void

  /** 雲の状態を渡す。時刻はフレーム番号から導いた値を受ける */
  updateClouds(update: CloudsUpdate): void
  /** 影の箱を機体に合わせる。太陽の向きはパイプラインが持つ値を使う */
  updateAircraftShadow(position: THREE.Vector3): void
  readonly aircraftShadowReady: boolean
  readonly environmentReady: boolean

  readonly gpuFrameMs: number
  readonly gpuFrameMaxMs: number
  readonly gpuTimerSupported: boolean
  /** 直近の GPU のパスごとの内訳（段 S0a）。node 経路で読めたときだけ */
  readonly gpuPasses: FramePassTimes | null
  /** パスの和が合計と食い違った回数。0 でなければ内訳を信じない */
  readonly gpuPassMismatches: number
  /** 直近のフレームごとの内訳。古い順（`GpuTimer.passHistory`） */
  readonly gpuPassHistory: readonly FramePassTimes[]
  /**
   * 最後に描いたフレームの番号。GPU の timestamp の鍵と同じ（段 S0e）。
   * CPU の内訳をこの番号で残し、GPU の内訳と突き合わせる
   */
  readonly renderFrameId: number
  readonly drawCalls: number
  readonly drawnTriangles: number

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
  /**
   * 荷重倍数を渡す。風圧の演出がこれで強さを決める。
   *
   * **毎フレーム呼ぶ。**`sync` の中から渡すので、キャプチャでも 1 回だけ
   * 走って絵が決まる（実時間に依存しない）。
   *
   */
  setLoadFactor(value: number): void
  /**
   * 陽炎の範囲と強さを渡す（ADR 0041）。**毎フレーム呼ぶ。**風圧の荷重倍数と同じく `sync` の中から渡す。
   */
  setHeatHaze(state: HeatHazeState): void
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
   * 自前の空（Hillaire）の LUT と天空光。`?skyprobe=1` のときだけ埋まる（段 S2a）。
   *
   * LUT は RGBA の float を行ごと（読み戻しの並び）に持つ。焼くとき v を裏返すので、
   * 行 y は CPU 参照の行 height - 1 - y に当たる（`sky/skyProbe.ts` の `lutRelativeError`）
   */
  /**
   * FFT の海を GPU で解いて CPU 参照と比べた要約。`?oceanprobe=1` で WebGPU のときだけ
   * 埋まる（段 S3、`ocean/oceanProbe.ts`）
   */
  ocean: (import('../ocean/oceanProbe').OceanProbeSummary & {
    /** 読み戻した場ごとの要素の数（32 ビットの数の個数） */
    lengths: Record<string, number>
    /** ページの中で CPU 参照を解いて比べた所要 ms */
    compareMs: number
    /**
     * 1 フレームの所要 ms（時間発展と逆 FFT、3 回の中央値）と、初期値を作る所要。
     * カスケード数と格子の大きさを振る。GPU の仕事が終わるまで待った壁時計
     */
    cost: { cascades: number; size: number; updateMs: number; initMs: number }[]
    /**
     * 海面のテクスチャ（段 S4a-1）。high の条件（4 × 256、CP2 の C）の変位をテクスチャへ写し、
     * 頂点シェーダと同じ引き方の値を CPU 参照の場と比べる。精度（16・32）ごと
     */
    surface: Record<
      '16' | '32',
      Record<'far' | 'near' | 'momentsFar' | 'momentsNear', import('../ocean/oceanProbe').OceanSurfaceSummary>
    >
    /**
     * high の条件の 1 回の所要 ms（段 S4a-2）。海（時間発展と逆 FFT）、写しとミップ（3 枚）、泡の
     * 更新とそのミップ（1024² × 2 段）。GPU の仕事を待った壁時計
     */
    surfaceCost: {
      simulationMs: number
      texturesMs: number
      foamMs: number
      /**
       * 前から 16 回回した泡を 2 回作って比べた結果。`differing` は食い違った数（0 が決定論）。
       * `covered`・`fresh` は泡の量・新しさが 0.05 を越えた texel の割合
       */
      foam: { texels: number; differing: number; covered: number; fresh: number; maxFoam: number; minJ: number }
    }
    /**
     * 空母のまわりの凪と喫水線の泡（段 S4a-3）。GPU の式と CPU の純関数の差の最大。`calmZero` は
     * 凪の係数が 0（船体の中と水線）の点の数、`waterlineOn` は泡を注ぐ点の数（検査が空回りしない目安）
     */
    calm: { points: number; calmError: number; waterlineError: number; calmZero: number; waterlineOn: number }
    /**
     * 層の雲（段 S4c）。ノイズ・積雲の縁・高層雲の縁の、GPU と CPU 参照の差の最大（256 点、
     * 縁はおおよそ −1〜1 の値）
     */
    cloudLayers: { gnoise: number; lowEdge: number; highEdge: number }
    /** 32 ビットのテクスチャを線形に補間できるか（`float32-filterable`） */
    float32Filterable: boolean
  }) | null
  sky: {
    transmittance: number[]
    multiscatter: number[]
    skyView: number[]
    /** 地表の上向きの面の天空の照度 / π（太陽の照度 1 あたり、RGB） */
    irradianceOverPi: number[]
    /** 同梱の照度の表を GPU で引いた格子（段 S2b、`irradianceProbePoint`） */
    irradianceGrid: number[]
    /** 固定のカメラで焼いた霞のアトラス（段 S2b、`AERIAL_PROBE_CAMERA`） */
    aerialInscatter: number[]
    aerialTransmittance: number[]
    /** 霞を焼いたカメラの行列（列優先）。CPU 側が同じ視線を作る */
    aerialCamera: { projectionInverse: number[]; cameraWorld: number[] }
  } | null
  /**
   * TSL で焼いた円形スプライトの生バイト。`?spriteprobe=1` のときだけ埋まる。
   *
   * `soft` は爆発と暈、`core` は不透明な芯（`OPAQUE_CORE`）
   */
  sprite: { soft: number[]; core: number[] } | null
  /**
   * TSL で焼いたトーンマッピングの生バイト。`?toneprobe=1` のときだけ埋まる。
   *
   * **AgX の式が同じなら露出 6 をそのまま持ち越せる。**VFX の色定数を
   * 測り直さずに済むかがここで決まる
   */
  tone: number[] | null
  /**
   * TSL で焼いた雲の合成。`?overlayprobe=1` のときだけ埋まる。
   *
   * `composite` が合成の結果、`marker` が枝の色分け、`sampled` が
   * レンダーターゲットから引き直した合成。**`sampled` は `composite` と
   * バイトまで一致するはず。**node 経路はレンダーターゲットのテクスチャを
   * 引くとき v を裏返すので、そこが合っていなければここで出る
   */
  overlay: { composite: number[]; marker: number[]; sampled: number[] } | null
  /**
   * 生成された断片シェーダのうち、雲の合成を含む部分。
   *
   * **早期打ち切りが効いているかは絵に出ない。**大気の呼び出しが
   * `else` の中にあることを本文で確かめるために持ち帰る
   */
  overlaySource: string | null
  /**
   * `resolveTimestampsAsync()` から回収できた件数。
   *
   * **0 なら `timestamp-query` が無い。**`trackTimestamp` は静かに false に
   * なり、例外も出ないので件数で判定する（段 18）
   */
  timestampSamples: number
  /**
   * 測れずに捨てた回数。
   *
   * **0 を数に混ぜないための見張り。**解決を重ねると three は前の値を
   * 返すので、重なった回はここへ入る（`nodeTimer.ts` の注記）
   */
  timestampDropped: number
  /** 定常のフレームの GPU 時間 ms。最小値。測れていなければ null */
  gpuFrameMs: number | null
  /**
   * `RenderPipeline` で組んだポストの鎖の測り。`?nodepipeline=1` のときだけ。
   *
   * **`cloudFrameCallsAtRun` が要。**雲は場面のパスより後に走らなければ
   * 1 フレーム前の深度を読む。順はノードを辿った順で決まるので、式の順を
   * 入れ替えた瞬間にここが 0 に落ちる
   */
  pipeline: {
    /** 1 枚描くのに投げたパスの数 */
    frameCalls: number
    drawCalls: number
    /** 事前コンパイルと LUT にかかったミリ秒 */
    buildMs: number
    /** そのうち `compileAsync(scene, camera)` のぶん */
    compileSceneMs: number
    /**
     * 暖機の 1 枚にかかったミリ秒。
     *
     * **鎖の全画面クアッドは場面に入っていない。**`compileAsync` では
     * 組まれないので実描画が要る（段 19）
     */
    warmupMs: number
    /**
     * 起動の総和 ms。
     *
     * レンダラの生成、事前コンパイル、LUT、暖機の 1 枚まで。**合格条件は
     * 15 秒以内**（計画の段 17）。段 S4b で体積の雲のノイズの焼き込みが消えた
     */
    startupMs: number
    /** そのうち LUT の実行時計算のぶん */
    lutMs: number
    /**
     * シェーダのプログラムの数（`info.memory.programs`）。暖機の前・後、暖機のあとの
     * 1 枚目・2 枚目の後。**暖機で増え、そのあと増えない**ことで、組み立てが暖機に
     * 収まったかを時間に頼らず数える（段 S2b-2 の追補）
     */
    programsBeforeWarmup: number
    programsAfterWarmup: number
    programsAfterFirst: number
    programsAfterSecond: number
    /**
     * 1 枚目のミリ秒。
     *
     * **2 枚目と差が出るなら、事前コンパイルが鎖まで覆えていない。**
     * `RenderPipeline` の全画面クアッドは場面に入っていないので、
     * `compileAsync(scene, camera)` では組まれない（段 19 の問い）
     */
    firstFrameMs: number
    secondFrameMs: number
    /** 定常のフレーム時間。最小値 */
    steadyMs: number
    /**
     * 層の雲を焼いた時点（`rtt` の `updateBefore`）の `drawCalls`。
     *
     * **場面のパスより後に焼くこと。**先に焼くと 1 フレーム前の深度を読む。
     * 全画面クアッドのパスも `frameCalls` を 1 増やすので、
     * 場面のパスが走ったかどうかは描画呼び出しの数で見る
     */
    cloudDrawCallsAtRun: number
    /** 4x4 の区画平均。絵が真っ黒でないことを見る */
    tiles: number[]
    /**
     * 影の投げ手を切ると動く画素の数。
     *
     * **0 なら `shadow(light)` が絵に出ていない。**区画平均では見えないので
     * バイトの違いを数える（段 15 と同じ）
     */
    shadowChanged: number
    shadowChangedMax: number
    /** 影あり／なしで投げるパスの数 */
    shadowFrameCalls: number
    noShadowFrameCalls: number
    /**
     * 太陽へ向けた面の直達照度。
     *
     * **背けた面は 0 になるはず。**直達には `max(N・L, 0)` が入っている
     */
    directFacingSun: [number, number, number]
    directAwayFromSun: [number, number, number]
    /** 太陽へ向けた面の間接照度 */
    indirectFacingSun: [number, number, number]
    /** 海面が選んだパッチ枚数と三角形の数。0 なら場面に入っていない（段 S4b で地形から替えた） */
    oceanPatches: number
    oceanTriangles: number
    /** SMAA 入りで投げたパスの数 */
    smaaFrameCalls: number
    /** SMAA を外して投げたパスの数 */
    plainFrameCalls: number
    /**
     * SMAA の有無で違う画素の数。
     *
     * **鎖に入れただけでは辺を拾っているか分からない。**0 なら効いていない
     */
    smaaChanged: number
    smaaChangedMax: number
  } | null
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
  /** 空（`sky/hillaireSky.ts`）を組んだか */
  atmosphere: boolean
  /**
   * 空を組むのにかかったミリ秒。起動時に焼く LUT（透過率と多重散乱）を含む。
   *
   * 段 10 では takram の LUT の計算時間で、4.1 MB の EXR を配るのをやめられるかを
   * この値で決めた。段 S2b-2 で自前の空に替え、takram の倍率の列（`lutScale`）は消した
   */
  lutMs: number
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
