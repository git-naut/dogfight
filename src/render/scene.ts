import * as THREE from 'three'
import type { AircraftSample, AircraftTrailSource } from '../sim/aircraft'
import type { TargetSample } from '../sim/target'
import type { LookOffset } from '../input/mouseLook'
import type { ChaseCamera } from './camera'
import type { RenderBackend } from './backend'
import type { DamageSmokeSource } from '../sim/damage'
import type { Flare } from '../sim/weapons/flare'
import type { ExplosionSource } from '../sim/effects'
import type { BulletSource } from '../sim/weapons/gun'
import type { SmokeSource } from '../sim/weapons/missile'
import type { PresetName, QualitySettings } from './quality'
import type { TerrainStats } from '../sim/terrain'
import { cloudTime } from './clouds/geometry'
import type { ShadowInputs } from './clouds/shadowInputs'
import { FIXED_DT } from '../sim/loop'
import { createWebGLPipeline } from './pipeline/webgl'
import { DEFAULT_COVERAGE, type MeasureConfig, type SceneOptions } from './pipeline/types'

/** 描画へ渡すミサイルの姿勢。補間済みの値を main が詰める */
export interface MissilePose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

export function createMissilePose(): MissilePose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
}

/**
 * Phase 2 のシーン。
 *
 * 空は @takram/three-atmosphere による物理ベースの大気散乱。ライティングも
 * 大気の LUT から導かれるので、時刻を変えれば光の色と強さが一貫して変わる。
 *
 * 地面は起伏する地形と海面。高さ場は sim が持っていて、ここはそれを
 * テクスチャへ上げて頂点シェーダで引くだけ。
 */

