import {
  Color,
  DataTexture,
  DirectionalLight,
  FloatType,
  HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  Scene,
  type PerspectiveCamera,
  type Texture,
  Vector3,
} from 'three'
import {
  Fn,
  atan,
  dot,
  float,
  log2,
  max,
  normalWorld,
  normalWorldGeometry,
  normalize,
  smoothstep,
  texture,
  uniform,
  vec3,
} from 'three/tsl'
import { Node, NodeMaterial, type NodeBuilder, type Renderer } from 'three/webgpu'
import type { IlluminanceProvider } from '../terrain/surfaceNodes'
import { AIRCRAFT_SHADOW_DISTANCE } from '../pipeline/nodeShadow'
import { IRRADIANCE_TABLE } from './irradianceTable'
import {
  GROUND_RADIUS,
  IRRADIANCE_HEIGHT,
  IRRADIANCE_WIDTH,
  MULTISCATTER_SIZE,
  SKY_ILLUMINANCE,
  SKY_VIEW_HEIGHT,
  SKY_VIEW_WIDTH,
  SUN_ILLUMINANCE,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
  sampleIrradiance,
  sunBelowHorizon,
  transmittanceToTop,
  type RgbTable,
} from './reference'
import {
  AERIAL_ATLAS_HEIGHT,
  AERIAL_ATLAS_WIDTH,
  aerialFragmentNode,
  applyAerialNode,
  multiscatterFragmentNode,
  sampleIrradianceNode,
  sampleTransmittanceNode,
  skyViewFragmentNode,
  skyViewUvNode,
  transmittanceFragmentNode,
  type AerialInputs,
} from './skyNodes'

/**
 * 自前の空（段 S2a〜S2b、`?sky=hillaire` の隠しの口）。
 *
 * 透過率と多重散乱の LUT は太陽の向きにもカメラにも依らないので、起動時に 1 回だけ
 * 焼く。天空の照度の表も同じ理由で数表を同梱する（`irradianceTable.ts`）。空の見え方と
 * 霞の LUT は太陽とカメラで変わるので、毎フレーム焼く（web-ocean と同じ分け方）。
 *
 * takram との継ぎ目を全部ここで受ける（段 S2b-1）。背景（空と太陽の円盤）、環境反射、
 * 地形・海・雲の照度、霞、機体の光（直達の `DirectionalLight` と天空の
 * `HemisphereLight`）。月と星は描かない（ユーザーの決定）。
 *
 * **光の尺度。**直達は太陽の照度 × 透過率 × `SUN_ILLUMINANCE`（takram と 0.3% 以内）、
 * 天空は表の値 × π × `SKY_ILLUMINANCE`（正解と 3〜5%）。式は ADR 0044。
 */

/** 太陽の見かけの半径 rad（takram と web-ocean の値） */
const SUN_ANGULAR_RADIUS = 0.004675

/**
 * 機体の光を置く距離 m。**影の追従（`followAircraftShadow`）と同じ距離にする。**
 * 光の位置は影の箱の位置でもあり、毎フレーム `update` と影の追従の両方が置く。
 * 最初は 1 m にしていて、描画の直前に走る `update` が影の追従の 200 m を上書きし、
 * 影の箱（near 1 m）が機体の太陽側を切るおそれがあった（段 S2b-2 で見つけた）
 */
const SUN_LIGHT_DISTANCE = AIRCRAFT_SHADOW_DISTANCE

/** 余弦を含まない照度。名前で引く形は takram の struct に合わせる（`atmosphereNodes.ts`） */
interface SplitIlluminance {
  get(name: string): Node<'vec3'>
}

/** 地形・海・雲が読む照度の口。`AtmosphereNodes` の照度の面と同じ形 */
export interface SkyLighting {
  illuminance: IlluminanceProvider
  scalarIlluminance(world: Node<'vec3'>): SplitIlluminance
}

/** 機体の光。`DirectionalLight` に、影の道具が読む `distance` を足す */
export type SkySunLight = DirectionalLight & { distance: number }

