import * as THREE from 'three'
import type { AircraftSample, AircraftTrailSource } from '../sim/aircraft'
import type { TargetSample } from '../sim/target'
import type { LookOffset } from '../input/mouseLook'
import type { ChaseCamera } from './camera'
import type { RenderBackend } from './backend'
import type { FramePassTimes } from './pipeline/passTimes'
import type { DamageSmokeSource } from '../sim/damage'
import type { Flare } from '../sim/weapons/flare'
import type { ExplosionSource } from '../sim/effects'
import type { BulletSource } from '../sim/weapons/gun'
import type { SmokeSource } from '../sim/weapons/missile'
import type { Launcher } from '../sim/combat'
import { createHungMissiles } from './weapons/missileView'
import type { PresetName, QualitySettings } from './quality'
import { cloudTime } from './sky/cloudLayersReference'
import { FIXED_DT } from '../sim/loop'
import { computeHeatHaze, createHeatHazeState } from './heatHaze'
import { speedOfSound } from '../sim/isa'
import { WebGPUUnavailable, findWebGPUMissing } from './pipeline/webgpuRequired'
import {
  DEFAULT_COVERAGE,
  type MeasureConfig,
  type SceneOptions,
} from './pipeline/types'

/** 描画へ渡すミサイルの姿勢。補間済みの値を main が詰める */
export interface MissilePose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  /** 発射からの秒（補間した値）。発射炎の長さを測る（段 B9） */
  age: number
  /** モーターが燃えているか。炎の尾を出す（段 B9） */
  burning: boolean
}

export function createMissilePose(): MissilePose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), age: 0, burning: false }
}

/**
 * Phase 2 のシーン。
 *
 * 空は Hillaire の LUT による物理ベースの大気散乱（`sky/hillaireSky.ts`、
 * 段 S2b-2 で takram から置き換えた）。ライティングも同じ LUT から導かれるので、
 * 時刻を変えれば光の色と強さが一貫して変わる。
 *
 * 地面は FFT の海面（`ocean/`）、雲は 2 枚の層（`sky/cloudLayerNodes.ts`）。段 S4b で
 * 島（高さ場と地形）と体積の雲を消して置き換えた。sim の地面は海面（高度 0）だけ。
 */