export interface SceneHandle {
  /**
   * 描画バックエンドの継ぎ目。
   *
   * WebGPU へ移すと消えるか名前が変わる面は、すべてこちらを通す。
   * **`renderer` はここには出さない。**段 7 で寄せ切ったので読む者がいない。
   * 逃げ口としては `ScenePipeline.renderer` だけが残る
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
  /** 雲ノイズの生成にかかったミリ秒。性能の記録用 */
  readonly noiseMs: number
  /** 雲ノイズが空でないことの確認用 */
  readonly noiseStats: { min: number; max: number; mean: number }
  /** 形状ノイズの中央スライスの左下 16x16。`?noiseprobe=1` のときだけ読む */
  readonly noiseSlice: Uint8Array
  /** 気象マップの左下 16x16。`?noiseprobe=1` のときだけ読む */
  readonly weatherSlice: Uint8Array
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
  /**
   * 雲影マップ 256² の分布と配置。`?shadowprobe=1` で使う。
   *
   * `bins` は 16 ビンで合計 1、`tiles` は 4x4 の区画ごとの平均透過率。
   * **分布だけでは足りない。**影を上下反転しても分布は動かない
   */
  readShadowHistogram(): { bins: number[]; tiles: number[] }
  /**
   * 雲影マップを決めた入力。`?shadowprobe=1` で使う。
   *
   * TSL 版へ**同じ値を渡す**ための口。別の入力で焼いたものを比べると、
   * 一致しなかったときに移植の欠陥なのか入力の違いなのかが分からない
   */
  readShadowInputs(): ShadowInputs
  /** 固定の入力で雲のマーチを 1 枚焼いて読み戻す。`?marchprobe=1` で使う */
  readMarchProbe(mode: 0 | 1 | 2): number[]
  /** 円形スプライトを 1 枚焼いて読み戻す。`?spriteprobe=1` で使う */
  readSpriteProbe(opaqueCore: boolean): number[]
  /** 時間方向の足し込みを 1 枚焼いて読み戻す。`?marchprobe=1` で使う */
  readResolveProbe(): number[]
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
 * シーンの帳簿。
 *
 * sim の値をビューへ写す仕事だけを持つ。**レンダラもコンポーザも雲のパスも
 * ここには出てこない。**組み立ては `pipeline/webgl.ts` が持ち、この関数は
 * `ScenePipeline` の面しか見ない。段 15 で `pipeline/node.ts` が同じ面を
 * WebGPU で組んだとき、ここは 1 行も動かない。
 *
 * 大気の LUT 読み込みが非同期なので Promise を返す。呼び出し側は await して
 * から描画ループを回すこと。待たずに描くとテクスチャのない絵になる。
 */
export async function createScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): Promise<SceneHandle> {
  const pipeline = await createWebGLPipeline(canvas, options)
  const {
    camera,
    chase,
    terrain,
    terrainUniforms,
    terrainMesh,
    water,
    aircraft,
    targetViews,
    enemyViews,
    tracers,
    missileViews,
    missileSmoke,
    damageSmoke,
    explosions,
    flares,
    trails,
  } = pipeline

  const shadowCenter = new THREE.Vector2()
  /**
   * 直近に雲影を焼いた入力。`?shadowprobe=1` で読む。
   *
   * **`updateClouds` へ渡したものをそのまま写す。**別に導き直すと、
   * 導き方が食い違ったときに気づけない
   */
  const lastShadowInputs: ShadowInputs = {
    cloudTime: 0,
    coverage: 0,
    sunX: 0,
    sunY: 0,
    sunZ: 0,
    centerX: 0,
    centerZ: 0,
  }
  /** 影の箱を合わせるのに使う。毎フレーム作らない */
  const aircraftPosition = new THREE.Vector3()
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

    get noiseMs() {
      return pipeline.noiseMs
    },

    get noiseStats() {
      return pipeline.noiseStats
    },

    get noiseSlice() {
      return pipeline.noiseSlice
    },

    get weatherSlice() {
      return pipeline.weatherSlice
    },

    get gpuFrameMs() {
      return pipeline.gpuFrameMs
    },

    get gpuFrameMaxMs() {
      return pipeline.gpuFrameMaxMs
    },

    get gpuCloudMs() {
      return pipeline.gpuCloudMs
    },

    get gpuCloudMaxMs() {
      return pipeline.gpuCloudMaxMs
    },

    get gpuTimerSupported() {
      return pipeline.gpuTimerSupported
    },

    get cloudHdrTarget() {
      return pipeline.cloudHdrTarget
    },

    get terrainMs() {
      return pipeline.terrainMs
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

    get terrainPatches() {
      return terrainMesh.patchCount
    },

    get terrainTriangles() {
      return terrainMesh.triangleCount
    },

    readCloudProbe() {
      return pipeline.readCloudProbe()
    },

    readShadowHistogram() {
      return pipeline.readShadowHistogram()
    },

    readShadowInputs() {
      return { ...lastShadowInputs }
    },

    readMarchProbe(mode: 0 | 1 | 2) {
      return pipeline.readMarchProbe(mode)
    },

    readSpriteProbe(opaqueCore: boolean) {
      return pipeline.readSpriteProbe(opaqueCore)
    },

    readResolveProbe() {
      return pipeline.readResolveProbe()
    },

    get quality() {
      return pipeline.quality
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
      // ライト本体の位置は大気側が太陽方向から決めるので触らない
      pipeline.setLightAnchor(sample.position.x, sample.position.y, sample.position.z)
      // 影の箱を機体に合わせる。太陽光の位置は updateAtmosphere() が
      // target + sunDirection * distance で決めるので、その前に動かす
      aircraftPosition.set(sample.position.x, sample.position.y, sample.position.z)
      pipeline.updateAircraftShadow(aircraftPosition)
      pipeline.updateAtmosphere()

      if (snap) chase.snap(sample, look)
      else chase.update(sample, dt, look)

      // 雲の流れは実時間ではなく sim のフレーム番号から導く。
      // これでキャプチャモードの絵が固定される
      shadowCenter.set(sample.position.x, sample.position.z)
      const cloudParams = {
        cloudTime: cloudTime(frame, FIXED_DT),
        sunDirection: pipeline.sunDirectionWorld,
        sunColor: pipeline.sunRadiance,
        ambientColor: pipeline.skyRadiance,
        coverage: options.coverage ?? DEFAULT_COVERAGE,
        shadowCenter,
        groundShadow: pipeline.quality.cloudGroundShadow,
      }
      pipeline.updateClouds(cloudParams)

      lastShadowInputs.cloudTime = cloudParams.cloudTime
      lastShadowInputs.coverage = cloudParams.coverage
      lastShadowInputs.sunX = cloudParams.sunDirection.x
      lastShadowInputs.sunY = cloudParams.sunDirection.y
      lastShadowInputs.sunZ = cloudParams.sunDirection.z
      lastShadowInputs.centerX = shadowCenter.x
      lastShadowInputs.centerZ = shadowCenter.y

      // 地形と海面が参照する雲影の領域も合わせる
      terrainUniforms.cloudShadowCenter.value.copy(shadowCenter)
      terrainUniforms.cloudShadowEnabled.value = pipeline.quality.cloudGroundShadow
        ? 1
        : 0

      // ライティングは自前で組む。MeshStandardMaterial を使わないので three の
      // ライトは効かない。大気ライブラリの放射輝度をそのまま渡す
      terrainUniforms.sunDirectionWorld.value.copy(pipeline.sunDirectionWorld)
      terrainUniforms.sunRadiance.value.copy(pipeline.sunRadiance)
      terrainUniforms.skyRadiance.value.copy(pipeline.skyRadiance)

      // LOD はカメラ位置で決める。機体位置ではない（追従カメラは後方にいる）。
      // chase の更新後に読むこと
      const cameraWorld = pipeline.updateCameraWorld()
      // 地形のモーフの基準。**影を焼くパスでも主カメラの位置を使う**ため、
      // 組み込みの `cameraPosition` ではなくこれを渡す
      terrainUniforms.morphOrigin.value.copy(cameraWorld)

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
      pipeline.dispose()
    },
  }
}