export interface HillaireSky {
  /** `Scene.backgroundNode` に入れる */
  readonly backgroundNode: Node<'vec3'>
  /** `Scene.environmentNode` に入れる。反射の向きで空の見え方の LUT を引く */
  readonly environmentNode: Node<'vec3'>
  /** 向き dir（ワールド、単位ベクトル）の空の放射輝度。海面の映り込みが読む（段 S4a-1） */
  radiance(dir: Node<'vec3'>): Node<'vec3'>
  readonly lighting: SkyLighting
  /** 直達光。影の投げ手を兼ねる。場面へ足すのは呼ぶ側 */
  readonly sunLight: SkySunLight
  /** 天空光（地面の側は 0）。場面へ足すのは呼ぶ側 */
  readonly skyLight: HemisphereLight
  /** 場面の色に霞を掛ける（`nodeOutput.ts` の合成の中から呼ぶ） */
  aerial(color: Node<'vec4'>, depth: Node<'float'>, screen: Node<'vec2'>): Node<'vec4'>
  /**
   * 毎フレーム、場面を描く前に呼ぶ。空の見え方と霞の LUT を焼き直し、機体の光の色と
   * 向きを入れ直す。`lightAnchor` は機体の位置（光の色を決める高さ）
   */
  update(renderer: Renderer, camera: PerspectiveCamera, sunDirectionWorld: Vector3, lightAnchor: Vector3): void
  /**
   * 太陽の向きだけを入れる。**照度を読み戻す前に呼ぶ。**`update` は場面を描く直前に
   * しか走らないので、時刻を変えた直後に焼くと前の向きのまま焼いてしまう
   */
  setSun(sunDirectionWorld: Vector3): void
  dispose(): void
}

