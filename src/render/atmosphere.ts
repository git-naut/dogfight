import {
  Color,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Vector3,
  type Camera,
  type WebGLRenderer,
} from 'three'
import {
  AerialPerspectiveEffect,
  PrecomputedTexturesLoader,
  SkyLightProbe,
  SkyMaterial,
  SunDirectionalLight,
  getMoonDirectionECEF,
  getSunDirectionECEF,
  type PrecomputedTextures,
} from '@takram/three-atmosphere'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

/**
 * 物理ベースの大気散乱。
 *
 * Bruneton の Precomputed Atmospheric Scattering の実装を使う。時刻と
 * 太陽高度を与えるだけで、朝焼けから薄暮まで物理的に妥当な空が出る。
 *
 * 実装上の要点は3つある。座標系の橋渡し、ライティングの分担、決定論。
 * 判断の経緯は docs/decisions/0002-atmosphere-integration.md にある。
 */

const DEG = Math.PI / 180

/**
 * 基準となる地理座標。北緯 35.6 度、東経 139.7 度、標高 0。
 *
 * ライブラリの参照フレームは ECEF（地球中心・メートル）に固定されていて
 * 変更できない。こちらのゲームは地表を原点とする Y-up の局所座標なので、
 * この地点を原点に置く行列で橋渡しする。局所座標が原点近傍に留まるため、
 * ECEF の 6,400 km を float32 で扱うときの精度崩れも起きない。
 */
export const REFERENCE_LONGITUDE = 139.7 * DEG
export const REFERENCE_LATITUDE = 35.6 * DEG

/**
 * 基準の日時。基準地点の地方真太陽時で正午にあたる UTC。
 *
 * 太陽方向は実時間の Date から計算されるので、そのまま使うと絵が毎回変わり
 * スクリーンショット回帰が成立しない。固定値を基準にして、時刻はここからの
 * 時間差で表す。
 */
const SOLAR_NOON_UTC = Date.UTC(2026, 7, 16, 2, 45)

/** 既定の時刻。午後の斜光で太陽高度 30 度前後になる */
export const DEFAULT_HOUR = 16

/** 局所時刻（0〜24）から Date を作る。12 が基準地点の南中。 */
export function dateForHour(hour: number): Date {
  return new Date(SOLAR_NOON_UTC + (hour - 12) * 3_600_000)
}

export interface AtmosphereHandle {
  /** 遠景の霞。EffectPass に渡す */
  readonly effect: AerialPerspectiveEffect
  readonly sunLight: SunDirectionalLight
  readonly skyLight: SkyLightProbe
  /** 空を描く全画面クアッド。scene に add 済み */
  readonly sky: Mesh
  /** 太陽高度 rad。デバッグ表示と E2E の検証に使う */
  readonly sunElevation: number
  /** ワールド座標で太陽へ向かう単位ベクトル。雲のライティングに渡す */
  readonly sunDirectionWorld: Vector3
  /** 太陽光の放射輝度。色に強度を掛けたもの */
  readonly sunRadiance: Vector3
  /** 天空光の放射輝度。雲の陰の側を埋める */
  readonly skyRadiance: Vector3
  /** 雲を大気の合成点へ差し込む。null で解除 */
  setOverlay(map: { map: import('three').Texture } | null): void
  /** 時刻を変える。次の update() から反映される */
  setHour(hour: number): void
  /** 毎フレーム呼ぶ */
  update(): void
  dispose(): void
}

export interface AtmosphereOptions {
  /** LUT を置いた URL。末尾のスラッシュは要らない */
  texturesUrl: string
  hour?: number
  /**
   * 高次散乱テクスチャを使うか。3.58 MB 増える代わりに薄暮の精度が上がる。
   * 既定は false（転送量を優先）。
   */
  higherOrderScattering?: boolean
  /**
   * 遠方の楕円体地面の色。自前の地面が切れた先を埋めるので、
   * こちらのアルベドと揃えないと 30 km 付近で境目が見える。
   */
  groundAlbedo?: Color
}

