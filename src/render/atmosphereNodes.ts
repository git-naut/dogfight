import { Matrix4, Vector2, Vector3, type Camera, type Scene } from 'three'
import { getMoonDirectionECEF, getSunDirectionECEF } from '@takram/three-atmosphere'
import { Geodetic } from '@takram/three-geospatial'
import {
  createLocalFrame,
  dateForHour,
  REFERENCE_LATITUDE,
  REFERENCE_LONGITUDE,
} from './atmosphere'
import { context as tslContext, vec4 } from 'three/tsl'
import type { Node, Renderer } from 'three/webgpu'
import type { QualitySettings } from './quality'
import type { IlluminanceProvider } from './terrain/surfaceNodes'

/**
 * 大気の LUT から照度を引く道具。
 *
 * **ワールド座標をそのまま渡せない。**大気は ECEF の単位空間で解かれて
 * いるので、`matrixWorldToECEF` を掛けて `worldToUnit` で縮める。高度の
 * 補正が有効なときは `altitudeCorrectionECEF` を足す。この 3 段を忘れると
 * 例外は出ないまま値が桁ごとずれる。
 *
 * **機体と同じ式になる。**`AtmosphereLightNode` は間接に
 * `getIndirectIlluminance` を使い、直達は太陽放射照度に透過率と
 * `max(N・L, 0)` を掛ける。`getSplitIlluminance` はその 2 つを 1 度に
 * 返す（`getSplitIrradiance` が同じ式で組んでいる）ので、地形と機体の光が
 * 同じ式で決まる。
 *
 * **写しを 2 つ作らない。**プローブと本番の場面で同じ写し替えを 2 度書くと、
 * 片方だけ直したときに気づけない（段 20a-2-3）。
 *
 * 大気のモジュールは引数で受ける。`@takram/three-atmosphere/webgpu` は
 * node 経路でしか使わないので、静的に import すると既定の経路の束にも
 * 入ってしまう。呼ぶ側が動的に読んだものを渡す。
 */
type AtmosphereWebgpu = typeof import('@takram/three-atmosphere/webgpu')

/** `AtmosphereContext` のうち、写し替えに要る面だけ */
export interface AtmosphereContextLike {
  parametersNode: unknown
  matrixWorldToECEF: unknown
  correctAltitude: boolean
  altitudeCorrectionECEF: unknown
  sunDirectionECEF: unknown
}

/** 余弦を含む照度と含まない照度。名前で引く形は takram の struct に合わせる */
interface SplitIlluminance {
  get(name: string): Node<'vec3'>
}

export interface AtmosphereNodes {
  /** ワールドの点を大気の単位空間へ写す */
  toUnit(world: Node<'vec3'>): Node<'vec3'>
  /** 法線ぶんの余弦を含む照度。地形と海面のライティングが読む */
  illuminance: IlluminanceProvider
  /**
   * 余弦を含まない側の照度。
   *
   * 雲は法線を持たないので、太陽の見かけの明るさにこちらを使う
   */
  scalarIlluminance(world: Node<'vec3'>): SplitIlluminance
}

export function createAtmosphereNodes(
  atmos: AtmosphereWebgpu,
  context: AtmosphereContextLike,
): AtmosphereNodes {
  const worldToUnit = (context.parametersNode as { worldToUnit: Node<'float'> }).worldToUnit
  const toECEF = context.matrixWorldToECEF as Node<'mat4'>
  const sunDirectionECEF = context.sunDirectionECEF as Node<'vec3'>

  function toUnit(world: Node<'vec3'>): Node<'vec3'> {
    let positionECEF = toECEF.mul(vec4(world, 1)).xyz
    if (context.correctAltitude) {
      positionECEF = positionECEF.add(context.altitudeCorrectionECEF as Node<'vec3'>)
    }
    return positionECEF.mul(worldToUnit)
  }

  return {
    toUnit,

    illuminance(world, normal) {
      // 法線は向きなので w = 0。位置と同じ行列で回すが平行移動は乗らない
      const normalECEF = toECEF.mul(vec4(normal, 0)).xyz
      const split = atmos.getSplitIlluminance(
        toUnit(world) as never,
        normalECEF as never,
        sunDirectionECEF as never,
      ) as unknown as SplitIlluminance
      return { direct: split.get('direct'), indirect: split.get('indirect') }
    },

    scalarIlluminance(world) {
      return atmos.getSplitScalarIlluminance(
        toUnit(world) as never,
        sunDirectionECEF as never,
      ) as unknown as SplitIlluminance
    },
  }
}

/**
 * 大気を node 経路へ組み込む。
 *
 * **外せない手順が 4 つある。**どれも破っても例外が出ない。
 *
 * 1. **既存の `contextNode.value` を潰さない。**`renderer.highPrecision`
 *    を立てると `Renderer` の setter が `modelViewMatrix` をここへ入れる
 *    （`Renderer.js` の `set highPrecision`）。潰すと高精度の行列が消える。
 * 2. `NodeLibrary.addLight` で `AtmosphereLightNode` を登録する。
 *    `@types/three` は `declare class NodeLibrary {}` しか持たないので
 *    型からは見えない（名前と引数は `NodeLibrary.js:142` で確かめた）。
 * 3. LUT の縮小は**面積で効く。**倍率を半分にすると計算量は 4 分の 1。
 *    `round()` のあと 1 で下限を取らないと 0 になる。
 * 4. **鎖を組むときは背景に空クアッドを置かない。**
 *    `AerialPerspectiveNode` が `depth >= 1` の画素で `skyNode` を
 *    評価するので、背景にも空を入れると二重に描く。
 *
 * 入れるのは元になる 3 つだけでよい。`matrixECEFToWorld` と
 * `cameraPositionECEF` は `onRenderUpdate` がここから導く。
 */