function floatTarget(width: number, height: number, name: string, mipmaps = false): RenderTarget {
  const target = new RenderTarget(width, height, {
    format: RGBAFormat,
    type: FloatType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter
  target.texture.magFilter = LinearFilter
  target.texture.generateMipmaps = mipmaps
  target.texture.name = name
  return target
}

/** 全画面のクアッドへ 1 枚焼く。材質は呼び出し側が持ち続ける */
function quadFor(material: NodeMaterial, name: string) {
  const scene = new Scene()
  scene.name = name
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const geometry = new PlaneGeometry(2, 2)
  scene.add(new Mesh(geometry, material))
  return {
    render(renderer: Renderer, target: RenderTarget) {
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(previous)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

function fragmentMaterial(node: Node<'vec4'>): NodeMaterial {
  const material = new NodeMaterial()
  ;(material as unknown as { fragmentNode: unknown }).fragmentNode = node
  material.depthTest = false
  material.depthWrite = false
  return material
}

/** 同梱の照度の表を GPU の表にする。行 0 が高さ 0 km */
export function createIrradianceTexture(): DataTexture {
  const data = new Float32Array(IRRADIANCE_WIDTH * IRRADIANCE_HEIGHT * 4)
  for (let i = 0; i < IRRADIANCE_WIDTH * IRRADIANCE_HEIGHT; i++) {
    data[i * 4] = IRRADIANCE_TABLE[i * 3]!
    data[i * 4 + 1] = IRRADIANCE_TABLE[i * 3 + 1]!
    data[i * 4 + 2] = IRRADIANCE_TABLE[i * 3 + 2]!
    data[i * 4 + 3] = 1
  }
  const tex = new DataTexture(data, IRRADIANCE_WIDTH, IRRADIANCE_HEIGHT, RGBAFormat, FloatType)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = false
  tex.name = 'SkyIrradiance'
  tex.needsUpdate = true
  return tex
}

/** CPU 側の照度の表（機体の天空光の色を決める） */
const IRRADIANCE_CPU: RgbTable = {
  width: IRRADIANCE_WIDTH,
  height: IRRADIANCE_HEIGHT,
  data: Float64Array.from(IRRADIANCE_TABLE),
}

/**
 * 環境反射。three の `EnvironmentNode` が反射の文脈（`getUV` と `getTextureLevel`）を
 * 被せて呼ぶ（`EnvironmentNode.js` の `createRadianceContext`）。向きはワールド、
 * 段は粗さ。照度の文脈では向きが法線、段は 1。
 *
 * **キューブと PMREM を作らない。**takram は空をキューブへ描いて PMREM で畳み、
 * 約 1 秒に 1 回 2.5 ms 跳ねていた（段 S0c）。ここは空の見え方の LUT のミップを
 * 粗さで選んで直に引く。ぼかしの形は GGX ではなく、LUT の画素の並び（地平線の付近が
 * 細かい）に沿った近似になる（推測。絵の承認で確かめる）
 */
class SkyEnvironmentNode extends Node {
  constructor(private readonly sample: (dir: Node<'vec3'>, roughness: Node<'float'>) => Node<'vec3'>) {
    super('vec3')
  }

  static get type(): string {
    return 'SkyEnvironmentNode'
  }

  override setup(builder: NodeBuilder): Node<'vec3'> {
    const context = (builder as unknown as {
      context: { getUV?: () => Node<'vec3'>; getTextureLevel?: () => Node<'float'> }
    }).context
    const dir = context.getUV?.() ?? (normalWorld as unknown as Node<'vec3'>)
    const roughness = context.getTextureLevel?.() ?? (float(0) as unknown as Node<'float'>)
    return this.sample(dir, roughness)
  }
}

export function createHillaireSky(renderer: Renderer): HillaireSky {
  const transmittance = floatTarget(TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT, 'SkyTransmittance')
  const multiscatter = floatTarget(MULTISCATTER_SIZE, MULTISCATTER_SIZE, 'SkyMultiscatter')
  // 環境反射が粗さでミップを選ぶので、空の見え方だけミップを作る
  const skyView = floatTarget(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT, 'SkyView', true)
  const aerialInscatter = floatTarget(AERIAL_ATLAS_WIDTH, AERIAL_ATLAS_HEIGHT, 'SkyAerial')
  const aerialTransmittance = floatTarget(AERIAL_ATLAS_WIDTH, AERIAL_ATLAS_HEIGHT, 'SkyAerialT')
  const irradiance = createIrradianceTexture()

  // 起動時に 1 回だけ焼く
  const transmittanceQuad = quadFor(fragmentMaterial(transmittanceFragmentNode()), 'Sky [ Transmittance ]')
  transmittanceQuad.render(renderer, transmittance)
  const multiscatterQuad = quadFor(
    fragmentMaterial(multiscatterFragmentNode(transmittance.texture)),
    'Sky [ Multiscatter ]',
  )
  multiscatterQuad.render(renderer, multiscatter)
  transmittanceQuad.dispose()
  multiscatterQuad.dispose()

  // 毎フレーム書き換える値。高さは km
  const altitude = uniform(0)
  const sunMu = uniform(0.5)
  const sunDir = uniform(new Vector3(0, 1, 0))
  const projectionInverse = uniform(new Matrix4())
  const cameraWorld = uniform(new Matrix4())
  const alt = altitude as unknown as Node<'float'>
  const sd = sunDir as unknown as Node<'vec3'>
  const aerialInputs: AerialInputs = {
    altitude: alt,
    sunDir: sd,
    projectionInverse: projectionInverse as unknown as Node<'mat4'>,
    cameraWorld: cameraWorld as unknown as Node<'mat4'>,
  }

  const skyViewQuad = quadFor(
    fragmentMaterial(
      skyViewFragmentNode(
        transmittance.texture as Texture,
        multiscatter.texture as Texture,
        alt,
        sunMu as unknown as Node<'float'>,
      ),
    ),
    'Sky [ View ]',
  )
  const aerialQuad = quadFor(
    fragmentMaterial(aerialFragmentNode(transmittance.texture, multiscatter.texture, aerialInputs, 'inscatter')),
    'Sky [ Aerial ]',
  )
  const aerialTQuad = quadFor(
    fragmentMaterial(aerialFragmentNode(transmittance.texture, multiscatter.texture, aerialInputs, 'transmittance')),
    'Sky [ Aerial T ]',
  )

  const scaleSky = vec3(SKY_ILLUMINANCE[0], SKY_ILLUMINANCE[1], SKY_ILLUMINANCE[2])
  const scaleSun = vec3(SUN_ILLUMINANCE[0], SUN_ILLUMINANCE[1], SUN_ILLUMINANCE[2])

  /** 向き dir の空の放射輝度（輝度の尺度込み）。ミップ level で引く */
  const skyAt = (dir: Node<'vec3'>, level: Node<'float'> | number) =>
    texture(skyView.texture, skyViewUvNode(dir, sd, alt), level).rgb.mul(scaleSky) as unknown as Node<'vec3'>

  const backgroundNode = Fn(() => {
    const dir = normalize(normalWorldGeometry) as unknown as Node<'vec3'>
    const sky = skyAt(dir, 0)
    // 太陽の円盤。放射輝度 = 照度 / (π θ²)。縁は 1 画素ぶんぼかす
    const cosSun = dot(dir, sd)
    const disc = smoothstep(Math.cos(SUN_ANGULAR_RADIUS * 1.15), Math.cos(SUN_ANGULAR_RADIUS), cosSun)
    const sunT = sampleTransmittanceNode(transmittance.texture, alt.add(GROUND_RADIUS), sd.y)
    const sunRadiance = scaleSun.mul(sunT).div(Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS)
    return sky.add(sunRadiance.mul(disc))
  })() as unknown as Node<'vec3'>

  // 粗さからミップの段。GGX の広がり atan(粗さ²) を、LUT の横の 1 画素の角度
  // （π / 幅）で割った数の 2 の対数（推測による近似。ファイルの頭の注記）
  const environmentNode = new SkyEnvironmentNode((dir, roughness) => {
    const spread = atan(roughness.mul(roughness)).mul(SKY_VIEW_WIDTH / Math.PI)
    return skyAt(dir, log2(max(spread, 1)) as unknown as Node<'float'>)
  }) as unknown as Node<'vec3'>

  // ---- 地形・海・雲の照度 ----
  // 地球の丸みは高さにだけ入れる（水平に 100 km 離れても太陽の角度は 0.9 度しか変わらない）
  const altitudeOf = (world: Node<'vec3'>) => max(world.y, 0).div(1000) as unknown as Node<'float'>
  const directAt = (world: Node<'vec3'>): Node<'vec3'> =>
    Fn(() => {
      const r = altitudeOf(world).add(GROUND_RADIUS).toVar()
      const t = sampleTransmittanceNode(transmittance.texture, r, sd.y).toVar()
      // 地平線より下の太陽は届かない（`sunBelowHorizon`）
      const rho = r.mul(r).sub(GROUND_RADIUS * GROUND_RADIUS).max(0).sqrt()
      const below = sd.y.lessThan(rho.negate().div(r))
      return below.select(vec3(0, 0, 0), t.mul(scaleSun))
    })() as unknown as Node<'vec3'>
  const skyUpAt = (world: Node<'vec3'>): Node<'vec3'> =>
    sampleIrradianceNode(irradiance, sd.y, altitudeOf(world)).mul(scaleSky).mul(Math.PI) as unknown as Node<'vec3'>

  const lighting: SkyLighting = {
    illuminance(world, normal) {
      return {
        direct: directAt(world).mul(max(dot(normal, sd), 0)) as unknown as Node<'vec3'>,
        // 上向きの面の値に (1 + N・上) / 2 を掛ける。takram の `getIndirectIlluminance` と
        // three の `HemisphereLight`（地面 0）と同じ式
        indirect: skyUpAt(world).mul(normal.y.add(1).mul(0.5)) as unknown as Node<'vec3'>,
      }
    },
    scalarIlluminance(world) {
      return {
        get(name) {
          if (name === 'direct') return directAt(world)
          if (name === 'indirect') return skyUpAt(world)
          throw new Error(`照度の名前が違う: ${name}`)
        },
      }
    },
  }

  // ---- 機体の光 ----
  const sunLight = new DirectionalLight(0xffffff, 1) as SkySunLight
  sunLight.distance = SUN_LIGHT_DISTANCE
  sunLight.name = 'SkySun'
  const skyLight = new HemisphereLight(0xffffff, 0x000000, 1)
  skyLight.name = 'SkyAmbient'

  /** 機体の高さで光の色を入れ直す。GPU と同じ式を CPU 参照で解く */
  function updateLights(sunDirectionWorld: Vector3, anchor: Vector3): void {
    const h = Math.max(anchor.y, 0) / 1000
    const r = GROUND_RADIUS + h
    const mu = sunDirectionWorld.y
    const t = sunBelowHorizon(r, mu) ? [0, 0, 0] : transmittanceToTop(r, mu)
    sunLight.color.setRGB(SUN_ILLUMINANCE[0] * t[0]!, SUN_ILLUMINANCE[1] * t[1]!, SUN_ILLUMINANCE[2] * t[2]!)
    const e = sampleIrradiance(IRRADIANCE_CPU, mu, h)
    skyLight.color.setRGB(
      SKY_ILLUMINANCE[0] * e[0] * Math.PI,
      SKY_ILLUMINANCE[1] * e[1] * Math.PI,
      SKY_ILLUMINANCE[2] * e[2] * Math.PI,
    )
    skyLight.groundColor.copy(BLACK)
    // 向きは位置から決まる。影の箱は `followAircraftShadow` が同じ形で置き直す
    sunLight.target.position.copy(anchor)
    sunLight.position.copy(sunDirectionWorld).multiplyScalar(sunLight.distance).add(anchor)
  }

  const cameraPosition = new Vector3()
  const setSun = (sunDirectionWorld: Vector3) => {
    sunMu.value = sunDirectionWorld.y
    ;(sunDir.value as Vector3).copy(sunDirectionWorld)
  }

  return {
    backgroundNode,
    environmentNode,
    radiance: (dir) => skyAt(dir, 0),
    lighting,
    sunLight,
    skyLight,
    aerial(color, depth, screen) {
      return applyAerialNode(
        color,
        depth,
        screen,
        aerialInscatter.texture,
        aerialTransmittance.texture,
        aerialInputs,
        scaleSky as unknown as Node<'vec3'>,
      )
    },
    update(r, camera, sunDirectionWorld, lightAnchor) {
      // **射影を描き手の座標系に合わせてから写す。**three は描くときに切り替える
      // （`Renderer.render` の `coordinateSystem` の分岐）ので、最初の 1 枚より前は
      // WebGL の射影（深度 -1〜1）のまま。霞の距離は深度から出すので、ずれると桁で外れる
      if (camera.coordinateSystem !== r.coordinateSystem) {
        camera.coordinateSystem = r.coordinateSystem
        camera.updateProjectionMatrix()
      }
      camera.updateMatrixWorld()
      camera.getWorldPosition(cameraPosition)
      altitude.value = Math.max(cameraPosition.y, 0) / 1000
      setSun(sunDirectionWorld)
      ;(projectionInverse.value as Matrix4).copy(camera.projectionMatrixInverse)
      ;(cameraWorld.value as Matrix4).copy(camera.matrixWorld)
      skyViewQuad.render(r, skyView)
      aerialQuad.render(r, aerialInscatter)
      aerialTQuad.render(r, aerialTransmittance)
      updateLights(sunDirectionWorld, lightAnchor)
    },
    setSun,
    dispose() {
      skyViewQuad.dispose()
      aerialQuad.dispose()
      aerialTQuad.dispose()
      transmittance.dispose()
      multiscatter.dispose()
      skyView.dispose()
      aerialInscatter.dispose()
      aerialTransmittance.dispose()
      irradiance.dispose()
      sunLight.dispose()
      skyLight.dispose()
    },
  }
}

const BLACK = new Color(0, 0, 0)
