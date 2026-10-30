import * as THREE from 'three'
import { loadAircraftModel } from '../aircraft/model'
import { byteDifference, NOISE_FLOOR, tileMeans } from '../pixelCompare'
import { loadCarrier, placeCarrier, DECK_HEIGHT } from '../carrier'
import { DEFAULT_COVERAGE, DEFAULT_EXPOSURE, type NodeProbeResult } from './types'
import { shadowMapType } from './nodeShadow'
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
   * 自前の空（Hillaire）の LUT と天空光を焼いて出すか。`?skyprobe=1`（段 S2a）。
   *
   * 固定の入力は `sky/skyProbe.ts` が唯一の定義で、CPU 参照（`sky/reference.ts`）と比べる
   */
  skyProbe?: boolean
  /**
   * FFT の海を GPU で解いて CPU 参照と比べるか。`?oceanprobe=1`（段 S3）。
   * 固定の入力と比べ方は `ocean/oceanProbe.ts` が唯一の定義。WebGPU のときだけ走る
   */
  oceanProbe?: boolean
  /**
   * 影を node 経路で立てて測るか。`?nodeshadow=1`。
   *
   * `shadow(light)` の経路が立つか、プリセットのフィルタが渡るか、影マップが
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
   * ポストの鎖を `RenderPipeline` で組むか。`?nodepipeline=1`。
   *
   * `pass(scene, camera)` → 雲の合成 → `smaa` → `renderOutput`。
   * **WebGPU バックエンドでだけ組む。**大気が要るため
   */
  nodePipeline: boolean
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

  // 焼いて読み戻す道具。段 S4b まではここで体積の雲のノイズ・雲影・マーチも焼いていた
  const tsl = await import('three/tsl')
  const volume = await import('./bake')
  const quad = volume.createBakeQuad()

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

  // ---- 自前の空（段 S2a）----
  //
  // 透過率・多重散乱・空の見え方の LUT と、地表の天空光を 1 点焼いて読み戻す。
  // 相手は CPU 参照（`sky/reference.ts`）。LUT は相対 1e-3、天空光は正解との関門
  // （`tests/render/skyTruth.test.ts` と同じ）を node-path.spec が見る
  let sky: NodeProbeResult['sky'] = null
  if (options.skyProbe === true) {
    const skyNodes = await import('../sky/skyNodes')
    const skyProbe = await import('../sky/skyProbe')
    const reference = await import('../sky/reference')
    const transmittanceTarget = volume.bakePlane(
      renderer,
      quad,
      reference.TRANSMITTANCE_WIDTH,
      reference.TRANSMITTANCE_HEIGHT,
      skyNodes.transmittanceFragmentNode(),
      { float: true },
    )
    const multiscatterTarget = volume.bakePlane(
      renderer,
      quad,
      reference.MULTISCATTER_SIZE,
      reference.MULTISCATTER_SIZE,
      skyNodes.multiscatterFragmentNode(transmittanceTarget.texture),
      { float: true },
    )
    const sunMu = tsl.float(skyProbe.SKY_PROBE_SUN_MU) as never
    const skyViewTarget = volume.bakePlane(
      renderer,
      quad,
      reference.SKY_VIEW_WIDTH,
      reference.SKY_VIEW_HEIGHT,
      skyNodes.skyViewFragmentNode(
        transmittanceTarget.texture,
        multiscatterTarget.texture,
        tsl.float(0) as never,
        sunMu,
      ),
      { float: true },
    )
    const irradianceTarget = volume.bakePlane(
      renderer,
      quad,
      1,
      1,
      tsl.vec4(
        skyNodes.skyIrradianceOverPiNode(
          transmittanceTarget.texture,
          multiscatterTarget.texture,
          sunMu,
          skyProbe.SKY_PROBE_ZENITH_STEPS,
          skyProbe.SKY_PROBE_AZIMUTH_STEPS,
        ),
        1,
      ) as never,
      { float: true },
    )
    sky = {
      transmittance: await volume.readPlane(
        renderer,
        transmittanceTarget,
        reference.TRANSMITTANCE_WIDTH,
        reference.TRANSMITTANCE_HEIGHT,
        isWebGPU,
      ),
      multiscatter: await volume.readPlane(
        renderer,
        multiscatterTarget,
        reference.MULTISCATTER_SIZE,
        reference.MULTISCATTER_SIZE,
        isWebGPU,
      ),
      skyView: await volume.readPlane(
        renderer,
        skyViewTarget,
        reference.SKY_VIEW_WIDTH,
        reference.SKY_VIEW_HEIGHT,
        isWebGPU,
      ),
      irradianceOverPi: (await volume.readPlane(renderer, irradianceTarget, 1, 1, isWebGPU)).slice(0, 3),
      ...(await probeSkyS2b(transmittanceTarget.texture, multiscatterTarget.texture)),
    }
    transmittanceTarget.dispose()
    multiscatterTarget.dispose()
    skyViewTarget.dispose()
    irradianceTarget.dispose()
  }

  /**
   * 段 S2b の自己診断。同梱の照度の表を GPU で引いた格子と、固定のカメラで焼いた霞の
   * アトラス（入る光と透過率）を読み戻す。固定の入力は `sky/skyProbe.ts`
   */
  async function probeSkyS2b(transmittance: THREE.Texture, multiscatter: THREE.Texture) {
    const skyNodes = await import('../sky/skyNodes')
    const skyProbe = await import('../sky/skyProbe')
    const { createIrradianceTexture } = await import('../sky/hillaireSky')

    const table = createIrradianceTexture()
    const grid = tsl.Fn(() => {
      const p = skyNodes.bakeUv()
      const x = tsl.floor(p.x.mul(skyProbe.IRRADIANCE_PROBE_WIDTH))
      const y = tsl.floor(p.y.mul(skyProbe.IRRADIANCE_PROBE_HEIGHT))
      // `irradianceProbePoint` と同じ式
      const f = y.div(skyProbe.IRRADIANCE_PROBE_HEIGHT - 1)
      const sunMu = x.mul(1.33 / (skyProbe.IRRADIANCE_PROBE_WIDTH - 1)).add(-0.35)
      const altitude = f.mul(f).mul(50)
      return tsl.vec4(skyNodes.sampleIrradianceNode(table, sunMu as never, altitude as never), 1)
    })()
    const gridTarget = volume.bakePlane(
      renderer,
      quad,
      skyProbe.IRRADIANCE_PROBE_WIDTH,
      skyProbe.IRRADIANCE_PROBE_HEIGHT,
      grid as never,
      { float: true },
    )
    const irradianceGrid = await volume.readPlane(
      renderer,
      gridTarget,
      skyProbe.IRRADIANCE_PROBE_WIDTH,
      skyProbe.IRRADIANCE_PROBE_HEIGHT,
      isWebGPU,
    )
    gridTarget.dispose()
    table.dispose()

    const c = skyProbe.AERIAL_PROBE_CAMERA
    const camera = new THREE.PerspectiveCamera(c.fov, c.aspect, c.near, c.far)
    // 場面と同じく WebGPU の座標系の射影にする（three が描くときに切り替える値）
    camera.coordinateSystem = renderer.coordinateSystem
    camera.position.set(c.position[0], c.position[1], c.position[2])
    camera.lookAt(
      c.position[0] + c.forward[0],
      c.position[1] + c.forward[1],
      c.position[2] + c.forward[2],
    )
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    const inputs = {
      altitude: tsl.float(c.position[1] / 1000) as never,
      sunDir: tsl.vec3(...skyProbe.AERIAL_PROBE_SUN) as never,
      projectionInverse: tsl.uniform(camera.projectionMatrixInverse.clone()) as never,
      cameraWorld: tsl.uniform(camera.matrixWorld.clone()) as never,
    }
    const atlas = async (part: 'inscatter' | 'transmittance') => {
      const target = volume.bakePlane(
        renderer,
        quad,
        skyNodes.AERIAL_ATLAS_WIDTH,
        skyNodes.AERIAL_ATLAS_HEIGHT,
        skyNodes.aerialFragmentNode(transmittance, multiscatter, inputs, part),
        { float: true },
      )
      const values = await volume.readPlane(
        renderer,
        target,
        skyNodes.AERIAL_ATLAS_WIDTH,
        skyNodes.AERIAL_ATLAS_HEIGHT,
        isWebGPU,
      )
      target.dispose()
      return values
    }
    return {
      irradianceGrid,
      aerialInscatter: await atlas('inscatter'),
      aerialTransmittance: await atlas('transmittance'),
      aerialCamera: {
        projectionInverse: camera.projectionMatrixInverse.toArray(),
        cameraWorld: camera.matrixWorld.toArray(),
      },
    }
  }

  // ---- FFT の海（段 S3）----
  //
  // 全カスケード 256² を GPU で解き、読み戻してページの中で CPU 参照と比べる。返すのは
  // 差の要約だけ（`ocean/oceanProbe.ts` の注記）。共有メモリを使うので WebGPU のときだけ
  let ocean: NodeProbeResult['ocean'] = null
  if (options.oceanProbe === true && isWebGPU) {
    const oceanNodes = await import('../ocean/oceanNodes')
    const oceanProbe = await import('../ocean/oceanProbe')
    const { WEB_OCEAN_DEFAULTS } = await import('../ocean/reference')
    const sim = oceanNodes.createOceanSimulation(WEB_OCEAN_DEFAULTS)
    sim.init(renderer)
    sim.update(renderer, oceanProbe.OCEAN_PROBE_TICKS, oceanProbe.OCEAN_PROBE_ALPHA)
    const read = async (node: { value: unknown }, int = false) => {
      const buffer = await renderer.getArrayBufferAsync(node.value as never)
      return int ? new Uint32Array(buffer) : new Float32Array(buffer)
    }
    const gpu = {
      h0: await read(sim.h0),
      frequencyIndex: await read(sim.frequencyIndex, true),
      specA: await read(sim.specA),
      specB: await read(sim.specB),
      displacement: await read(sim.displacement),
      derivatives: await read(sim.derivatives),
    }
    const compareStarted = performance.now()
    const summary = oceanProbe.compareOcean(
      gpu,
      WEB_OCEAN_DEFAULTS,
      oceanProbe.OCEAN_PROBE_TICKS,
      oceanProbe.OCEAN_PROBE_ALPHA,
    )
    sim.dispose()

    // 1 フレームの所要（時間発展と逆 FFT）。カスケード数と格子の大きさを振る。GPU の仕事が
    // 終わるまで待って壁時計で測る（SwiftShader では CPU の時間がそのまま出る）
    const device = (renderer.backend as unknown as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device
    const cost: { cascades: number; size: number; updateMs: number; initMs: number }[] = []
    for (const [cascades, size] of [[6, 256], [4, 256], [4, 128], [3, 128]] as const) {
      const params = { ...WEB_OCEAN_DEFAULTS, cascades: WEB_OCEAN_DEFAULTS.cascades.slice(0, cascades), size }
      const variant = oceanNodes.createOceanSimulation(params)
      const initStarted = performance.now()
      variant.init(renderer)
      variant.update(renderer, 0, 0)
      await device.queue.onSubmittedWorkDone()
      const initMs = performance.now() - initStarted
      const samples: number[] = []
      for (let i = 1; i <= 3; i++) {
        const started = performance.now()
        variant.update(renderer, i * 2, 0)
        await device.queue.onSubmittedWorkDone()
        samples.push(performance.now() - started)
      }
      samples.sort((a, b) => a - b)
      cost.push({ cascades, size, updateMs: samples[1]!, initMs })
      variant.dispose()
    }

    // 海面のテクスチャ（段 S4a-1）。high の条件で解き、テクスチャへ写して頂点シェーダと同じ
    // 引き方で引く。比べる相手は CPU 参照の場（周波数の番号は GPU のものを使う。上と同じ理由）
    const surfaceNodes = await import('../ocean/oceanSurface')
    const layout = await import('../ocean/oceanLayout')
    const reference = await import('../ocean/reference')
    const highParams = reference.oceanParamsFor(4, 256)
    const highSim = oceanNodes.createOceanSimulation(highParams)
    highSim.init(renderer)
    highSim.update(renderer, oceanProbe.OCEAN_PROBE_TICKS, oceanProbe.OCEAN_PROBE_ALPHA)
    const highFields = reference.oceanFields(
      reference.buildH0(highParams),
      await read(highSim.frequencyIndex, true),
      oceanProbe.OCEAN_PROBE_TICKS,
      oceanProbe.OCEAN_PROBE_ALPHA,
      highParams,
    )
    type SurfaceSummary = import('../ocean/oceanProbe').OceanSurfaceSummary
    type SurfaceKey = 'far' | 'near' | 'momentsFar' | 'momentsNear'
    const surface = {} as Record<'16' | '32', Record<SurfaceKey, SurfaceSummary>>
    for (const precision of [16, 32] as const) {
      const textures = surfaceNodes.createOceanTextures(highSim, precision)
      textures.update(renderer)
      const sampler = surfaceNodes.createOceanSampler(highParams)
      sampler.setOrigin(...oceanProbe.OCEAN_SURFACE_PROBE_ORIGIN)
      const bySpan = {} as Record<SurfaceKey, SurfaceSummary>
      // 高さ（段 S4a-1）と LEAN のモーメント（段 S4a-2）。モーメントの相手は CPU 参照の傾きの積
      const moments = oceanProbe.oceanMomentField(highFields.derivatives)
      for (const [field, cpu] of [
        ['displacement', highFields.displacement],
        ['moments', moments],
      ] as const) {
        for (const span of ['far', 'near'] as const) {
          const points = oceanProbe.oceanSurfaceProbePoints(oceanProbe.OCEAN_SURFACE_PROBE_SPANS[span])
          const surfaceProbe = surfaceNodes.createOceanSurfaceProbe(sampler, textures, points, field)
          renderer.compute(surfaceProbe.node)
          const values = await read(surfaceProbe.output as unknown as { value: unknown })
          const key: SurfaceKey = field === 'displacement' ? span : span === 'far' ? 'momentsFar' : 'momentsNear'
          bySpan[key] = oceanProbe.compareOceanSurface(
            values,
            points,
            cpu,
            highParams,
            layout.oceanCascadeLod,
            layout.oceanCascadeSkipped,
          )
        }
      }
      surface[precision] = bySpan
      textures.dispose()
    }
    // 空母のまわりの凪と喫水線の泡（段 S4a-3）。GPU の式を CPU の純関数と突き合わせる。艦首を振った
    // 空母のまわりに格子状に点を置く（船体の中・帯の中・帯の外を含む）
    const calmModule = await import('../ocean/oceanCalm')
    const calmNodesModule = await import('../ocean/oceanCalmNodes')
    const tsl = await import('three/tsl')
    const carrierPose = { x: -1_234.5, z: 2_345.25, heading: 0.83 }
    const calmPoints: number[] = []
    for (let i = -20; i <= 20; i++) {
      for (let j = -12; j <= 12; j++) calmPoints.push(carrierPose.x + i * 9.7, carrierPose.z + j * 9.3)
    }
    const calmNodes = calmNodesModule.createCalmNodes(carrierPose)
    const calmInput = tsl.instancedArray(new Float32Array(calmPoints), 'vec2')
    const calmOutput = tsl.instancedArray(calmPoints.length / 2, 'vec2')
    const calmCompute = tsl
      .Fn(() => {
        const k = tsl.uint(tsl.instanceIndex).toVar()
        const p = (calmInput as unknown as { element(i: unknown): { toVar(): unknown } }).element(k).toVar()
        ;(calmOutput as unknown as { element(i: unknown): { assign(v: unknown): void } })
          .element(k)
          .assign(tsl.vec2(calmNodes.calm(p as never), calmNodes.waterline(p as never)))
      })()
      .compute(calmPoints.length / 2, [64])
    renderer.compute(calmCompute as never)
    const calmValues = await read(calmOutput as unknown as { value: unknown })
    let calmError = 0
    let waterlineError = 0
    let calmZero = 0
    let waterlineOn = 0
    for (let k = 0; k < calmPoints.length / 2; k++) {
      const [lx, lz] = calmModule.carrierLocal(calmPoints[k * 2]!, calmPoints[k * 2 + 1]!, carrierPose)
      const d = calmModule.hullDistance(lx, lz)
      calmError = Math.max(calmError, Math.abs(calmValues[k * 2]! - calmModule.carrierCalm(d)))
      waterlineError = Math.max(waterlineError, Math.abs(calmValues[k * 2 + 1]! - calmModule.waterlineFoam(d)))
      if (calmModule.carrierCalm(d) === 0) calmZero++
      if (calmModule.waterlineFoam(d) > 0) waterlineOn++
    }
    const calm = { points: calmPoints.length / 2, calmError, waterlineError, calmZero, waterlineOn }

    // 層の雲（段 S4c）。ノイズ・積雲の縁・高層雲の縁を、GPU（WGSL のまま写した関数）と CPU 参照で
    // 同じ点・同じ条件で求めて比べる。点は数十 km に散らし、画素の大きさ（細かい段を消す量）も振る
    const layerRef = await import('../sky/cloudLayersReference')
    const layerNodes = await import('../sky/cloudLayerNodes')
    const layerPoints: number[] = []
    for (let i = 0; i < 256; i++) {
      const a = (i * 0.7548776662466927) % 1
      const b = (i * 0.5698402909980532) % 1
      layerPoints.push(-30 + a * 60, -30 + b * 60, [0, 0.05, 0.3, 1.5][i % 4]!, 0)
    }
    const LAYER_OCTAVES = 7
    const LAYER_COVERAGE = 0.4
    const LAYER_TIME = 1234.5
    const layerInput = tsl.instancedArray(new Float32Array(layerPoints), 'vec4')
    const layerOutput = tsl.instancedArray(256, 'vec4')
    const layerCompute = tsl
      .Fn(() => {
        const k = tsl.uint(tsl.instanceIndex).toVar()
        const p = (layerInput as unknown as { element(i: unknown): { toVar(): unknown } }).element(k).toVar() as {
          xy: unknown
          z: unknown
        }
        const f = layerNodes.cloudLayerProbeFunctions
        ;(layerOutput as unknown as { element(i: unknown): { assign(v: unknown): void } })
          .element(k)
          .assign(
            tsl.vec4(
              f.gnoise(p.xy as never),
              f.lowEdge(p.xy as never, p.z as never, LAYER_OCTAVES, tsl.float(LAYER_COVERAGE) as never, tsl.float(LAYER_TIME) as never),
              f.highEdge(p.xy as never, p.z as never, LAYER_OCTAVES - 1, tsl.float(layerRef.veilFor(LAYER_COVERAGE)) as never, tsl.float(LAYER_TIME) as never),
              0,
            ),
          )
      })()
      .compute(256, [64])
    renderer.compute(layerCompute as never)
    const layerValues = await read(layerOutput as unknown as { value: unknown })
    const layerError = { gnoise: 0, lowEdge: 0, highEdge: 0 }
    for (let k = 0; k < 256; k++) {
      const [x, y, fp] = [layerPoints[k * 4]!, layerPoints[k * 4 + 1]!, layerPoints[k * 4 + 2]!]
      layerError.gnoise = Math.max(layerError.gnoise, Math.abs(layerValues[k * 4]! - layerRef.gnoise(x, y)))
      layerError.lowEdge = Math.max(
        layerError.lowEdge,
        Math.abs(layerValues[k * 4 + 1]! - layerRef.lowEdge(x, y, fp, LAYER_OCTAVES, LAYER_COVERAGE, LAYER_TIME)),
      )
      layerError.highEdge = Math.max(
        layerError.highEdge,
        Math.abs(
          layerValues[k * 4 + 2]! -
            layerRef.highEdge(x, y, fp, LAYER_OCTAVES - 1, layerRef.veilFor(LAYER_COVERAGE), LAYER_TIME),
        ),
      )
    }

    // 1 回の所要（段 S4a-2）。海と写しとミップ、泡の更新とそのミップを分けて測る。泡はキャプチャで
    // 前から 16 回回すので、ここが撮る時間に効く。GPU の仕事を待った壁時計（3 回の中央値）
    const foamModule = await import('../ocean/oceanFoam')
    const surfaceCost = await (async () => {
      const textures = surfaceNodes.createOceanTextures(highSim, 16)
      const sampler = surfaceNodes.createOceanSampler(highParams)
      // 泡の段と解像度は high と同じ（品質表の `oceanFoamLevels`・`oceanFoamResolution`）
      const high = (await import('../quality')).QUALITY_PRESETS.high
      const foam = foamModule.createOceanFoam(
        sampler,
        textures,
        high.oceanFoamLevels,
        { speed: highParams.windSpeed, direction: highParams.windDirection },
        high.oceanFoamResolution,
      )
      const time = async (run: () => void) => {
        const samples: number[] = []
        for (let i = 0; i < 4; i++) {
          const started = performance.now()
          run()
          await device.queue.onSubmittedWorkDone()
          if (i > 0) samples.push(performance.now() - started)
        }
        samples.sort((a, b) => a - b)
        return samples[1]!
      }
      let t = 0
      const result = {
        simulationMs: await time(() => highSim.update(renderer, (t += 4), 0)),
        texturesMs: await time(() => textures.update(renderer)),
        foamMs: await time(() => foam.update(renderer, 0, 0, 4 / 120, false)),
      }
      // 前から回して泡を作る（`OceanSurface.update` と同じ手順）。2 回回して読み戻し、ビット単位で
      // 比べる（キャプチャの決定論）。泡の量の分布も返す（穏やかな海で泡が出ているか）
      const warm = async () => {
        const steps = surfaceNodes.FOAM_WARMUP_STEPS
        const stride = surfaceNodes.FOAM_WARMUP_STRIDE
        for (let k = steps - 1; k >= 0; k--) {
          highSim.update(renderer, oceanProbe.OCEAN_PROBE_TICKS - k * stride, 0)
          textures.update(renderer)
          foam.update(renderer, 0, 0, (stride * 1) / 120, k === steps - 1)
        }
        return new Float32Array(await renderer.getArrayBufferAsync(foam.state.value as never))
      }
      const a = await warm()
      const b = await warm()
      let differing = 0
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++
      let covered = 0
      let fresh = 0
      let maxFoam = 0
      let minJ = Infinity
      const texels = a.length / 4
      for (let i = 0; i < texels; i++) {
        if (a[i * 4]! > 0.05) covered++
        if (a[i * 4 + 1]! > 0.05) fresh++
        maxFoam = Math.max(maxFoam, a[i * 4]!)
        minJ = Math.min(minJ, a[i * 4 + 2]!)
      }
      foam.dispose()
      textures.dispose()
      return {
        ...result,
        foam: { texels, differing, covered: covered / texels, fresh: fresh / texels, maxFoam, minJ },
      }
    })()
    highSim.dispose()

    ocean = {
      ...summary,
      lengths: Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, v.length])),
      compareMs: performance.now() - compareStarted,
      cost,
      surface,
      surfaceCost,
      calm,
      cloudLayers: layerError,
      float32Filterable: renderer.hasFeature('float32-filterable'),
    }
  }

  quad.dispose()

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

  // ---- 空・霞・光（段 S2b-2 で takram から置き換えた。ADR 0045）----
  //
  // **WebGPU バックエンドのときだけ組む。**本番の場面（`nodeScene.ts`）は WebGPU を
  // 必須にしている。WebGL2 の `?gpu=1` は、ここより前の TSL と CPU 参照の突き合わせ
  // だけに使う
  let sceneSky: import('../sky/hillaireSky').HillaireSky | null = null
  let sunElevationDeg = 0
  const sunDirectionWorld = new THREE.Vector3(0, 1, 0)
  /** 空の LUT（透過率と多重散乱）を焼くのにかかったミリ秒 */
  let lutMs = 0

  if (isWebGPU) {
    // 時刻から向きを出すのは `geoFrame.ts` の 1 か所だけ。本番の場面と同じものを通す
    const { sunFrameForHour } = await import('../geoFrame')
    const solar = sunFrameForHour(options.hour)
    sunElevationDeg = solar.sunElevationDeg
    sunDirectionWorld.set(solar.sunDirectionWorld.x, solar.sunDirectionWorld.y, solar.sunDirectionWorld.z)

    // **組み方を知っているのは `sky/hillaireSky.ts` だけ。**本番の場面と同じ関数へ通す
    const { createHillaireSky } = await import('../sky/hillaireSky')
    const lutStarted = performance.now()
    sceneSky = createHillaireSky(renderer)
    lutMs = performance.now() - lutStarted
    sceneSky.setSun(sunDirectionWorld)
    const sceneNodes = scene as unknown as { backgroundNode: unknown; environmentNode: unknown }
    sceneNodes.backgroundNode = sceneSky.backgroundNode
    sceneNodes.environmentNode = options.quality.skyEnvironment ? sceneSky.environmentNode : null
    scene.add(sceneSky.sunLight, sceneSky.sunLight.target, sceneSky.skyLight)
    // 空の見え方と霞の LUT と機体の光を、このカメラで 1 度焼く。鎖で描くときは
    // 1 枚ごとに焼き直す（`drawOnce`）
    sceneSky.update(renderer, camera, sunDirectionWorld, new THREE.Vector3(0, DECK_HEIGHT, 0))
  } else {
    // 空を組まないときの光。glb の材質が描けることだけを見る
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

    // プリセットの列をそのまま使う。変換の正本は `nodeShadow.ts`
    renderer.shadowMap.type = shadowMapType(options.quality)
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
      changed: byteDifference(without.bytes, withShadow.bytes, NOISE_FLOOR).differing,
      changedMax: byteDifference(without.bytes, withShadow.bytes).max,
    }
  }

  // ---- ポストの鎖 ----
  //
  // **段 17 の後半。**`RenderPipeline` + `pass(scene, camera)` + 雲の合成 +
  // `smaa` + `renderOutput`。段 S4b で雲を層の雲に、地形と板の海を FFT の海面に替えた。ここで初めて node 経路がポスト付きの絵を出す。
  //
  // 露出とトーンマッピングはレンダラの値から入る。`RenderPipeline._update`
  // が `renderOutput(outputNode, renderer.toneMapping, ...)` を足し、
  // `ToneMappingNode` の露出は `rendererReference('toneMappingExposure')` な
  // ので、**GLSL 経路と同じ「レンダラに 6 を置く」形になる。**
  let pipelineResult: NodeProbeResult['pipeline'] = null
  if (options.nodePipeline && isWebGPU && sceneSky !== null) {
    const pipelineSky = sceneSky
    // SMAA は `three/tsl` ではなく addons 側にある。面積テクスチャと探索
    // テクスチャを data URI で内包する
    const { smaa } = await import('three/examples/jsm/tsl/display/SMAANode.js')

    // **照度の式を知っているのは `sky/hillaireSky.ts` だけ。**本番の場面と同じものを通す
    const atmosphereNodes = pipelineSky.lighting
    const atmosphereIlluminance = atmosphereNodes.illuminance
    const scalarIlluminance = atmosphereNodes.scalarIlluminance

    // **`pass.getTextureNode()` を自前の材質へ渡してはいけない**（その材質を
    // 焼くたびに場面がもう 1 度描かれる）。組み方を知っているのは `nodeOutput.ts` だけ（段 20a-2-3）
    const nodeOutput = await import('./nodeOutput')
    const { scenePass } = nodeOutput.createScenePass(scene, camera)

    // ---- 層の雲（段 S4b で体積の雲から替えた。ADR 0050）----
    //
    // 本番の場面と同じ部品を同じ焼き方（`cloudLayerTexture`）で通す。雲量は既定、時刻は 0
    const cloudLayerNodes = await import('../sky/cloudLayerNodes')
    const cloudLayers = cloudLayerNodes.createCloudLayers({
      view: pipelineSky.view,
      skyRadiance: (dir, spread) => pipelineSky.radiance(dir, spread),
      sunIlluminance: (world) => scalarIlluminance(world).get('direct'),
      octaves: options.quality.cloudLayerOctaves,
    })
    const cloudTexture = cloudLayerNodes.cloudLayerTexture(
      cloudLayers,
      (scenePass.getTextureNode('depth') as unknown as { x: import('three/webgpu').Node<'float'> }).x,
      options.quality.cloudLayerResolutionScale,
    )
    // **焼いた時点の描画呼び出しを数える。**雲は場面の深度を読むので、場面のパスより
    // 先に焼くと 1 フレーム前の深度で打ち切る。絵には出ないので数で見る
    let cloudDrawCallsAtRun = -1
    const cloudRtt = cloudTexture as unknown as { updateBefore(frame: unknown): unknown }
    const bakeClouds = cloudRtt.updateBefore.bind(cloudRtt)
    cloudRtt.updateBefore = (frame) => {
      cloudDrawCallsAtRun = renderer.info.render.drawCalls
      return bakeClouds(frame)
    }

    // ---- 機体の影 ----
    //
    // 影の箱を向けるには、ワールド座標の太陽の向きから位置を入れる
    // （`docs/decisions/0010-webgpu-tsl.md` の段 15 の続き）。
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
    // `shadowMap` が null のまま触られて落ちる（実測。takram の
    // `AtmosphereLight` でも明るさ 0 の指向光でも同じ）。
    //
    // 影は `shadow(light)` を明示的に呼んで自分で持つ。`ShadowNode` は
    // `light.castShadow` を見ないので、これで影マップは焼かれる
    const shadowLight: THREE.DirectionalLight | null = pipelineSky.sunLight
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
      renderer.shadowMap.type = shadowMapType(options.quality)
      aircraftShade = tsl.shadow(
        shadowLight,
      ) as unknown as import('three/webgpu').Node<'float'>
    }

    // ---- 海面を場面へ入れる（段 S4b で地形と板の海から替えた）----
    //
    // 本番の場面（`nodeScene.ts` の `createOceanSurfaceFor`）と同じ光を渡す。太陽の遮りは
    // 層の雲 × 機体の影。空母は場面と同じく原点に置く
    const { createOceanSurface } = await import('../ocean/oceanSurface')
    const surfaceSun = tsl.uniform(sunDirectionWorld.clone())
    const surfaceCamera = tsl.uniform(new THREE.Vector3())
    const ocean = createOceanSurface(renderer, {
      quality: options.quality,
      precision: 16,
      carrier: { x: 0, z: 0, heading: 0 },
      lighting: {
        skyRadiance: (dir) => pipelineSky.radiance(dir),
        sunIlluminance: (world) => scalarIlluminance(world).get('direct'),
        skyIlluminance: (world) => scalarIlluminance(world).get('indirect'),
        sunDirection: surfaceSun as unknown as import('three/webgpu').Node<'vec3'>,
        sunShade: (world) =>
          cloudLayers.sunTransmittance(world).mul(aircraftShade) as unknown as import('three/webgpu').Node<'float'>,
        camera: surfaceCamera as unknown as import('three/webgpu').Node<'vec3'>,
      },
    })
    scene.add(ocean.mesh, ocean.plate)

    const cameraWorld = camera.getWorldPosition(new THREE.Vector3())
    ;(surfaceCamera.value as THREE.Vector3).copy(cameraWorld)
    const pixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / options.height
    /** 描く前に雲・海・空を入れる。本番の場面の `renderPlainImpl` と同じ並び */
    const prepareFrame = () => {
      cloudLayers.update(DEFAULT_COVERAGE, 0, cameraWorld, pixelAngle)
      pipelineSky.update(renderer, camera, sunDirectionWorld, casterCenter)
      ocean.update(renderer, cameraWorld, 0)
    }

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
      aerial: pipelineSky.aerial,
      smaa: smaa as unknown as (node: import('three/webgpu').Node) => import('three/webgpu').Node,
      scenePass,
      cloudNode: cloudTexture,
      quality: options.quality,
    })

    // **順序を知っているのは `nodeBuild.ts` だけ。**`setMRT()` と
    // `getTextureNode()` を先に済ませること、`castShadow` を組み立ての
    // あとで立てること。どちらも破っても例外が出ない。**写しを 2 つ作ると片方だけ
    // 直したときに気づけない**ので、本番の場面と同じ関数へ通す（段 20a-2-3）
    const nodeBuild = await import('./nodeBuild')
    prepareFrame()
    const built = await nodeBuild.buildNodePipeline({
      renderer,
      scene,
      camera,
      outputNode,
      shadowLight,
    })
    const pipeline = built.pipeline
    const compileSceneMs = built.compileSceneMs
    const pipelineLutMs = lutMs
    const pipelineBuildMs = built.totalMs

    // **照度そのものを数で見る。**同じ点で法線だけを太陽へ向けたものと
    // 背けたものを焼く。直達には `max(N・L, 0)` が入っているので、
    // 背けた側はちょうど 0 になるはず
    const illumQuad = volume.createBakeQuad()
    const illumSide = 8
    const illumWorld = tsl.vec3(0, 0, 0)
    const illumFragment = (indirectMode: boolean) =>
      tsl.Fn(() => {
        const sun = surfaceSun as unknown as import('three/webgpu').Node<'vec3'>
        const facing = tsl.uv().x.lessThan(0.5)
        const normal = facing.select(sun, sun.negate())
        const light = atmosphereIlluminance(illumWorld, normal)
        return tsl.vec4(indirectMode ? light.indirect : light.direct, 1)
      })() as import('three/webgpu').Node<'vec4'>

    const bakeIllum = async (indirectMode: boolean): Promise<number[]> => {
      const target = volume.bakePlane(
        renderer,
        illumQuad,
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
    illumQuad.dispose()

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
      // **番号を進めないと場面のパスが 1 枚目しか走らない。**
      // 手で `render()` を回すと `Animation.js` の `nodeFrame.update()` が
      // 呼ばれず、`FRAME` 型の更新が重複と見なされて飛ぶ。絵は前の中身が
      // 残るので出続ける（段 20a-2-3 で実測。2 枚目以降が 2 呼び出し）
      nodeBuild.advanceNodeFrame(renderer)
      prepareFrame()
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
    // **組み立ては数で数える。**シェーダのプログラムが新しくできた数
    // （`info.memory.programs`）は、CPU の取り合いに左右されない（段 S2b-2 の追補）
    const programs = () => renderer.info.memory.programs
    const programsBeforeWarmup = programs()
    const warmupStarted = performance.now()
    await drawOnce()
    const warmupMs = performance.now() - warmupStarted
    const programsAfterWarmup = programs()

    // 1 枚目と 2 枚目を分けて測る。暖機のあとなら差は出ないはず
    const firstPipelineStarted = performance.now()
    await drawOnce()
    const firstPipelineMs = performance.now() - firstPipelineStarted
    const programsAfterFirst = programs()

    const secondStarted = performance.now()
    await drawOnce()
    const secondFrameMs = performance.now() - secondStarted
    const programsAfterSecond = programs()

    let steadyMs = Infinity
    let last = { frameCalls: 0, drawCalls: 0 }
    for (let i = 0; i < 3; i++) {
      const started = performance.now()
      last = await drawOnce()
      steadyMs = Math.min(steadyMs, performance.now() - started)
    }

    // 絵は最後に 1 度だけ読み戻す
    const readPicture = async (): Promise<number[]> => {
      nodeBuild.advanceNodeFrame(renderer)
      prepareFrame()
      renderer.setRenderTarget(pipelineTarget)
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
      const diff = byteDifference(withShadow, noShadowBytes, NOISE_FLOOR)
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

    pipelineResult = {
      frameCalls: last.frameCalls,
      drawCalls: last.drawCalls,
      buildMs: pipelineBuildMs,
      compileSceneMs,
      warmupMs,
      // **起動の総和。**節ごとに測った値を足す。合格条件は 15 秒以内（計画の段 17）
      startupMs: initMs + pipelineBuildMs + warmupMs,
      lutMs: pipelineLutMs,
      programsBeforeWarmup,
      programsAfterWarmup,
      programsAfterFirst,
      programsAfterSecond,
      firstFrameMs: firstPipelineMs,
      secondFrameMs,
      steadyMs,
      cloudDrawCallsAtRun,
      tiles: tileMeans(
        new Uint8Array(pipelineBytes),
        options.width,
        options.height,
      ),
      smaaFrameCalls,
      plainFrameCalls,
      shadowChanged,
      shadowChangedMax,
      shadowFrameCalls,
      noShadowFrameCalls,
      directFacingSun: illumMean(directBytes, true),
      directAwayFromSun: illumMean(directBytes, false),
      indirectFacingSun: illumMean(indirectBytes, true),
      oceanPatches: ocean.patchCount,
      oceanTriangles: ocean.triangleCount,
      // SMAA を外すと辺の画素が変わる。0 なら鎖に入っていない
      smaaChanged: byteDifference(pipelineBytes, plainBytes, NOISE_FLOOR).differing,
      smaaChangedMax: byteDifference(pipelineBytes, plainBytes).max,
    }

    pipelineTarget.dispose()
    pipeline.dispose()
    scene.remove(ocean.mesh, ocean.plate)
    ocean.dispose()
    // **この先の素の `render()` に露出を持ち越さない。**鎖の外の測りが
    // 変わると、同じ結果の中で条件の違うものが並ぶ
    renderer.toneMapping = THREE.NoToneMapping
  }

  // **`renderAsync()` は使わない。**r183 で非推奨になっていて、
  // 「`render()` を使い、レンダラを作るときに `await renderer.init()` を
  // すること」と警告が出る。`init()` は済ませてあるので `render()` でよい。
  // `info` の集計は `render()` の中で同期に進むので、直後に読める
  const buildStarted = performance.now()
  await renderer.compileAsync(scene, camera)
  const buildMs = performance.now() - buildStarted

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
    sky,
    ocean,
    sprite,
    tone,
    overlay,
    overlaySource,
    pipeline: pipelineResult,
    // **`undefined` しか返らないなら測れていない。**件数がそのまま判定になる
    timestampSamples: gpuSamples.length,
    timestampDropped,
    gpuFrameMs: gpuSamples.length > 0 ? Math.min(...gpuSamples) : null,
    nodeShadow,
    backend: isWebGPU ? 'node-webgpu' : 'node-webgl',
    fellBack: options.gpu === 2 && !isWebGPU,
    sharedCore,
    meshes,
    shaderMaterials,
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.memory.programs,
    atmosphere: sceneSky !== null,
    lutMs,
    buildMs,
    sunElevationDeg,
    initMs,
    firstFrameMs,
    renderMs,
    frames,
  }
}