export interface SceneHandle {
  /**
   * 描画バックエンドの継ぎ目。
   *
   * WebGPU へ移すと消えるか名前が変わる面は、すべてこちらを通す。
   * **`renderer` はここには出さない。**段 7 で寄せ切ったので読む者がいない。
   * `ScenePipeline.renderer` の逃げ口も段 20a-2 で消した（`WebGLRenderer`
   * 型で固定されていて node 経路を入れられなかった）
   */
  backend: RenderBackend
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
  /** GPU のフレーム時間 ms。拡張が無ければ 0 */
  readonly gpuFrameMs: number
  /** 直近しばらくの GPU フレーム時間の最大 ms。予算の判断はこちらで行う */
  readonly gpuFrameMaxMs: number
  /** 直近の GPU のパスごとの内訳（段 S0a）。node 経路で読めたときだけ */
  readonly gpuPasses: FramePassTimes | null
  /** パスの和が合計と食い違った回数 */
  readonly gpuPassMismatches: number
  /** 直近のフレームごとの内訳。古い順 */
  readonly gpuPassHistory: readonly FramePassTimes[]
  /** 最後に描いたフレームの番号。GPU の内訳のフレーム番号と同じ（段 S0e） */
  readonly renderFrameId: number
  /** そのうち雲のパスが占める ms */
  /** 雲のパスの直近の最大 ms */
  /** GPU 時間の計測が使えるか */
  readonly gpuTimerSupported: boolean
  /** 描いている海面のパッチの枚数と三角形数。予算の確認に使う（段 S4b で地形から替えた） */
  readonly oceanPatches: number
  readonly oceanTriangles: number
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
  /** 自機に吊るして見せているミサイルの数（段 B9）。0〜2 */
  readonly hungMissilesShown: number
  /** 発射炎を出しているミサイルの数（段 B9） */
  readonly missileFlashesDrawn: number
  /** 炎の尾を出しているミサイルの数（段 B9） */
  readonly missileFlamesDrawn: number
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
  /** 左右の発射機を読む先を渡す（段 B9、吊るしたミサイル）。ワールドを作り直したら呼び直す */
  setLauncherSource(launchers: readonly Launcher[]): void
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
 * シーンの帳簿。
 *
 * sim の値をビューへ写す仕事だけを持つ。**レンダラもコンポーザも雲のパスも
 * ここには出てこない。**組み立ては `pipeline/nodeScene.ts` が持ち、この関数は
 * `ScenePipeline` の面しか見ない。
 *
 * 組み立て（レンダラの初期化・雲ノイズ・大気の LUT）が非同期なので Promise を
 * 返す。呼び出し側は await してから描画ループを回すこと。
 *
 * **WebGPU が要る。**段 S1 で GLSL 退避路を捨てた。WebGPU が無ければ、
 * キャンバスを掴む前に `WebGPUUnavailable` を投げて止める（`main.ts` が
 * 利用者向けの文言を出す）。
 */
export async function createScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<SceneHandle> {
  // **キャンバスを掴む前に訊く。**`WebGPURenderer` は WebGPU が無いと黙って
  // WebGL2 へ落ちてコンテキストを取る
  const missing = await findWebGPUMissing()
  if (missing !== null) throw new WebGPUUnavailable(missing)

  const pipeline = await (await import('./pipeline/nodeScene')).createNodePipeline(canvas, options)
  const {
    camera,
    chase,
    aircraft,
    targetViews,
    enemyViews,
    tracers,
    missileViews,
    missileSmoke,
    damageSmoke,
    explosions,
    explosionTrails,
    flares,
    missileFlames,
    trails,
  } = pipeline

  /** 影の箱を合わせるのに使う。毎フレーム作らない */
  const aircraftPosition = new THREE.Vector3()
  /** 陽炎の範囲。毎フレーム書き換える */
  const heatHaze = createHeatHazeState()
  /** 軌跡の履歴を読む先。main が World を作ったあとに渡す */
  let trailSource: AircraftTrailSource | null = null
  /** 弾を読む先。main が World を作ったあとに渡す */
  let bulletSources: readonly BulletSource[] = []
  /** 煙の履歴を読む先 */
  let smokeSources: readonly SmokeSource[] = []
  /** 直近の sync で受けたミサイル。発射炎と炎の尾はカメラが決まったあとに置く */
  let lastMissiles: readonly MissilePose[] = []
  /** 左右の発射機を読む先。無ければ両方とも吊るす */
  let launcherSource: readonly Launcher[] = []
  // 吊るしたミサイル（段 B9）。自機の子に付けるので、機体と一緒に動く
  const hungMissiles = createHungMissiles()
  aircraft.object.add(hungMissiles.object)
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
  const quaternion = new THREE.Quaternion()
  /** HUD へ渡すビュー射影行列。毎フレーム組み直す */
  const viewProjection = new THREE.Matrix4()

  return {
    backend: pipeline.backend,
    scene: pipeline.scene,
    camera,
    chase,

    get sunRadiance() {
      return pipeline.sunRadiance
    },

    get skyRadiance() {
      return pipeline.skyRadiance
    },

    get sunElevation() {
      return pipeline.sunElevation
    },

    get gpuFrameMs() {
      return pipeline.gpuFrameMs
    },

    get gpuFrameMaxMs() {
      return pipeline.gpuFrameMaxMs
    },

    get gpuPasses() {
      return pipeline.gpuPasses
    },

    get gpuPassMismatches() {
      return pipeline.gpuPassMismatches
    },

    get gpuPassHistory() {
      return pipeline.gpuPassHistory
    },

    get renderFrameId() {
      return pipeline.renderFrameId
    },

    get gpuTimerSupported() {
      return pipeline.gpuTimerSupported
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

    get hungMissilesShown() {
      return hungMissiles.shown
    },

    get missileFlashesDrawn() {
      return missileFlames.flashesDrawn
    },

    get missileFlamesDrawn() {
      return missileFlames.flamesDrawn
    },

    get explosionsDrawn() {
      return explosions.drawn
    },

    get viewProjection() {
      return viewProjection.elements
    },

    get environmentReady() {
      return pipeline.environmentReady
    },

    get drawCalls() {
      return pipeline.drawCalls
    },

    get drawnTriangles() {
      return pipeline.drawnTriangles
    },

    get aircraftShadowReady() {
      return pipeline.aircraftShadowReady
    },

    get oceanPatches() {
      return pipeline.ocean?.patchCount ?? 0
    },

    get oceanTriangles() {
      return pipeline.ocean?.triangleCount ?? 0
    },

    get quality() {
      return pipeline.quality
    },


    sync(sample, targets, enemies, missiles, frame, dt, look, snap = false) {
      targetViews.update(targets)
      enemyViews.update(enemies)
      missileViews.update(missiles)
      lastMissiles = missiles
      hungMissiles.update(launcherSource)

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
      // 炎の脈動の位相はフレーム番号から出す。実時間を使うとキャプチャが固定されない
      aircraft.setThrottle(sample.throttle, frame * FIXED_DT)
      // マッハ数は描画の側で出す。音速は高度で決まる（段 30f）
      aircraft.setMach(sample.speed / speedOfSound(sample.position.y), frame * FIXED_DT)
      // **風圧の演出へ荷重倍数を渡す。**`AircraftSample.loadFactor` は
      // 「描画側で使う予備」として置かれていた口で、ここが最初の読み手。
      // 実時間ではなく sim の値なので、キャプチャでも絵が決まる
      pipeline.setLoadFactor(sample.loadFactor)
      // 舵面は sim が持つ位置をそのまま渡す。描画側で入力を読むと
      // キャプチャモードで再現しない
      aircraft.setControls(sample.elevator, sample.aileron, sample.rudder)
      // **判定は sim が持つ。**ここで高度を見て切り替えると、キャプチャ
      // モード（`sync()` が 1 回だけ）で出ない
      aircraft.setGear(sample.gearPosition)
      aircraft.setHook(sample.hookAngle)

      // 太陽光と天空光の基準位置を機体に合わせる。高度によって透過率が変わる。
      // ライト本体の位置は大気側が太陽方向から決めるので触らない
      pipeline.setLightAnchor(sample.position.x, sample.position.y, sample.position.z)
      // 影の箱を機体に合わせる。太陽光の位置は updateAtmosphere() が
      // target + sunDirection * distance で決めるので、その前に動かす
      aircraftPosition.set(sample.position.x, sample.position.y, sample.position.z)
      pipeline.updateAircraftShadow(aircraftPosition)
      pipeline.updateAtmosphere()

      if (snap) chase.snap(sample, look)
      else chase.update(sample, dt, look)

      // 陽炎（ADR 0041）。カメラが決まってから、排気口の後ろの範囲を画面へ投影して渡す
      aircraft.object.updateMatrixWorld()
      camera.updateMatrixWorld()
      computeHeatHaze(aircraft.nozzles, aircraft.object, camera, sample.throttle, heatHaze)
      heatHaze.time = frame * FIXED_DT
      pipeline.setHeatHaze(heatHaze)

      // 雲の流れは実時間ではなく sim のフレーム番号から導く。
      // これでキャプチャモードの絵が固定される
      pipeline.updateClouds({
        cloudTime: cloudTime(frame, FIXED_DT),
        coverage: options.coverage ?? DEFAULT_COVERAGE,
      })

      // LOD はカメラ位置で決める。機体位置ではない（追従カメラは後方にいる）。
      // chase の更新後に読むこと
      const cameraWorld = pipeline.updateCameraWorld()

      // **書き先はパイプラインが知る。**node 経路は `NodeSurfaceState` へ入れる。
      // 帳簿が書き先を知っていると、組み手を替えたときに黙って効かなくなる
      // （段 20a-2-3。当時は GLSL 経路が共有ユニフォームへ書いていた）
      pipeline.setSurfaceFrame({
        sunDirectionWorld: pipeline.sunDirectionWorld,
        morphOrigin: cameraWorld,
      })

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
          (2 * Math.tan(((camera.fov * Math.PI) / 180) * 0.5)) / pipeline.cssHeight
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
      // 発射炎と炎の尾（段 B9）。フレアと同じくカメラの至近を通る
      missileFlames.update(lastMissiles, cameraWorld, cameraForward)

      // 爆発。**経過秒はフレーム番号から出す。**実時間を渡すと
      // キャプチャモードで絵が固定されない
      if (explosionSource !== null) {
        explosions.update(explosionSource, frame, cameraWorld, cameraForward)
        explosionTrails.update(explosionSource, frame, cameraWorld, cameraForward)
      }
    },

    async compileShaders() {
      await pipeline.compile()
    },

    async compileAllPresets(current, onProgress) {
      await pipeline.compileAllPresets(current, onProgress)
    },

    render() {
      pipeline.render()
    },

    renderPlain() {
      pipeline.renderPlain()
    },

    resize(width, height, devicePixelRatio) {
      pipeline.setSize(width, height, devicePixelRatio)
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

    setLauncherSource(launchers) {
      launcherSource = launchers
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
      pipeline.setMeasureConfig(config)
    },

    setQuality(preset) {
      pipeline.setQuality(preset)
    },

    setHour(hour) {
      pipeline.setHour(hour)
    },

    setExposure(value) {
      pipeline.setExposure(value)
    },

    dispose() {
      hungMissiles.dispose()
      pipeline.dispose()
    },
  }
}