/**
 * LUT を読み込んで大気一式を組み立てる。
 *
 * 読み込みは非同期。呼び出し側は await してから描画を始めること。待たずに
 * 描くとテクスチャのない真っ黒な絵になる。
 */
export async function createAtmosphere(
  renderer: WebGLRenderer,
  camera: Camera,
  options: AtmosphereOptions,
): Promise<AtmosphereHandle> {
  const higherOrderScattering = options.higherOrderScattering ?? false

  const loader = new PrecomputedTexturesLoader({
    format: 'exr',
    combinedScattering: true,
    higherOrderScattering,
  })
  // 端末が float の線形補間に対応していれば FloatType、駄目なら HalfFloatType。
  // CI のソフトウェアレンダラでも後者で通る。
  loader.setType(renderer)

  const textures = await loader.loadAsync(options.texturesUrl)

  // 局所座標を ECEF へ写す行列。
  //
  // ドキュメント推奨の getNorthUpEastFrame は X が北、Z が東になる。それだと
  // 機首方向（-Z）が西を向き、午後の太陽に正対して機体が逆光で潰れる。
  // 基底を組み直して機首方向を東に向け、午後の光が背後から当たるようにする。
  // 右手系であることは tests/render/atmosphere.test.ts で検証している。
  const referenceEcef = new Geodetic(
    REFERENCE_LONGITUDE,
    REFERENCE_LATITUDE,
    0,
  ).toECEF()

  const worldToECEF = createLocalFrame(referenceEcef)

  const skyMaterial = new SkyMaterial({
    sun: true,
    moon: true,
    // 地形の定義域は 48 km 四方。海面の板は 300 km 覆うが水平線の先は
    // 何もないので、そこはライブラリ側の楕円体に任せる
    ground: true,
    ...(options.groundAlbedo ? { groundAlbedo: options.groundAlbedo } : {}),
  })
  applyTextures(skyMaterial, textures)
  skyMaterial.worldToECEFMatrix.copy(worldToECEF)

  const sky = new Mesh(new PlaneGeometry(2, 2), skyMaterial)
  // 頂点シェーダが position をそのまま NDC として使う全画面クアッド。
  // 視錐台の外扱いにされると消えるのでカリングを切る。
  sky.frustumCulled = false
  // 不透明ジオメトリのあとに描く。深度で弾けるぶんだけ無駄が減る
  sky.renderOrder = 1000

  const sunLight = new SunDirectionalLight()
  // コンストラクタ引数では渡らない。ライブラリ側が
  // SunDirectionalLightParameters で transmittanceTexture を宣言しながら、
  // 実装は irradianceTexture という別名で分解している（SunDirectionalLight.ts
  // の 45 行目と 52 行目）。型は通るのに値が捨てられ、太陽光の色が
  // DirectionalLight の既定の白 (1,1,1) のまま固定される。実測で気付いた。
  // 代入で直接入れる。
  sunLight.transmittanceTexture = textures.transmittanceTexture
  sunLight.worldToECEFMatrix.copy(worldToECEF)
  sunLight.target.position.set(0, 0, 0)

  const skyLight = new SkyLightProbe({
    irradianceTexture: textures.irradianceTexture,
  })
  skyLight.worldToECEFMatrix.copy(worldToECEF)

  // 既定で sunLight と skyLight が false になっている。つまりポストプロセス側の
  // ライティングは行わず、透過と in-scatter だけを担当する。機体の PBR は
  // 前方ライティングのまま保たれる。
  const effect = new AerialPerspectiveEffect(camera)
  applyTextures(effect, textures)
  effect.worldToECEFMatrix.copy(worldToECEF)

  // 局所座標の上方向を ECEF へ写したもの。太陽高度の計算に使う
  const localUpEcef = new Vector3(0, 1, 0).transformDirection(worldToECEF)

  const sunDirection = new Vector3()
  const moonDirection = new Vector3()
  const sunDirectionWorld = new Vector3(0, 1, 0)
  const sunRadiance = new Vector3()
  const skyRadiance = new Vector3()
  let hour = options.hour ?? DEFAULT_HOUR
  let elevation = 0

  function refresh(): void {
    const date = dateForHour(hour)
    getSunDirectionECEF(date, sunDirection)
    getMoonDirectionECEF(date, moonDirection)

    skyMaterial.sunDirection.copy(sunDirection)
    skyMaterial.moonDirection.copy(moonDirection)
    effect.sunDirection.copy(sunDirection)
    effect.moonDirection.copy(moonDirection)
    sunLight.sunDirection.copy(sunDirection)
    skyLight.sunDirection.copy(sunDirection)

    sunLight.update()
    skyLight.update()

    elevation = Math.asin(clamp(sunDirection.dot(localUpEcef), -1, 1))
    updateLightVectors()
  }

  /**
   * 雲のシェーダへ渡す値を取り出す。
   *
   * 太陽の向きは ECEF ではなくワールド座標で要る。update() が
   * ライトの位置を太陽方向から決めているので、そこから逆算する。
   */
  function updateLightVectors(): void {
    sunDirectionWorld
      .copy(sunLight.position)
      .sub(sunLight.target.position)
      .normalize()

    sunRadiance.set(sunLight.color.r, sunLight.color.g, sunLight.color.b)
      .multiplyScalar(sunLight.intensity)

    // LightProbe の L0 係数が平均放射輝度にあたる
    const l0 = skyLight.sh.coefficients[0]
    if (l0) skyRadiance.copy(l0).multiplyScalar(skyLight.intensity * 0.28)
  }

  refresh()

  return {
    effect,
    sunLight,
    skyLight,
    sky,

    get sunElevation() {
      return elevation
    },

    get sunDirectionWorld() {
      return sunDirectionWorld
    },

    get sunRadiance() {
      return sunRadiance
    },

    get skyRadiance() {
      return skyRadiance
    },

    setOverlay(overlay) {
      effect.overlay = overlay
    },

    setHour(value: number) {
      hour = value
      refresh()
    },

    update() {
      // 時刻は固定なので毎フレーム太陽を動かす必要はない。ただし機体の高度が
      // 変わると透過率が変わるので、ライト側の更新は毎フレーム要る。
      sunLight.update()
      skyLight.update()
      updateLightVectors()
    },

    dispose() {
      skyMaterial.dispose()
      sky.geometry.dispose()
      effect.dispose()
      for (const texture of Object.values(textures)) texture?.dispose()
    },
  }
}

