import * as THREE from 'three'
import { getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere'
import { Geodetic } from '@takram/three-geospatial'
import { loadAircraftModel } from '../aircraft/model'
import {
  DETAIL_SIZE,
  NOISE_SLICE_SIDE,
  SHAPE_SIZE,
  WEATHER_SIZE,
} from '../clouds/noise'
import {
  SHADOW_SIZE,
  shadowHistogram,
  shadowTileMeans,
  tileMeans,
} from '../clouds/geometry'
import { SHADOW_EXTENT } from '../clouds/cloudsPass'
import type { ShadowInputs } from '../clouds/shadowInputs'
import {
  MARCH_PROBE_AMBIENT,
  MARCH_PROBE_ASPECT,
  MARCH_PROBE_CAMERA,
  MARCH_PROBE_CLOUD_TIME,
  MARCH_PROBE_COVERAGE,
  MARCH_PROBE_HEIGHT,
  MARCH_PROBE_LIGHT_GROWTH,
  MARCH_PROBE_LIGHT_STEPS,
  MARCH_PROBE_MAX_DISTANCE,
  MARCH_PROBE_MAX_STEPS,
  MARCH_PROBE_PIXEL_JITTER,
  MARCH_PROBE_START_JITTER,
  MARCH_PROBE_STEP_GROWTH,
  MARCH_PROBE_SUN,
  MARCH_PROBE_SUN_COLOR,
  MARCH_PROBE_USE_DETAIL,
  MARCH_PROBE_WIDTH,
  RESOLVE_PROBE_BLEND_WEIGHT,
  RESOLVE_PROBE_CLAMP_SCALE,
  RESOLVE_PROBE_JITTER_B,
  RESOLVE_PROBE_PREVIOUS_CAMERA,
  byteDifference,
  marchExhaustedCount,
  marchSampleStats,
} from '../clouds/marchProbe'
import { HASH_PROBE_SIDE } from '../hashReference'
import { loadCarrier, placeCarrier, DECK_HEIGHT } from '../carrier'
import {
  createLocalFrame,
  dateForHour,
  REFERENCE_LATITUDE,
  REFERENCE_LONGITUDE,
} from '../atmosphere'
import { DEFAULT_EXPOSURE, type NodeProbeResult } from './types'
import type { QualitySettings } from '../quality'

/**
 * node 経路を立てて glb を 1 枚描く。
 *
 * 段 9 の目的は移行の前提を測ることであって、絵を作ることではない。
 * 確かめるのは 3 つ。`WebGPURenderer` が `await renderer.init()` を経て
 * 立つこと。`three` と `three/webgpu` がコアクラスを共有すること。
 * glb の材質（`MeshStandardMaterial`）が無変換で描けること。
 *
 * **雲も地形も海面も入れない。**それらは `ShaderMaterial` で書いてあり、
 * `StandardNodeLibrary` に登録がない。移すのは段 11 以降で、この段では
 * 「入れていないから出ない」を確かめるところまで。
 *
 * **入れても落ちない。**実測すると `THREE.NodeBuilder: Material
 * "ShaderMaterial" is not compatible.` をコンソールへ出したまま描画は進み、
 * `initError` も立たない。例外で止まると思っていると、エラーを 1 行見落と
 * した時点で「動いている」と読んでしまう。だから `shaderMaterials` を
 * 数えて構造でも見張る。
 */
export interface NodeProbeOptions {
  /** 1 = `forceWebGL: true`、2 = WebGPU */
  gpu: number
  aircraftUrl: string
  carrierUrl: string
  width: number
  height: number
  /** 定常状態で測る枚数。既定 8 */
  frames?: number
  /** 時刻 0〜24。WebGL 経路と同じ太陽が出ることを確かめるのに使う */
  hour: number
  /**
   * 品質プリセット。
   *
   * **項目ごとに受け取らない。**LUT の倍率も影のフィルタも雲の歩数も同じ
   * 表から来るので、写しを作ると片方だけ古くなる。`?preset=` で振れる
   */
  quality: QualitySettings
  /**
   * 雲影を焼くときの入力。null なら焼かない。
   *
   * **GLSL 側が実際に焼いた値をそのまま受け取る。**`?shadowinputs=` で渡す。
   * ここで導き直すと、導き方が食い違ったときにヒストグラムの不一致が
   * 移植の欠陥に見える
   */
  shadowInputs: ShadowInputs | null
  /**
   * 高さ場を TSL で引いて出すか。`?heightprobe=1`。
   *
   * 標本点は `terrain/heightProbe.ts` が唯一の定義で、CPU 側も同じ式で引く
   */
  heightProbe: boolean
  /**
   * 影を node 経路で立てて測るか。`?nodeshadow=1`。
   *
   * `shadow(light)` の経路が立つか、`PCFSoftShadowMap` が通るか、影マップが
   * 1 フレームに 1 回しか焼かれないかを見る
   */
  nodeShadow: boolean
  /** 円形スプライトを TSL で焼くか。`?spriteprobe=1` */
  spriteProbe: boolean
  /** トーンマッピングを TSL で焼くか。`?toneprobe=1` */
  toneProbe: boolean
  /** 雲の合成を焼くか。`?overlayprobe=1` */
  overlayProbe: boolean
  /**
   * 地表と海面を固定の矩形で焼くか。`?surfaceprobe=1`。
   *
   * 矩形とカメラと放射輝度は `terrain/surfaceProbe.ts` が唯一の定義で、
   * GLSL 側も同じものを読む
   */
  surfaceProbe: boolean
  /**
   * ポストの鎖を `RenderPipeline` で組むか。`?nodepipeline=1`。
   *
   * `pass(scene, camera)` → 雲の合成 → `smaa` → `renderOutput`。
   * **WebGPU バックエンドでだけ組む。**大気が要るため
   */
  nodePipeline: boolean
  /**
   * 雲のマーチを固定の入力で焼くか。`?marchprobe=1`。
   *
   * 入力は `clouds/marchProbe.ts` が唯一の定義で、GLSL 側も同じものを読む
   */
  marchProbe: boolean
}

export async function runNodeProbe(
  canvas: HTMLCanvasElement,
  options: NodeProbeOptions,
): Promise<NodeProbeResult> {
  // **動的に読む。**`three/webgpu` は 2.2 MB あり、既定の経路には要らない。
  // コアは `three.core.js` から来るので `three` 側と実体を共有する
  const webgpu = await import('three/webgpu')
  const sharedCore = (webgpu as unknown as { Mesh: unknown }).Mesh === THREE.Mesh

  const initStarted = performance.now()
  const renderer = new webgpu.WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: options.gpu === 1,
    // **`timestamp-query` が無いと静かに false になる。**有効にならなくても
    // 例外は出ず、`resolveTimestampsAsync()` が `undefined` を返すだけ
    // （段 18）
    trackTimestamp: true,
  })
  // **これを忘れると描けない。**`WebGLRenderer` と違ってバックエンドの
  // 取得が非同期なので、起動列へ入れる必要がある
  await renderer.init()
  const initMs = performance.now() - initStarted

  const isWebGPU = 'isWebGPUBackend' in renderer.backend

  // ---- 雲ノイズと気象マップを TSL で焼く ----
  //
  // **体積をそのまま焼く。**段 11 は 1 スライスを 2D のレンダーターゲットへ
  // 焼いて比べていた。式の一致は見られるが、**層への焼き込みは見張られない。**
  // 64³ を焼いて中央スライスを引き出せば、式と層の両方が 1 つの検査に乗る。
  // 密度と雲影を走らせるにも体積そのものが要る
  const tsl = await import('three/tsl')
  const noiseNodes = await import('../clouds/noiseNodes')
  const volume = await import('../clouds/volume')

  const quad = volume.createBakeQuad()
  const bakeStarted = performance.now()

  // GLSL 版と同じ周波数の上限を使う。`noise.ts` の `bakeVolume` の式を写す。
  // 1 セルに 4 テクセル確保できるところまで。超えると白色ノイズになる
  const maxFreq = (size: number): number => Math.max(1, Math.floor(size / 4))

  const shapeVolume = volume.bakeVolume(renderer, quad, {
    side: SHAPE_SIZE,
    fragment: (layer) =>
      noiseNodes.noiseFragmentNode(0, maxFreq(SHAPE_SIZE), layer),
  })
  const detailVolume = volume.bakeVolume(renderer, quad, {
    side: DETAIL_SIZE,
    fragment: (layer) =>
      noiseNodes.noiseFragmentNode(1, maxFreq(DETAIL_SIZE), layer),
  })
  const weatherPlane = volume.bakePlane(
    renderer,
    quad,
    WEATHER_SIZE,
    WEATHER_SIZE,
    noiseNodes.weatherFragmentNode(),
    // 世界座標で引き回すので折り返す。GLSL 版と揃える
    { repeat: true },
  )
  const volumeMs = performance.now() - bakeStarted

  // GLSL 版（`noise.ts` の `sampleSlice`）が読むのと同じ層の同じ左下 16x16
  const noiseSlice = await volume.readVolumeSlice(
    renderer,
    quad,
    shapeVolume.texture,
    Math.floor(SHAPE_SIZE / 2),
    NOISE_SLICE_SIDE,
    isWebGPU,
  )

  // 気象マップも突き合わせる。**雲の配置を決めるのはこちら。**ずれると
  // 雲の湧く場所が変わるが、雲影の分布では捕まらない
  const weatherSlice = await volume.readPlaneSlice(
    renderer,
    quad,
    weatherPlane.texture,
    NOISE_SLICE_SIDE,
    isWebGPU,
  )

  const hashTarget = volume.bakePlane(
    renderer,
    quad,
    HASH_PROBE_SIDE,
    HASH_PROBE_SIDE,
    noiseNodes.hashProbeFragmentNode(HASH_PROBE_SIDE),
  )
  const hashProbe = await volume.readPlane(
    renderer,
    hashTarget,
    HASH_PROBE_SIDE,
    HASH_PROBE_SIDE,
    isWebGPU,
  )
  hashTarget.dispose()

  // ---- 雲影マップ ----
  //
  // **段 12 の合格条件。**GLSL 版が焼いた 256² と 16 ビンのヒストグラムで
  // 比べ、L1 距離 0.01 未満を求める。入力は GLSL 側が実際に使った値をもらう
  // ので、食い違えば移植の欠陥だと言い切れる
  let shadowBins: number[] | null = null
  let shadowTiles: number[] | null = null
  if (options.shadowInputs !== null) {
    const densityNodes = await import('../clouds/densityNodes')
    const shadow = options.shadowInputs
    const shadowTarget = volume.bakePlane(
      renderer,
      quad,
      SHADOW_SIZE,
      SHADOW_SIZE,
      densityNodes.cloudShadowFragmentNode(
        {
          shapeNoise: shapeVolume.texture,
          detailNoise: detailVolume.texture,
          weatherMap: weatherPlane.texture,
          cloudTime: tsl.float(shadow.cloudTime),
          coverage: tsl.float(shadow.coverage),
        },
        tsl.uv(),
        tsl.vec2(shadow.centerX, shadow.centerZ),
        tsl.float(SHADOW_EXTENT),
        tsl.vec3(shadow.sunX, shadow.sunY, shadow.sunZ),
      ),
    )
    // ヒストグラムは並びを問わないが、読み戻しの道は 1 本にしておく
    const bytes = await volume.readPlane(
      renderer,
      shadowTarget,
      SHADOW_SIZE,
      SHADOW_SIZE,
      isWebGPU,
    )
    shadowBins = shadowHistogram(bytes)
    // **配置も出す。**分布だけでは影が同じ場所にあることを言えない
    shadowTiles = shadowTileMeans(bytes, SHADOW_SIZE)
    shadowTarget.dispose()
  }

  // ---- 雲のマーチ ----
  //
  // **段 13 の合格条件。**固定のカメラと固定の入力で 3 枚焼き、GLSL 版と
  // 突き合わせる。密度サンプル数と打ち切りの数は整数なので、歩き方が
  // 同じなら完全に一致するはず。絵は演算順序で動くので区画平均で見る
  let march: NodeProbeResult['march'] = null
  if (options.marchProbe) {
    const marchNodes = await import('../clouds/marchNodes')

    const marchCamera = new THREE.PerspectiveCamera(
      MARCH_PROBE_CAMERA.fov,
      MARCH_PROBE_ASPECT,
      MARCH_PROBE_CAMERA.near,
      MARCH_PROBE_CAMERA.far,
    )
    marchCamera.position.set(
      MARCH_PROBE_CAMERA.positionX,
      MARCH_PROBE_CAMERA.positionY,
      MARCH_PROBE_CAMERA.positionZ,
    )
    marchCamera.lookAt(
      MARCH_PROBE_CAMERA.targetX,
      MARCH_PROBE_CAMERA.targetY,
      MARCH_PROBE_CAMERA.targetZ,
    )
    marchCamera.updateMatrixWorld()
    marchCamera.updateProjectionMatrix()

    // `@types/three` は `uniform()` の戻りを TSL のノード型へ絞らないので、
    // 逃げ口を 1 か所へ寄せる
    const node = <T>(value: unknown): T => tsl.uniform(value as never) as unknown as T

    const marchInputs = {
      shapeNoise: shapeVolume.texture,
      detailNoise: detailVolume.texture,
      weatherMap: weatherPlane.texture,
      cloudTime: tsl.float(MARCH_PROBE_CLOUD_TIME),
      coverage: tsl.float(MARCH_PROBE_COVERAGE),
      // 遮蔽物を置かないので深度は 1.0（空）で固定
      sceneDepth: tsl.float(1),
      inverseProjectionMatrix: node<Parameters<
        typeof marchNodes.cloudMarchFragmentNode
      >[0]['inverseProjectionMatrix']>(marchCamera.projectionMatrixInverse),
      inverseViewMatrix: node<Parameters<
        typeof marchNodes.cloudMarchFragmentNode
      >[0]['inverseViewMatrix']>(marchCamera.matrixWorld),
      cameraPositionWorld: tsl.vec3(
        MARCH_PROBE_CAMERA.positionX,
        MARCH_PROBE_CAMERA.positionY,
        MARCH_PROBE_CAMERA.positionZ,
      ),
      cameraNear: tsl.float(MARCH_PROBE_CAMERA.near),
      cameraFar: tsl.float(MARCH_PROBE_CAMERA.far),
      sunDirection: tsl.vec3(MARCH_PROBE_SUN.x, MARCH_PROBE_SUN.y, MARCH_PROBE_SUN.z),
      sunColor: tsl.vec3(
        MARCH_PROBE_SUN_COLOR.x,
        MARCH_PROBE_SUN_COLOR.y,
        MARCH_PROBE_SUN_COLOR.z,
      ),
      ambientColor: tsl.vec3(
        MARCH_PROBE_AMBIENT.x,
        MARCH_PROBE_AMBIENT.y,
        MARCH_PROBE_AMBIENT.z,
      ),
      maxSteps: tsl.int(MARCH_PROBE_MAX_STEPS),
      lightSteps: tsl.int(MARCH_PROBE_LIGHT_STEPS),
      lightGrowth: tsl.float(MARCH_PROBE_LIGHT_GROWTH),
      maxMarchDistance: tsl.float(MARCH_PROBE_MAX_DISTANCE),
      stepGrowthScale: tsl.float(MARCH_PROBE_STEP_GROWTH),
      startJitter: tsl.float(MARCH_PROBE_START_JITTER),
      pixelJitter: tsl.vec2(MARCH_PROBE_PIXEL_JITTER.x, MARCH_PROBE_PIXEL_JITTER.y),
      useDetail: MARCH_PROBE_USE_DETAIL,
    }

    const bakeMarch = async (mode: 0 | 1 | 2): Promise<number[]> => {
      const target = volume.bakePlane(
        renderer,
        quad,
        MARCH_PROBE_WIDTH,
        MARCH_PROBE_HEIGHT,
        marchNodes.cloudMarchFragmentNode(marchInputs, mode),
      )
      const bytes = await volume.readPlane(
        renderer,
        target,
        MARCH_PROBE_WIDTH,
        MARCH_PROBE_HEIGHT,
        isWebGPU,
      )
      target.dispose()
      return bytes
    }

    // ---- 時間方向の足し込み ----
    //
    // 現フレームと履歴には、**ずらしだけを変えたマーチの出力そのもの**を
    // 使う。マーチが両側でバイトまで一致することは前半で確かめてあるので、
    // 入力が同じであることは言い切れる
    const resolveNodes = await import('../clouds/resolveNodes')
    const bakeMarchTarget = (startJitter: number) =>
      volume.bakePlane(
        renderer,
        quad,
        MARCH_PROBE_WIDTH,
        MARCH_PROBE_HEIGHT,
        marchNodes.cloudMarchFragmentNode({ ...marchInputs, startJitter: tsl.float(startJitter) }, 0),
      )

    const currentTarget = bakeMarchTarget(MARCH_PROBE_START_JITTER)
    const historyTarget = bakeMarchTarget(RESOLVE_PROBE_JITTER_B)

    const previousCamera = new THREE.PerspectiveCamera(
      RESOLVE_PROBE_PREVIOUS_CAMERA.fov,
      MARCH_PROBE_ASPECT,
      RESOLVE_PROBE_PREVIOUS_CAMERA.near,
      RESOLVE_PROBE_PREVIOUS_CAMERA.far,
    )
    previousCamera.position.set(
      RESOLVE_PROBE_PREVIOUS_CAMERA.positionX,
      RESOLVE_PROBE_PREVIOUS_CAMERA.positionY,
      RESOLVE_PROBE_PREVIOUS_CAMERA.positionZ,
    )
    previousCamera.lookAt(
      RESOLVE_PROBE_PREVIOUS_CAMERA.targetX,
      RESOLVE_PROBE_PREVIOUS_CAMERA.targetY,
      RESOLVE_PROBE_PREVIOUS_CAMERA.targetZ,
    )
    previousCamera.updateMatrixWorld()
    previousCamera.updateProjectionMatrix()
    const previousViewProjection = new THREE.Matrix4().multiplyMatrices(
      previousCamera.projectionMatrix,
      previousCamera.matrixWorldInverse,
    )

    const resolveTarget = volume.bakePlane(
      renderer,
      quad,
      MARCH_PROBE_WIDTH,
      MARCH_PROBE_HEIGHT,
      resolveNodes.cloudResolveFragmentNode({
        currentFrame: currentTarget.texture,
        historyFrame: historyTarget.texture,
        inverseProjectionMatrix: marchInputs.inverseProjectionMatrix,
        inverseViewMatrix: marchInputs.inverseViewMatrix,
        previousViewProjection: node<
          typeof marchInputs.inverseViewMatrix
        >(previousViewProjection),
        cameraPositionWorld: marchInputs.cameraPositionWorld,
        blendWeight: tsl.float(RESOLVE_PROBE_BLEND_WEIGHT),
        texelSize: tsl.vec2(1 / MARCH_PROBE_WIDTH, 1 / MARCH_PROBE_HEIGHT),
        clampScale: RESOLVE_PROBE_CLAMP_SCALE,
      }),
    )
    const resolveBytes = await volume.readPlane(
      renderer,
      resolveTarget,
      MARCH_PROBE_WIDTH,
      MARCH_PROBE_HEIGHT,
      isWebGPU,
    )
    currentTarget.dispose()
    historyTarget.dispose()
    resolveTarget.dispose()

    march = {
      samples: marchSampleStats(await bakeMarch(1)),
      exhausted: marchExhaustedCount(await bakeMarch(2)),
      tiles: tileMeans(await bakeMarch(0), MARCH_PROBE_WIDTH, MARCH_PROBE_HEIGHT),
      resolve: resolveBytes,
    }
  }

  // ---- トーンマッピング ----
  //
  // **段 17 の入口。**計画は「AgX は式が同じで露出 6 はそのまま持ち越せる」と
  // 書いている。持ち越せるなら VFX の色定数を測り直さずに済む
  let tone: NodeProbeResult['tone'] = null
  if (options.toneProbe) {
    const toneProbe = await import('../toneProbe')
    const side = toneProbe.TONE_PROBE_SIDE
    const count = toneProbe.TONE_PROBE_COUNT

    // GLSL 側と同じ式で放射輝度を導く
    const col = tsl.floor(tsl.uv().x.mul(side))
    const row = tsl.floor(tsl.uv().y.mul(side))
    const t = row.mul(side).add(col).div(count - 1)
    const v = tsl.pow(
      tsl.float(10),
      tsl
        .float(toneProbe.TONE_PROBE_MIN_LOG)
        .add(t.mul(toneProbe.TONE_PROBE_MAX_LOG - toneProbe.TONE_PROBE_MIN_LOG)),
    )
    const hdr = v.mul(
      tsl.vec3(
        toneProbe.TONE_PROBE_RATIO.r,
        toneProbe.TONE_PROBE_RATIO.g,
        toneProbe.TONE_PROBE_RATIO.b,
      ),
    )
    // **露出の渡し方だけが違う。**GLSL は uniform を関数の中で読み、
    // TSL は引数で受ける
    // `@types/three` の `agxToneMapping` は型引数の付かない `Node` を返す。
    // 逃げ口を 1 か所へ寄せる
    const mapped = tsl.agxToneMapping(
      hdr,
      tsl.float(toneProbe.TONE_PROBE_EXPOSURE),
    ) as unknown as import('three/webgpu').Node<'vec3'>

    const toneTarget = volume.bakePlane(
      renderer,
      quad,
      side,
      side,
      tsl.vec4(mapped, 1),
    )
    tone = await volume.readPlane(renderer, toneTarget, side, side, isWebGPU)
    toneTarget.dispose()
  }

  // ---- 雲の合成 ----
  //
  // **段 17。**`AerialPerspectiveNode` に `overlay` が無いので、雲を大気へ
  // 差し込む合成を自前で書く。式は GLSL 版から写した
  let overlay: NodeProbeResult['overlay'] = null
  let overlaySource: NodeProbeResult['overlaySource'] = null
  if (options.overlayProbe) {
    const probe = await import('../overlayProbe')
    const side = probe.OVERLAY_PROBE_SIDE

    // GLSL 側と同じ式で入力を導く。**写しを 2 つ持たないよう定数は
    // `overlayProbe.ts` から読む**
    const col = tsl.floor(tsl.uv().x.mul(side))
    const row = tsl.floor(tsl.uv().y.mul(side))
    // **除算で 1 を作らない。**GLSL 側と同じ理由（`overlayProbe.ts` の注記）
    const alpha = tsl.select(
      col.greaterThanEqual(probe.OVERLAY_PROBE_FULL_COLUMN),
      tsl.float(1),
      col.div(probe.OVERLAY_PROBE_FULL_COLUMN),
    )
    const bright = row.div(side - 1)

    const cloudNode = tsl.vec4(
      tsl
        .vec3(
          probe.OVERLAY_PROBE_CLOUD_RATIO.r,
          probe.OVERLAY_PROBE_CLOUD_RATIO.g,
          probe.OVERLAY_PROBE_CLOUD_RATIO.b,
        )
        .mul(alpha)
        .mul(tsl.float(1).sub(bright)),
      alpha,
    )
    // 大気の結果の代わり。**関数で渡す。**呼ばれるのは `Else` の中だけ
    const baseNode = (): import('three/webgpu').Node<'vec4'> =>
      tsl.vec4(
        tsl
          .vec3(
            probe.OVERLAY_PROBE_BASE_RATIO.r,
            probe.OVERLAY_PROBE_BASE_RATIO.g,
            probe.OVERLAY_PROBE_BASE_RATIO.b,
          )
          .mul(bright),
        probe.OVERLAY_PROBE_BASE_ALPHA,
      )

    const overlayNodes = await import('../overlayNodes')

    const bake = async (fragment: import('three/webgpu').Node<'vec4'>): Promise<number[]> => {
      const target = volume.bakePlane(renderer, quad, side, side, fragment)
      const bytes = await volume.readPlane(renderer, target, side, side, isWebGPU)
      target.dispose()
      return bytes
    }

    const composite = await bake(overlayNodes.overlayCompositeNode(cloudNode, baseNode))
    const marker = await bake(
      overlayNodes.overlayCompositeNode(cloudNode, baseNode, { marker: true }),
    )

    // **引き直しても同じ絵になるか。**雲は本番ではレンダーターゲットから
    // 来る。node 経路は `isRenderTargetTexture` のとき v を裏返して読むので
    // （`resolveNodes.ts` の `sampleTarget`）、そこが合っていなければ
    // 上下の裏返った雲を合成することになる。**絵は出るが上下が逆になる**
    const cloudTarget = volume.bakePlane(renderer, quad, side, side, cloudNode)
    const sampledCloud = tsl.texture(
      cloudTarget.texture,
      tsl.vec2(tsl.uv().x, tsl.float(1).sub(tsl.uv().y)),
    ) as unknown as import('three/webgpu').Node<'vec4'>
    const sampled = await bake(
      overlayNodes.overlayCompositeNode(sampledCloud, baseNode),
    )
    cloudTarget.dispose()

    overlay = { composite, marker, sampled }

    // 早期打ち切りが効いているかは絵に出ない。本文で位置を確かめる
    overlaySource = await volume.bakeShaderSource(
      renderer,
      quad,
      overlayNodes.overlayCompositeNode(cloudNode, baseNode),
    )
  }

  // ---- 円形スプライト ----
  //
  // **段 16。**爆発とフレアの断片は `vUv` だけの関数なので、場面を組まずに
  // 全画面のクアッドへ焼いて GLSL 版とバイトで比べられる
  let sprite: NodeProbeResult['sprite'] = null
  if (options.spriteProbe) {
    const spriteNodes = await import('../weapons/spriteNodes')
    const probe = await import('../weapons/spriteProbe')
    const side = probe.SPRITE_PROBE_SIDE
    const inputs = {
      color: tsl.vec3(
        probe.SPRITE_PROBE_COLOR.r,
        probe.SPRITE_PROBE_COLOR.g,
        probe.SPRITE_PROBE_COLOR.b,
      ),
      opacity: tsl.float(probe.SPRITE_PROBE_OPACITY),
      falloff: tsl.float(probe.SPRITE_PROBE_FALLOFF),
    }
    const bakeSprite = async (opaqueCore: boolean): Promise<number[]> => {
      const target = volume.bakePlane(
        renderer,
        quad,
        side,
        side,
        spriteNodes.radialSpriteFragmentNode(inputs, opaqueCore),
      )
      const bytes = await volume.readPlane(renderer, target, side, side, isWebGPU)
      target.dispose()
      return bytes
    }
    sprite = { soft: await bakeSprite(false), core: await bakeSprite(true) }
  }

  // ---- 高さ場 ----
  //
  // **段 14 の合格条件。**64 点を焼いて読み戻し、`src/sim/terrain.ts` の
  // `heightAt` と 1e-3 m 以内で一致することを見る。ずれると「見えている山と
  // 当たる山が違う」状態になり、高さ場を sim に持たせた意味がなくなる
  let heightProbe: number[] | null = null
  if (options.heightProbe) {
    const heightNodes = await import('../terrain/heightNodes')
    const { defaultTerrain } = await import('../../sim/terrain')
    const { createHeightTexture } = await import('../terrain/heightTexture')
    const probe = await import('../terrain/heightProbe')

    const terrain = defaultTerrain()
    const heightMap = createHeightTexture(terrain)
    const fieldInputs = {
      heightMap,
      extent: terrain.extent,
      texels: terrain.size,
    }

    const side = probe.HEIGHT_PROBE_SIDE
    heightProbe = []
    for (const region of probe.HEIGHT_PROBE_REGIONS) {
      // 画素の位置から標本点を導く。`heightProbePoint` と同じ式
      const col = tsl.int(tsl.uv().x.mul(side))
      const row = tsl.int(tsl.uv().y.mul(side))
      const world = tsl.vec2(
        tsl.float(col).mul(region.step.x).add(region.origin.x),
        tsl.float(row).mul(region.step.z).add(region.origin.z),
      )
      const heightTarget = volume.bakePlane(
        renderer,
        quad,
        side,
        side,
        tsl.vec4(heightNodes.terrainHeightNode(fieldInputs, world), 0, 0, 1),
        // **8bit では mm の精度が出ない。**32bit 浮動小数で受ける
        { float: true },
      )
      heightProbe.push(
        ...probe.heightProbeValues(
          await volume.readPlane(renderer, heightTarget, side, side, isWebGPU),
        ),
      )
      heightTarget.dispose()
    }
    heightMap.dispose()
  }

  // ---- 地表と海面 ----
  //
  // **段 17b。**`terrain.frag` と `water.frag` の色の本体を TSL へ移した。
  // 固定の矩形を両側へ渡してバイトで比べる。**大気に触らせない**ので
  // `?gpu=1` でも走り、そこでは丸めまで一致するはず
  let surface: NodeProbeResult['surface'] = null
  if (options.surfaceProbe) {
    const surfaceNodes = await import('../terrain/surfaceNodes')
    const heightNodesRef = await import('../terrain/heightNodes')
    const { defaultTerrain } = await import('../../sim/terrain')
    const { createHeightTexture, createNormalTexture } = await import(
      '../terrain/heightTexture'
    )
    const probe = await import('../terrain/surfaceProbe')

    const terrain = defaultTerrain()
    const heightMap = createHeightTexture(terrain)
    const normalMap = createNormalTexture(terrain)
    const probeGl = await import('../terrain/surfaceProbeGl')
    const shadowMap = probeGl.createSurfaceProbeShadowTexture()
    const side = probe.SURFACE_PROBE_SIDE

    const inputs: import('../terrain/surfaceNodes').SurfaceInputs = {
      heightMap,
      extent: terrain.extent,
      texels: terrain.size,
      terrainNormalMap: normalMap,
      cloudShadowMap: shadowMap,
      cloudShadowCenter: tsl.vec2(
        probe.SURFACE_PROBE_SHADOW_CENTER.x,
        probe.SURFACE_PROBE_SHADOW_CENTER.z,
      ),
      cloudShadowExtent: tsl.float(probe.SURFACE_PROBE_SHADOW_EXTENT),
      cloudShadowEnabled: tsl.float(1),
      sunDirectionWorld: tsl.vec3(
        probe.SURFACE_PROBE_SUN_DIRECTION.x,
        probe.SURFACE_PROBE_SUN_DIRECTION.y,
        probe.SURFACE_PROBE_SUN_DIRECTION.z,
      ),
      sunRadiance: tsl.vec3(
        probe.SURFACE_PROBE_SUN_RADIANCE.x,
        probe.SURFACE_PROBE_SUN_RADIANCE.y,
        probe.SURFACE_PROBE_SUN_RADIANCE.z,
      ),
      skyRadiance: tsl.vec3(
        probe.SURFACE_PROBE_SKY_RADIANCE.x,
        probe.SURFACE_PROBE_SKY_RADIANCE.y,
        probe.SURFACE_PROBE_SKY_RADIANCE.z,
      ),
    }

    /** 画素の位置から矩形の中のワールド座標を出す。GLSL 側と同じ式 */
    const worldXZ = (region: import('../terrain/surfaceProbe').SurfaceRegion) => {
      const col = tsl.floor(tsl.uv().x.mul(side))
      const row = tsl.floor(tsl.uv().y.mul(side))
      return tsl.vec2(
        col.add(0.5).div(side).mul(region.span).add(region.origin.x),
        row.add(0.5).div(side).mul(region.span).add(region.origin.z),
      )
    }

    const bake = async (
      fragment: import('three/webgpu').Node<'vec4'>,
    ): Promise<number[]> => {
      const target = volume.bakePlane(renderer, quad, side, side, fragment)
      const bytes = await volume.readPlane(renderer, target, side, side, isWebGPU)
      target.dispose()
      return bytes
    }

    /**
     * 照度の口へ、段 17b までと同じ値を流し込む差し替え。
     *
     * **1/pi がちょうど 1 回だけ掛かることを縛る。**`skyRadiance` は
     * 放射輝度なので pi を掛けて照度へ戻す。掛け忘れや二重掛けがあれば
     * 3.14 倍ずれて出る
     */
    const matchedIlluminance: import('../terrain/surfaceNodes').IlluminanceProvider =
      (_world, normal) => ({
        direct: inputs.sunRadiance.mul(
          tsl.max(tsl.dot(normal, inputs.sunDirectionWorld), 0),
        ),
        indirect: inputs.skyRadiance.mul(Math.PI),
      })

    const terrainFragment = (
      branchMode: boolean,
      illuminance?: import('../terrain/surfaceNodes').IlluminanceProvider,
    ) =>
      tsl.Fn(() => {
        const region = probe.TERRAIN_PROBE_REGION
        const xz = worldXZ(region).toVar()
        const world = tsl.vec3(
          xz.x,
          heightNodesRef.terrainHeightNode(inputs, xz),
          xz.y,
        ).toVar()
        return surfaceNodes.terrainSurfaceNode(
          inputs,
          world,
          tsl.vec3(region.camera.x, region.camera.y, region.camera.z),
          tsl.float(1),
          tsl.float(1),
          illuminance !== undefined ? { illuminance } : { branchMode },
        )
      })() as import('three/webgpu').Node<'vec4'>

    const waterFragment = (regionIndex: number, branchMode: boolean) =>
      tsl.Fn(() => {
        const region = probe.WATER_PROBE_REGIONS[regionIndex]!
        const xz = worldXZ(region).toVar()
        // 海面は高度 0 の平らな板
        const world = tsl.vec3(xz.x, 0, xz.y).toVar()
        return surfaceNodes.waterSurfaceNode(
          inputs,
          world,
          tsl.vec3(region.camera.x, region.camera.y, region.camera.z),
          tsl.float(probe.SURFACE_PROBE_WAVE_TIME),
          tsl.float(1),
          tsl.float(1),
          { branchMode },
        )
      })() as import('three/webgpu').Node<'vec4'>

    // 頂点変位。**高さ場と同じく CPU 参照と突き合わせる**（`heightProbe.ts`
    // の作法）。GLSL 側は `tests/render/terrain.test.ts` が本文で縛る
    const patch = probe.TERRAIN_PATCH_PROBE
    const patchFragment = tsl.Fn(() => {
      const cells = patch.cells
      // 実際の格子点だけを通す。連続にすると段差の境目に乗る
      const unit = (axis: import('three/webgpu').Node<'float'>) =>
        tsl.min(tsl.floor(axis.mul(cells + 1)), cells).div(cells)
      const unitGrid = tsl.vec2(unit(tsl.uv().x), unit(tsl.uv().y)).toVar()
      const world = surfaceNodes
        .terrainPatchWorldNode(
          unitGrid,
          tsl.vec4(patch.origin.x, patch.origin.z, patch.size, patch.size / cells),
          tsl.vec2(patch.morphStart, patch.morphEnd),
          tsl.vec3(patch.basis.x, patch.basis.y, patch.basis.z),
        )
        .toVar()
      const height = heightNodesRef.terrainHeightNode(
        inputs,
        tsl.vec2(world.x, world.y),
      )
      return tsl.vec4(world.x, world.y, world.z, height)
    })() as import('three/webgpu').Node<'vec4'>

    const patchTarget = volume.bakePlane(renderer, quad, side, side, patchFragment, {
      // **8bit では m の精度が出ない。**32bit 浮動小数で受ける
      float: true,
    })
    const patchBytes = await volume.readPlane(
      renderer,
      patchTarget,
      side,
      side,
      isWebGPU,
    )
    patchTarget.dispose()

    surface = {
      patch: patchBytes,
      terrain: await bake(terrainFragment(false)),
      terrainBranches: await bake(terrainFragment(true)),
      terrainMatched: await bake(terrainFragment(false, matchedIlluminance)),
      water: [],
      waterBranches: [],
    }
    for (let i = 0; i < probe.WATER_PROBE_REGIONS.length; i++) {
      surface.water.push(await bake(waterFragment(i, false)))
      surface.waterBranches.push(await bake(waterFragment(i, true)))
    }

    heightMap.dispose()
    normalMap.dispose()
    shadowMap.dispose()
  }

  quad.dispose()
  shapeVolume.dispose()
  detailVolume.dispose()
  weatherPlane.dispose()

  renderer.setPixelRatio(1)
  renderer.setSize(options.width, options.height, false)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a1c26)
  const camera = new THREE.PerspectiveCamera(
    60,
    options.width / options.height,
    1,
    5_000,
  )
  camera.position.set(0, DECK_HEIGHT + 45, 190)
  camera.lookAt(0, DECK_HEIGHT, 0)

  const model = await loadAircraftModel(options.aircraftUrl)
  model.object.position.set(0, DECK_HEIGHT + 8, 0)
  scene.add(model.object)

  const carrier = await loadCarrier(options.carrierUrl)
  placeCarrier(carrier, 0, 0, 0)
  scene.add(carrier.object)

  // ---- 大気 ----
  //
  // **WebGPU バックエンドのときだけ組む。**node 経路の WebGL2
  // フォールバックでは、大気の構造体が GLSL のコンパイルで落ちる
  // （`ERROR: 0:76: 'AtmosphereParameters' : syntax error`。実測）。
  // 計画は `forceWebGL: true` を移行中の退避路として当てにしていたが、
  // **大気には効かない。**
  let atmosphereContext: InstanceType<
    typeof import('@takram/three-atmosphere/webgpu').AtmosphereContext
  > | null = null
  let sunElevationDeg = 0
  const sunDirectionWorld = new THREE.Vector3(0, 1, 0)
  /** 大気の太陽光。鎖の側が影の投げ手として使う */
  let atmosphereSunLight: THREE.DirectionalLight | null = null

  if (isWebGPU) {
    // ---- 大気を node 経路で組む ----
    //
    // WebGL 経路は 4.1 MB の EXR を読んで `SkyMaterial` へ流し込んでいた。
    // node 経路は LUT を実行時に GPU で計算する。**その費用を測るのが
    // この段の主目的。**
    const atmos = await import('@takram/three-atmosphere/webgpu')

    // 原点も時刻も WebGL 経路と同じものを使う。**別々に持つと、絵を見比べても
    // 分からないずれ方をする**
    const referenceEcef = new Geodetic(
      REFERENCE_LONGITUDE,
      REFERENCE_LATITUDE,
      0,
    ).toECEF()
    const worldToECEF = createLocalFrame(referenceEcef)
    const date = dateForHour(options.hour)
    const sunDirectionECEF = getSunDirectionECEF(date, new THREE.Vector3())
    const moonDirectionECEF = getMoonDirectionECEF(date, new THREE.Vector3())
    const localUpECEF = new THREE.Vector3(0, 1, 0).transformDirection(worldToECEF)
    sunElevationDeg =
      (Math.asin(Math.max(-1, Math.min(1, sunDirectionECEF.dot(localUpECEF)))) * 180) /
      Math.PI

    // 雲のライティングはワールド座標の太陽の向きで要る。ECEF から戻す
    sunDirectionWorld
      .copy(sunDirectionECEF)
      .transformDirection(worldToECEF.clone().invert())

    // **組み立ての手順を知っているのは `atmosphereNodes.ts` だけ。**
    // `contextNode.value` を潰さないこと、`addLight` で
    // `AtmosphereLightNode` を登録すること、LUT の縮小に下限を取ること、
    // 鎖を組むときに背景へ空クアッドを置かないこと。どれも破っても例外は
    // 出ない。本番の場面と同じ関数へ通す（段 20a-2-3）
    const { setupAtmosphereNodes } = await import('../atmosphereNodes')
    const setup = setupAtmosphereNodes(atmos, {
      renderer,
      camera,
      scene,
      quality: options.quality,
      worldToECEF,
      sunDirectionECEF,
      moonDirectionECEF,
      skyBackground: !options.nodePipeline,
    })
    atmosphereContext = setup.context
    atmosphereSunLight = setup.sunLight

  } else {
    // 大気を組まないときの光。glb の材質が描けることだけを見る
    scene.add(new THREE.AmbientLight(0xffffff, 1.5))
    const sun = new THREE.DirectionalLight(0xffffff, 3)
    sun.position.set(120, 200, 80)
    scene.add(sun)
  }

  let meshes = 0
  let shaderMaterials = 0
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    meshes++
    const material = node.material as THREE.Material | THREE.Material[]
    for (const one of Array.isArray(material) ? material : [material]) {
      if ((one as { isShaderMaterial?: boolean }).isShaderMaterial === true) {
        shaderMaterials++
      }
    }
  })

  // ---- 影 ----
  //
  // **段 15。**`BasicShadowMap` を選んだ理由（比較モードが付くと自前 GLSL の
  // `sampler2D` から読めない）は node 経路では消える。フィルタを上げても
  // 通るか、影マップが 1 フレームに 1 回しか焼かれないかを測る
  let nodeShadow: NodeProbeResult['nodeShadow'] = null
  if (options.nodeShadow) {
    // 機体だけを投げ手にする。数を数えて、焼き込みの回数と突き合わせる
    let casters = 0
    model.object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        casters++
      }
    })
    carrier.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.receiveShadow = true
    })

    const shadowLight = new THREE.DirectionalLight(0xffffff, 2)
    shadowLight.position.set(60, 120, 40)
    shadowLight.target.position.set(0, DECK_HEIGHT, 0)
    shadowLight.castShadow = true
    shadowLight.shadow.mapSize.set(512, 512)
    // 機体の周りだけを覆う正射影の箱。CSM は採らない
    const cam = shadowLight.shadow.camera
    cam.left = -40
    cam.right = 40
    cam.top = 40
    cam.bottom = -40
    cam.near = 1
    cam.far = 400
    cam.updateProjectionMatrix()
    scene.add(shadowLight)
    scene.add(shadowLight.target)

    const probeTarget = new webgpu.RenderTarget(options.width, options.height)
    const measure = async (): Promise<{
      drawCalls: number
      frameCalls: number
      bytes: number[]
    }> => {
      renderer.info.reset()
      renderer.setRenderTarget(probeTarget)
      renderer.render(scene, camera)
      const drawCalls = renderer.info.render.drawCalls
      // **パスの数を数える。**影マップを 2 回焼けば 1 つ増える。
      // ドローコールでは視錐台の切り方の違いが混ざって当てにならない
      // （実測で機体の 31 回に対して影のパスは 47 回だった）
      const frameCalls = renderer.info.render.frameCalls
      const bytes = await volume.readPlane(
        renderer,
        probeTarget as unknown as Parameters<typeof volume.readPlane>[1],
        options.width,
        options.height,
        isWebGPU,
      )
      renderer.setRenderTarget(null)
      return { drawCalls, frameCalls, bytes }
    }

    renderer.shadowMap.enabled = false
    // **1 枚目を捨てる。**`?gpu=2` は大気の LUT と環境反射を初回に焼くので、
    // そのぶんがパスの数に乗る（実測で 50 回、2 枚目以降は 2 回）
    renderer.setRenderTarget(probeTarget)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)

    const without = await measure()

    // **投げ手のドローコールを数で仮定しない。**メッシュ 1 枚が複数の材質を
    // 持つと 1 回では描かれない。実測で 33 枚に対して 47 回だった。
    // 機体を消したときの差が、影のパスが払うはずの回数になる
    model.object.visible = false
    const withoutAircraft = await measure()
    model.object.visible = true
    const aircraftDrawCalls = without.drawCalls - withoutAircraft.drawCalls

    // **投げ手を切ったまま影を有効にしてみる。**ここで既にパスが増えるなら、
    // 増えたぶんは影マップではなく別のもの（大気側が `shadowMap.enabled` を
    // 見て何かを足している）ということになる
    shadowLight.castShadow = false
    renderer.shadowMap.enabled = true
    const enabledNoCaster = await measure()
    shadowLight.castShadow = true

    // プリセットの列をそのまま使う。`pcfSoft` は WebGL 経路では廃止だが
    // node 経路には生きている
    renderer.shadowMap.type =
      options.quality.shadowFilter === 'pcfSoft'
        ? THREE.PCFSoftShadowMap
        : options.quality.shadowFilter === 'pcf'
          ? THREE.PCFShadowMap
          : THREE.BasicShadowMap
    const withShadow = await measure()

    // 2 枚目。**焼き込みが 1 フレームに 1 回であることを 2 枚目でも見る**
    const second = await measure()

    renderer.shadowMap.enabled = false
    probeTarget.dispose()

    nodeShadow = {
      filter: options.quality.shadowFilter,
      casters,
      aircraftDrawCalls,
      drawCallsWithout: without.drawCalls,
      drawCallsWith: withShadow.drawCalls,
      frameCallsWithout: without.frameCalls,
      frameCallsWith: withShadow.frameCalls,
      frameCallsSecond: second.frameCalls,
      frameCallsEnabledNoCaster: enabledNoCaster.frameCalls,
      // **区画平均では鈍すぎる。**機体の影は画面のごく一部しか覆わないので、
      // 1280x720 を 4x4 に均すと 0.0003 しか動かなかった（実測）。
      // バイトの違いを数えれば数百画素でも見える
      changed: byteDifference(without.bytes, withShadow.bytes).differing,
      changedMax: byteDifference(without.bytes, withShadow.bytes).max,
    }
  }

  // ---- ポストの鎖 ----
  //
  // **段 17 の後半。**`RenderPipeline` + `pass(scene, camera)` + 雲の合成 +
  // `smaa` + `renderOutput`。ここで初めて node 経路がポスト付きの絵を出す。
  //
  // 露出とトーンマッピングはレンダラの値から入る。`RenderPipeline._update`
  // が `renderOutput(outputNode, renderer.toneMapping, ...)` を足し、
  // `ToneMappingNode` の露出は `rendererReference('toneMappingExposure')` な
  // ので、**GLSL 経路と同じ「レンダラに 6 を置く」形になる。**
  let pipelineResult: NodeProbeResult['pipeline'] = null
  let clouds: import('../clouds/cloudsNodePass').CloudsNodePass | null = null
  if (options.nodePipeline && isWebGPU && atmosphereContext !== null) {
    const atmos = await import('@takram/three-atmosphere/webgpu')
    const cloudsNodePass = await import('../clouds/cloudsNodePass')
    // SMAA は `three/tsl` ではなく addons 側にある。面積テクスチャと探索
    // テクスチャを data URI で内包する
    const { smaa } = await import('three/examples/jsm/tsl/display/SMAANode.js')

    // **ワールド座標から大気の単位空間への写し替えを知っているのは
    // `atmosphereNodes.ts` だけ。**`matrixWorldToECEF` を掛けて
    // `worldToUnit` で縮め、高度の補正を足す 3 段で、忘れても例外は出ずに
    // 値が桁ごとずれる。本番の場面と同じものを通す（段 20a-2-3）
    const { createAtmosphereNodes } = await import('../atmosphereNodes')
    const atmosphereNodes = createAtmosphereNodes(atmos, atmosphereContext)
    const atmosphereIlluminance = atmosphereNodes.illuminance
    const scalarIlluminance = atmosphereNodes.scalarIlluminance

    // **雲の太陽光と天空光も LUT から取る。**GLSL 経路は CPU で出した値を
    // uniform で渡していたが、node 経路は CPU 側に値が無い。大気は緩やかに
    // しか変わらないので、原点の海面高度で 1 度だけ引く（GLSL 経路も
    // フレームに 1 つの値を使っていた）
    const cloudOrigin = tsl.vec3(0, 0, 0)
    const cloudUp = tsl.vec3(0, 1, 0)
    const cloudSunColor = scalarIlluminance(cloudOrigin).get('direct')
    const cloudAmbientColor = atmosphereIlluminance(cloudOrigin, cloudUp).indirect.mul(
      1 / Math.PI,
    )

    // **`pass.getTextureNode()` を自前の材質へ渡してはいけない**（その材質を
    // 焼くたびに場面がもう 1 度描かれる）。深度は素のテクスチャを引く。
    // 組み方を知っているのは `nodeOutput.ts` だけ（段 20a-2-3）
    const nodeOutput = await import('./nodeOutput')
    const { scenePass, depthTexture: sceneDepthTexture } = nodeOutput.createScenePass(
      scene,
      camera,
    )

    clouds = cloudsNodePass.createCloudsNodePass({
      camera,
      noise: {
        shape: shapeVolume.texture,
        detail: detailVolume.texture,
        weather: weatherPlane.texture,
      },
      quality: options.quality,
      coverage: MARCH_PROBE_COVERAGE,
      sceneDepth: sceneDepthTexture,
      captureMode: true,
      clampScale: 0,
      sunColorNode: cloudSunColor,
      ambientColorNode: cloudAmbientColor,
    })
    clouds.setSize(options.width, options.height)
    // 色は `sunColorNode` と `ambientColorNode` で上書きしてある（段 17c）。
    // ここへ渡す固定入力は、ノードを外したときの控え
    clouds.update({
      cloudTime: MARCH_PROBE_CLOUD_TIME,
      sunDirection: sunDirectionWorld,
      sunColor: new THREE.Vector3(
        MARCH_PROBE_SUN_COLOR.x,
        MARCH_PROBE_SUN_COLOR.y,
        MARCH_PROBE_SUN_COLOR.z,
      ),
      ambientColor: new THREE.Vector3(
        MARCH_PROBE_AMBIENT.x,
        MARCH_PROBE_AMBIENT.y,
        MARCH_PROBE_AMBIENT.z,
      ),
      coverage: MARCH_PROBE_COVERAGE,
      shadowCenter: new THREE.Vector2(0, 0),
      groundShadow: true,
    })
    // ---- 地形と海面を場面へ入れる ----
    //
    // **格子もパッチの選び方も GLSL 経路と同じものを使う。**差し替わるのは
    // 材質だけで、`createTerrainMesh` と `createWater` が工場を受け取る
    const nodeMaterials = await import('../terrain/nodeMaterials')
    const terrainMeshMod = await import('../terrain/terrainMesh')
    const waterMod = await import('../terrain/water')
    const { defaultTerrain: makeTerrain } = await import('../../sim/terrain')
    const heightTex = await import('../terrain/heightTexture')

    const sceneTerrain = makeTerrain()
    const sceneHeightMap = heightTex.createHeightTexture(sceneTerrain)
    const sceneNormalMap = heightTex.createNormalTexture(sceneTerrain)

    const surfaceState = nodeMaterials.createNodeSurfaceState(
      {
        heightMap: sceneHeightMap,
        terrainNormalMap: sceneNormalMap,
        cloudShadowMap: clouds.shadowTexture,
        extent: sceneTerrain.extent,
        texels: sceneTerrain.size,
        cloudShadowExtent: SHADOW_EXTENT,
      },
      options.quality,
    )
    // **太陽の向きだけが実物。**放射輝度は段 13 の固定入力で、LUT から
    // 取り出すのは段 17c（`getSplitIlluminance`）の仕事
    surfaceState.setSunDirection(
      sunDirectionWorld.x,
      sunDirectionWorld.y,
      sunDirectionWorld.z,
    )
    surfaceState.setSunRadiance(
      MARCH_PROBE_SUN_COLOR.x,
      MARCH_PROBE_SUN_COLOR.y,
      MARCH_PROBE_SUN_COLOR.z,
    )
    surfaceState.setSkyRadiance(
      MARCH_PROBE_AMBIENT.x,
      MARCH_PROBE_AMBIENT.y,
      MARCH_PROBE_AMBIENT.z,
    )
    surfaceState.setCloudShadowCenter(0, 0)

    // ---- 機体の影 ----
    //
    // **`AtmosphereLight` は自分の位置を更新しない。**`directionECEF` を
    // 持つだけなので、影の箱を向けるにはワールド座標の太陽の向きから
    // 位置を入れる（`docs/decisions/0010-webgpu-tsl.md` の段 15 の続き）。
    //
    // GLSL 経路の `terrainAircraftShade` にあった 0.35 の下限は入れない。
    // 照度の形では間接がそのまま残るので、直達を 0 にしても真っ暗に
    // ならない。**下限は自前ライティングの都合だった**
    const shadowCaster = model.object
    shadowCaster.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true
    })
    const casterCenter = new THREE.Vector3()
    new THREE.Box3().setFromObject(shadowCaster).getCenter(casterCenter)

    // **光の側に `castShadow` を立てない。**立てると three の光の系が
    // 影のノードをもう 1 つ作る。その本体は光の寄与が畳まれると生成
    // されないまま `updateBefore` だけが残り、`compileAsync` の中で
    // `shadowMap` が null のまま触られて落ちる（実測。`AtmosphereLight`
    // でも明るさ 0 の指向光でも同じ）。
    //
    // 影は `shadow(light)` を明示的に呼んで自分で持つ。`ShadowNode` は
    // `light.castShadow` を見ないので、これで影マップは焼かれる
    const shadowLight = atmosphereSunLight
    let aircraftShade = tsl.float(1) as unknown as import('three/webgpu').Node<'float'>
    if (shadowLight !== null) {
      shadowLight.castShadow = false
      shadowLight.position
        .copy(sunDirectionWorld)
        .multiplyScalar(200)
        .add(casterCenter)
      shadowLight.target.position.copy(casterCenter)
      const size = options.quality.aircraftShadowMapSize
      shadowLight.shadow.mapSize.set(size, size)
      // 機体を囲む 28 m 角。CSM は採らない（ADR 0010）
      const box = shadowLight.shadow.camera
      box.left = -14
      box.right = 14
      box.top = 14
      box.bottom = -14
      box.near = 1
      box.far = 400
      box.updateProjectionMatrix()
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type =
        options.quality.shadowFilter === 'pcfSoft'
          ? THREE.PCFSoftShadowMap
          : options.quality.shadowFilter === 'pcf'
            ? THREE.PCFShadowMap
            : THREE.BasicShadowMap
      aircraftShade = tsl.shadow(
        shadowLight,
      ) as unknown as import('three/webgpu').Node<'float'>
    }
    const noAircraftShade = aircraftShade

    const sharedUniforms = terrainMeshMod.createTerrainUniforms(
      sceneTerrain,
      SHADOW_EXTENT,
    )
    const nodeTerrainMesh = terrainMeshMod.createTerrainMesh(
      sceneTerrain,
      options.quality,
      sharedUniforms,
      () =>
        nodeMaterials.createTerrainNodeMaterial(
          surfaceState,
          noAircraftShade,
          atmosphereIlluminance,
        ),
    )
    // 差分の帰属を測るために、段 17b までの形も 1 つ組んでおく
    const legacyTerrainMaterial = nodeMaterials.createTerrainNodeMaterial(
      surfaceState,
      noAircraftShade,
    )
    /**
     * 海面が読む放射輝度。
     *
     * **太陽は余弦を含まない側を使う。**スペキュラは太陽の見かけの明るさで
     * 決まるので、面の傾きで暗くしてはいけない。天空は半球の重みが要るので
     * `getSplitIlluminance` の間接を pi で割る。LUT を 2 度引くぶんの費用は
     * `steadyMs` で測る
     */
    const waterRadiance: import('../terrain/surfaceNodes').WaterRadianceProvider =
      (world, normal) => ({
        sun: scalarIlluminance(world).get('direct'),
        sky: atmosphereIlluminance(world, normal).indirect.mul(1 / Math.PI),
      })

    const nodeWater = waterMod.createWater(
      options.quality,
      sharedUniforms,
      () =>
        nodeMaterials.createWaterNodeMaterial(
          surfaceState,
          noAircraftShade,
          waterRadiance,
        ),
    )
    scene.add(nodeTerrainMesh.mesh)
    scene.add(nodeWater.mesh)

    // **場面のカメラでは地表がほとんど映らない。**矩形で密に測り直す。
    // 段 17b の突き合わせに使ったのと同じ 5 km 角と同じカメラを使う
    const lightProbe = await import('../terrain/surfaceProbe')
    const heightNodesForLight = await import('../terrain/heightNodes')
    const lightQuad = volume.createBakeQuad()
    const lightRegion = lightProbe.TERRAIN_PROBE_REGION
    const lightSide = lightProbe.SURFACE_PROBE_SIDE
    const lightFragment = (
      illum?: import('../terrain/surfaceNodes').IlluminanceProvider,
    ) =>
      tsl.Fn(() => {
        const col = tsl.floor(tsl.uv().x.mul(lightSide))
        const row = tsl.floor(tsl.uv().y.mul(lightSide))
        const xz = tsl
          .vec2(
            col.add(0.5).div(lightSide).mul(lightRegion.span).add(lightRegion.origin.x),
            row.add(0.5).div(lightSide).mul(lightRegion.span).add(lightRegion.origin.z),
          )
          .toVar()
        const world = tsl.vec3(
          xz.x,
          heightNodesForLight.terrainHeightNode(surfaceState.inputs, xz),
          xz.y,
        ).toVar()
        return nodeMaterials.terrainSurfaceForProbe(
          surfaceState,
          world,
          tsl.vec3(lightRegion.camera.x, lightRegion.camera.y, lightRegion.camera.z),
          illum,
        )
      })() as import('three/webgpu').Node<'vec4'>

    const bakeLight = async (
      illum?: import('../terrain/surfaceNodes').IlluminanceProvider,
    ): Promise<number[]> => {
      const target = volume.bakePlane(
        renderer,
        lightQuad,
        lightSide,
        lightSide,
        lightFragment(illum),
      )
      const bytes = await volume.readPlane(
        renderer,
        target,
        lightSide,
        lightSide,
        isWebGPU,
      )
      target.dispose()
      return bytes
    }

    // **焼くのは LUT ができてから。**`compileAsync` が
    // `AtmosphereLUTNode.setup()` を走らせ、`updateTextures` が中身を作る。
    // その前に焼くと照度が 0 になり、地表が真っ黒になる（実測でそうなった）

    // カメラの位置からパッチを選び、寄せる基準と海面の位置を合わせる
    const cameraWorld = camera.getWorldPosition(new THREE.Vector3())
    nodeTerrainMesh.update(cameraWorld.x, cameraWorld.z)
    nodeWater.follow(cameraWorld.x, cameraWorld.z)
    surfaceState.setMorphOrigin(cameraWorld.x, cameraWorld.y, cameraWorld.z)

    // 露出とトーンマッピングは GLSL 経路と同じ値をレンダラへ置く。
    // `RenderPipeline._update` が `renderOutput` を足し、`ToneMappingNode` の
    // 露出は `rendererReference('toneMappingExposure')` を読む
    renderer.toneMapping = THREE.AgXToneMapping
    renderer.toneMappingExposure = DEFAULT_EXPOSURE

    // **場面のパスを雲より先に触る**ことと、**大気の呼び出しを `Else` の
    // 中に置く**ことを知っているのは `nodeOutput.ts` だけ。前者を外すと雲が
    // 1 フレーム前の深度で打ち切り、後者を外すと早期打ち切りの稼ぎが消える。
    // どちらも絵には出ない（段 20a-2-3）
    const { composite, outputNode } = nodeOutput.createNodeOutputNode({
      atmos,
      smaa: smaa as unknown as (node: import('three/webgpu').Node) => import('three/webgpu').Node,
      scenePass,
      cloudNode: clouds.node,
    })

    // **順序を知っているのは `nodeBuild.ts` だけ。**`setMRT()` と
    // `getTextureNode()` を先に済ませること、`castShadow` を組み立ての
    // あとで立てること、雲のクアッドを別に組むこと、LUT の中身を最後に
    // 作ること。どれも破っても例外が出ない。**写しを 2 つ作ると片方だけ
    // 直したときに気づけない**ので、本番の場面と同じ関数へ通す（段 20a-2-3）
    const { buildNodePipeline } = await import('./nodeBuild')
    const built = await buildNodePipeline({
      renderer,
      scene,
      camera,
      outputNode,
      shadowLight,
      clouds,
      lutNode: atmosphereContext.lutNode,
    })
    const pipeline = built.pipeline
    const compileSceneMs = built.compileSceneMs
    const compileCloudsMs = built.compileCloudsMs
    const pipelineLutMs = built.lutMs
    const pipelineBuildMs = built.totalMs

    // LUT ができたので、ライティングの差をここで焼く
    const lightBefore = await bakeLight()
    const lightAfter = await bakeLight(atmosphereIlluminance)

    // **照度そのものを数で見る。**同じ点で法線だけを太陽へ向けたものと
    // 背けたものを焼く。直達には `max(N・L, 0)` が入っているので、
    // 背けた側はちょうど 0 になるはず
    const illumSide = 8
    const illumWorld = tsl.vec3(
      lightRegion.origin.x + lightRegion.span * 0.5,
      0,
      lightRegion.origin.z + lightRegion.span * 0.5,
    )
    const illumFragment = (indirectMode: boolean) =>
      tsl.Fn(() => {
        const sun = surfaceState.inputs.sunDirectionWorld
        const facing = tsl.uv().x.lessThan(0.5)
        const normal = facing.select(sun, sun.negate())
        const light = atmosphereIlluminance(illumWorld, normal)
        return tsl.vec4(indirectMode ? light.indirect : light.direct, 1)
      })() as import('three/webgpu').Node<'vec4'>

    const bakeIllum = async (indirectMode: boolean): Promise<number[]> => {
      const target = volume.bakePlane(
        renderer,
        lightQuad,
        illumSide,
        illumSide,
        illumFragment(indirectMode),
        { float: true },
      )
      const bytes = await volume.readPlane(
        renderer,
        target,
        illumSide,
        illumSide,
        isWebGPU,
      )
      target.dispose()
      return bytes
    }

    const directBytes = await bakeIllum(false)
    const indirectBytes = await bakeIllum(true)
    lightQuad.dispose()

    /** 左半分（太陽へ向けた面）と右半分（背けた面）の平均を 3 成分で出す */
    const illumMean = (
      bytes: number[],
      facing: boolean,
    ): [number, number, number] => {
      const sum = [0, 0, 0]
      let n = 0
      for (let row = 0; row < illumSide; row++) {
        for (let col = 0; col < illumSide; col++) {
          if (col < illumSide / 2 !== facing) continue
          for (let c = 0; c < 3; c++) {
            sum[c]! += bytes[(row * illumSide + col) * 4 + c] ?? 0
          }
          n++
        }
      }
      return n > 0
        ? [sum[0]! / n, sum[1]! / n, sum[2]! / n]
        : [Number.NaN, Number.NaN, Number.NaN]
    }

    const pipelineTarget = new webgpu.RenderTarget(options.width, options.height)
    /**
     * 1 枚描いて排出する。
     *
     * **排出は 1 画素で足りる。**全画面を読み戻すと 92 万画素の転送が
     * フレーム時間に乗る（`bench.ts` と同じ作法で最小値を代表にする）
     */
    const drawOnce = async (): Promise<{
      frameCalls: number
      drawCalls: number
    }> => {
      renderer.info.reset()
      clouds!.renderShadow(renderer)
      renderer.setRenderTarget(pipelineTarget)
      pipeline.render()
      const frameCalls = renderer.info.render.frameCalls
      const drawCalls = renderer.info.render.drawCalls
      await renderer.readRenderTargetPixelsAsync(pipelineTarget, 0, 0, 1, 1)
      renderer.setRenderTarget(null)
      return { frameCalls, drawCalls }
    }

    // **暖機を 1 枚入れる。**`compileAsync` は場面の物しか組まない。
    // 鎖の全画面クアッドは場面に入っていないので、実描画が要る（段 19）。
    //
    // 私物の `_quadMesh` へ手を伸ばして組む道も測った。描き先・トーン
    // マッピング・出力の色空間まで揃えても 1 枚目の差が 1,578 ms 残った
    // ので採らない。**支えられていない口に頼っても覆い切れない。**
    const warmupStarted = performance.now()
    await drawOnce()
    const warmupMs = performance.now() - warmupStarted

    // 1 枚目と 2 枚目を分けて測る。暖機のあとなら差は出ないはず
    const firstPipelineStarted = performance.now()
    await drawOnce()
    const firstPipelineMs = performance.now() - firstPipelineStarted

    const secondStarted = performance.now()
    await drawOnce()
    const secondFrameMs = performance.now() - secondStarted

    let steadyMs = Infinity
    let last = { frameCalls: 0, drawCalls: 0 }
    for (let i = 0; i < 3; i++) {
      const started = performance.now()
      last = await drawOnce()
      steadyMs = Math.min(steadyMs, performance.now() - started)
    }

    // 絵は最後に 1 度だけ読み戻す
    const readPicture = async (): Promise<number[]> => {
      renderer.setRenderTarget(pipelineTarget)
      clouds!.renderShadow(renderer)
      renderer.info.reset()
      pipeline.render()
      const frameCalls = renderer.info.render.frameCalls
      const bytes = await volume.readPlane(
        renderer,
        pipelineTarget as unknown as Parameters<typeof volume.readPlane>[1],
        options.width,
        options.height,
        isWebGPU,
      )
      renderer.setRenderTarget(null)
      lastPictureFrameCalls = frameCalls
      return bytes
    }
    let lastPictureFrameCalls = 0

    const pipelineBytes = await readPicture()
    const smaaFrameCalls = lastPictureFrameCalls

    // **ライティングの置き換えでどれだけ動くか。**段 20 の差分の台帳へ
    // 入れる数。地表は画面の大半を覆うので区画平均でも見える
    const litMaterial = nodeTerrainMesh.mesh.material
    nodeTerrainMesh.mesh.material = legacyTerrainMaterial.material
    const legacyBytes = await readPicture()
    nodeTerrainMesh.mesh.material = litMaterial

    // **影が絵に出ているかを数で見る。**投げ手を切って撮り直す。
    // 段 15 と同じ形で、区画平均では見えないのでバイトの違いを数える
    let shadowChanged = 0
    let shadowChangedMax = 0
    let shadowFrameCalls = 0
    let noShadowFrameCalls = 0
    if (shadowLight !== null) {
      // **投げ手の側で切る。**光の `castShadow` は触らない（立てると
      // 光の系が影のノードをもう 1 つ作って落ちる）。段 15 も
      // 「投げ手あり」と「投げ手なし」の差で数えている
      const withShadow = await readPicture()
      shadowFrameCalls = lastPictureFrameCalls
      shadowCaster.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = false
      })
      shadowLight.shadow.needsUpdate = true
      const noShadowBytes = await readPicture()
      noShadowFrameCalls = lastPictureFrameCalls
      shadowCaster.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true
      })
      shadowLight.shadow.needsUpdate = true
      const diff = byteDifference(withShadow, noShadowBytes)
      shadowChanged = diff.differing
      shadowChangedMax = diff.max
    }

    // **SMAA が効いているかは数で見る。**鎖に入れただけでは、辺を拾って
    // いるかどうかは分からない。外して撮り直し、パスの数と絵の両方が
    // 動くことを確かめる
    pipeline.outputNode = composite
    pipeline.needsUpdate = true
    const plainBytes = await readPicture()
    const plainFrameCalls = lastPictureFrameCalls
    pipeline.outputNode = outputNode
    pipeline.needsUpdate = true

    // **プリセットを当て直しても同じ材質が出ること。**`useDetail` は生成時に
    // 畳まれるので、切り替えには材質の組み直しが要る。
    //
    // **1 枚の絵では確かめられない。**足し込みの状態を揃えても 328 バイト
    // ずれる。ずらし（Halton）がフレームごとに動くので、同じ材質でも 2 枚は
    // 一致しない。**組み直しが忠実かどうかは生成された本文で見る**
    // **同じ本文が出るだけでは足りない。**組み直しが何もしていなくても
    // 一致する。違うプリセットを当てて本文が変わることも見る
    const marchSourceBefore = await clouds.marchShaderSource(renderer)
    const { getQuality } = await import('../quality')
    const other = getQuality(options.quality.cloudDetail ? 'low' : 'high')
    clouds.setQuality(other)
    const marchSourceOther = await clouds.marchShaderSource(renderer)
    clouds.setQuality(options.quality)
    const marchSourceAfter = await clouds.marchShaderSource(renderer)

    pipelineResult = {
      frameCalls: last.frameCalls,
      drawCalls: last.drawCalls,
      buildMs: pipelineBuildMs,
      compileSceneMs,
      compileCloudsMs,
      warmupMs,
      // **起動の総和。**節ごとに測った値を足す。合格条件は 15 秒以内で、
      // 超えるなら `atmosphereLutScale` を下げる（計画の段 17）
      startupMs:
        initMs + volumeMs + pipelineBuildMs + compileCloudsMs + warmupMs,
      lutMs: pipelineLutMs,
      firstFrameMs: firstPipelineMs,
      secondFrameMs,
      steadyMs,
      cloudFrameCallsAtRun: clouds.frameCallsAtRun,
      cloudDrawCallsAtRun: clouds.drawCallsAtRun,
      cloudRenderCount: clouds.renderCount,
      tiles: tileMeans(
        new Uint8Array(pipelineBytes),
        options.width,
        options.height,
      ),
      smaaFrameCalls,
      plainFrameCalls,
      // SMAA を外すと辺の画素が変わる。0 なら鎖に入っていない
      lightingChanged: byteDifference(pipelineBytes, legacyBytes).differing,
      lightingChangedMax: byteDifference(pipelineBytes, legacyBytes).max,
      lightingTiles: tileMeans(
        new Uint8Array(legacyBytes),
        options.width,
        options.height,
      ),
      shadowChanged,
      shadowChangedMax,
      shadowFrameCalls,
      noShadowFrameCalls,
      lightingProbeChanged: byteDifference(lightBefore, lightAfter).differing,
      lightingProbeMax: byteDifference(lightBefore, lightAfter).max,
      lightingProbeTilesBefore: tileMeans(
        new Uint8Array(lightBefore),
        lightSide,
        lightSide,
      ),
      lightingProbeTilesAfter: tileMeans(
        new Uint8Array(lightAfter),
        lightSide,
        lightSide,
      ),
      directFacingSun: illumMean(directBytes, true),
      directAwayFromSun: illumMean(directBytes, false),
      indirectFacingSun: illumMean(indirectBytes, true),
      terrainPatches: nodeTerrainMesh.patchCount,
      terrainTriangles: nodeTerrainMesh.triangleCount,
      smaaChanged: byteDifference(pipelineBytes, plainBytes).differing,
      smaaChangedMax: byteDifference(pipelineBytes, plainBytes).max,
      marchSourceLength: marchSourceBefore.length,
      requiltSameSource: marchSourceBefore === marchSourceAfter,
      requiltOtherDiffers: marchSourceBefore !== marchSourceOther,
    }

    pipelineTarget.dispose()
    pipeline.dispose()
    clouds.dispose()
    // **この先の素の `render()` に露出を持ち越さない。**鎖の外の測りが
    // 変わると、同じ結果の中で条件の違うものが並ぶ
    renderer.toneMapping = THREE.NoToneMapping
  }

  // **`renderAsync()` は使わない。**r183 で非推奨になっていて、
  // 「`render()` を使い、レンダラを作るときに `await renderer.init()` を
  // すること」と警告が出る。`init()` は済ませてあるので `render()` でよい。
  // `info` の集計は `render()` の中で同期に進むので、直後に読める
  // **順序を外せない。**`compileAsync` が `AtmosphereLUTNode.setup()` を
  // 走らせ、そこで `textures` ができる。その前に `updateTextures()` を呼ぶと
  // `invariant(this.textures != null)` で落ちる（`webgpu.js:1530`）
  const buildStarted = performance.now()
  await renderer.compileAsync(scene, camera)
  const buildMs = performance.now() - buildStarted

  // **暗黙の起動に任せない。**`updateBefore` から呼ばれる経路は
  // `requestIdleCallback` で 4 分割される（`shared2.js:29`）。何枚目で
  // 完成するかが機械の負荷で変わるので、キャプチャの決定論が壊れる。
  // ここで待ち切る
  let lutMs = 0
  if (atmosphereContext !== null) {
    const lutStarted = performance.now()
    await atmosphereContext.lutNode.updateTextures(renderer)
    lutMs = performance.now() - lutStarted
  }

  const firstStarted = performance.now()
  renderer.render(scene, camera)
  const firstFrameMs = performance.now() - firstStarted

  // **1 枚目は捨てる。**シェーダの生成とテクスチャの常駐化が乗る。
  //
  // **排出まで含めて測る。**`render()` は投入で戻るので、そのまま測ると
  // 投入時間しか出ない（`bench.ts` が記録している罠。実測で 0.7 ms が出た）。
  // node 経路に `gl.finish()` は無いので、レンダーターゲットへ描いて
  // 1 画素読み戻す。代表値は最小値で、これも `bench.ts` と同じ作法
  const target = new webgpu.RenderTarget(options.width, options.height)
  const frames = options.frames ?? 8
  let renderMs = Infinity

  // **段 18。**GPU 時間は `resolveTimestampsAsync()` で取る。拡張は無い
  const { createNodeTimer } = await import('./nodeTimer')
  const nodeTimer = createNodeTimer(renderer)
  const gpuSamples: number[] = []

  for (let i = 0; i < frames; i++) {
    const started = performance.now()
    nodeTimer.begin(i)
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    nodeTimer.end()
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)
    renderMs = Math.min(renderMs, performance.now() - started)
    // **次の枚へ進む前に決着させる。**解決の器は 1 つしかないので、
    // 重ねると前の値が返る（`nodeTimer.ts` の注記）。待ちは `renderMs` の
    // 外側なので、測った時間には入らない
    for (let w = 0; w < 120 && nodeTimer.inflight > 0; w++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    for (const result of nodeTimer.collect()) gpuSamples.push(result.ms)
  }
  // 残りを拾う。解決は非同期なので最後の数枚は後から届く
  for (let i = 0; i < 30 && nodeTimer.inflight > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 4))
    for (const result of nodeTimer.collect()) gpuSamples.push(result.ms)
  }
  for (const result of nodeTimer.collect()) gpuSamples.push(result.ms)
  const timestampDropped = nodeTimer.dropped
  nodeTimer.dispose()

  renderer.setRenderTarget(null)
  target.dispose()

  // **`info` は自分で 0 に戻す。**node 経路は `setAnimationLoop` を使った
  // ときだけ `Animation.js:75` が `info.reset()` を呼ぶ。自分で `render()` を
  // 回すと `autoReset` が true のままでも積算され続ける。`WebGLRenderer` は
  // `render()` の中で戻すので、ここが振る舞いの違いになる
  renderer.info.reset()
  renderer.render(scene, camera)

  return {
    requested: options.gpu,
    noiseSlice,
    weatherSlice,
    hashProbe,
    shadowHistogram: shadowBins,
    shadowTiles,
    march,
    heightProbe,
    sprite,
    tone,
    overlay,
    overlaySource,
    pipeline: pipelineResult,
    // **`undefined` しか返らないなら測れていない。**件数がそのまま判定になる
    timestampSamples: gpuSamples.length,
    timestampDropped,
    gpuFrameMs: gpuSamples.length > 0 ? Math.min(...gpuSamples) : null,
    surface,
    nodeShadow,
    volumeMs,
    backend: isWebGPU ? 'node-webgpu' : 'node-webgl',
    fellBack: options.gpu === 2 && !isWebGPU,
    sharedCore,
    meshes,
    shaderMaterials,
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.memory.programs,
    atmosphere: atmosphereContext !== null,
    lutMs,
    lutScale: options.quality.atmosphereLutScale,
    buildMs,
    sunElevationDeg,
    initMs,
    firstFrameMs,
    renderMs,
    frames,
  }
}