export interface AtmosphereSetupInput {
  renderer: Renderer
  camera: Camera
  scene: Scene
  quality: QualitySettings
  /** ワールドから ECEF への行列 */
  worldToECEF: Matrix4
  sunDirectionECEF: Vector3
  moonDirectionECEF: Vector3
  /**
   * 背景に空クアッドを置くか。
   *
   * **ポストの鎖を組むときは false。**`AerialPerspectiveNode` が空を描く
   */
  skyBackground: boolean
}

export interface AtmosphereSetup {
  context: InstanceType<AtmosphereWebgpu['AtmosphereContext']>
  /** `AtmosphereLight`。影の投げ手にも使う */
  sunLight: import('three').DirectionalLight
  nodes: AtmosphereNodes
}

export function setupAtmosphereNodes(
  atmos: AtmosphereWebgpu,
  input: AtmosphereSetupInput,
): AtmosphereSetup {
  const { renderer, camera, scene, quality } = input

  const context = new atmos.AtmosphereContext()
  context.camera = camera
  context.raymarchScattering = quality.aerialRaymarchScattering
  context.matrixWorldToECEF.value.copy(input.worldToECEF)
  context.sunDirectionECEF.value.copy(input.sunDirectionECEF)
  context.moonDirectionECEF.value.copy(input.moonDirectionECEF)

  if (quality.atmosphereLutScale !== 1) {
    const p = context.parameters
    const one2 = new Vector2(1, 1)
    const one3 = new Vector3(1, 1, 1)
    p.transmittanceTextureSize.multiplyScalar(quality.atmosphereLutScale).round().max(one2)
    p.irradianceTextureSize.multiplyScalar(quality.atmosphereLutScale).round().max(one2)
    p.multipleScatteringTextureSize
      .multiplyScalar(quality.atmosphereLutScale)
      .round()
      .max(one2)
    p.scatteringTextureSize.multiplyScalar(quality.atmosphereLutScale).round().max(one3)
  }

  renderer.contextNode = tslContext({
    ...(renderer.contextNode.value as Record<string, unknown>),
    getAtmosphere: () => context,
  }) as never

  const library = renderer.library as unknown as {
    addLight(nodeClass: unknown, lightClass: unknown): void
  }
  library.addLight(atmos.AtmosphereLightNode, atmos.AtmosphereLight)

  const sunLight = new atmos.AtmosphereLight()
  scene.add(sunLight)
  scene.add(sunLight.target)

  // `Scene.backgroundNode` と `environmentNode` も `@types/three` に無い。
  // 読む側は `NodeManager.getBackgroundNode()` と `NodeManager.js:513`
  const sceneNodes = scene as unknown as {
    backgroundNode: unknown
    environmentNode: unknown
  }
  if (input.skyBackground) sceneNodes.backgroundNode = atmos.skyBackground()
  if (quality.skyEnvironmentSize > 0) {
    sceneNodes.environmentNode = atmos.skyEnvironment(quality.skyEnvironmentSize)
  }

  return {
    context,
    sunLight: sunLight as unknown as import('three').DirectionalLight,
    nodes: createAtmosphereNodes(atmos, context as unknown as AtmosphereContextLike),
  }
}

/**
 * 時刻から太陽と月の向きを出す。
 *
 * **原点も時刻も GLSL 経路と同じものを使う。**別々に持つと、絵を見比べても
 * 分からないずれ方をする。基準は `atmosphere.ts` の 1 か所だけ。
 *
 * 大気は ECEF で解かれるので向きも ECEF で持つ。雲のライティングは
 * ワールド座標の向きが要るので、逆行列で戻したものも返す。
 */
export interface SolarFrame {
  /** ワールドから ECEF への行列 */
  worldToECEF: Matrix4
  sunDirectionECEF: Vector3
  moonDirectionECEF: Vector3
  /** 太陽高度 deg。地平線より下なら負 */
  sunElevationDeg: number
  /** ワールド座標の太陽の向き。単位ベクトル */
  sunDirectionWorld: Vector3
}

export function solarFrameForHour(hour: number): SolarFrame {
  const referenceEcef = new Geodetic(REFERENCE_LONGITUDE, REFERENCE_LATITUDE, 0).toECEF()
  const worldToECEF = createLocalFrame(referenceEcef)
  const date = dateForHour(hour)
  const sunDirectionECEF = getSunDirectionECEF(date, new Vector3())
  const moonDirectionECEF = getMoonDirectionECEF(date, new Vector3())

  // 局所の上方向を ECEF へ回してから内積を取る。**ワールドの Y と
  // ECEF の Z は別物**なので、行列を通さずに測ると緯度ぶんずれる
  const localUpECEF = new Vector3(0, 1, 0).transformDirection(worldToECEF)
  const cos = Math.max(-1, Math.min(1, sunDirectionECEF.dot(localUpECEF)))
  const sunElevationDeg = (Math.asin(cos) * 180) / Math.PI

  const sunDirectionWorld = sunDirectionECEF
    .clone()
    .transformDirection(worldToECEF.clone().invert())

  return {
    worldToECEF,
    sunDirectionECEF,
    moonDirectionECEF,
    sunElevationDeg,
    sunDirectionWorld,
  }
}