/**
 * 基準地点を原点とする右手系の局所フレームを作る。
 *
 * X が南、Y が上、Z が西。機首方向の -Z が東を向くので、午後の太陽（西）が
 * 背後から当たる。右手系の条件 X × Y = Z も満たす。
 */
function createLocalFrame(referenceEcef: Vector3): Matrix4 {
  const east = new Vector3()
  const north = new Vector3()
  const up = new Vector3()
  Ellipsoid.WGS84.getEastNorthUpVectors(referenceEcef, east, north, up)

  const south = north.clone().negate()
  const west = east.clone().negate()

  return new Matrix4().makeBasis(south, up, west).setPosition(referenceEcef)
}

interface TextureTarget {
  irradianceTexture: unknown
  scatteringTexture: unknown
  transmittanceTexture: unknown
  singleMieScatteringTexture: unknown
  higherOrderScatteringTexture: unknown
}

/** 読み込んだ LUT をマテリアルやエフェクトへ流し込む。 */
function applyTextures(target: object, textures: PrecomputedTextures): void {
  const t = target as unknown as TextureTarget
  t.irradianceTexture = textures.irradianceTexture
  t.scatteringTexture = textures.scatteringTexture
  t.transmittanceTexture = textures.transmittanceTexture
  t.singleMieScatteringTexture = textures.singleMieScatteringTexture ?? null
  t.higherOrderScatteringTexture = textures.higherOrderScatteringTexture ?? null
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export { createLocalFrame }
