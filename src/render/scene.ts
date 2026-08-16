import * as THREE from 'three'
import type { AircraftSample } from '../sim/aircraft'
import type { LookOffset } from '../input/mouseLook'
import { createChaseCamera, type ChaseCamera } from './camera'
import { createAircraftView, type AircraftView } from './aircraftView'
import { createAtmosphere, DEFAULT_HOUR, type AtmosphereHandle } from './atmosphere'
import { createComposer, type ComposerHandle } from './composer'
import { getQuality, type PresetName, type QualitySettings } from './quality'

/**
 * Phase 2 のシーン。
 *
 * 空は @takram/three-atmosphere による物理ベースの大気散乱。ライティングも
 * 大気の LUT から導かれるので、時刻を変えれば光の色と強さが一貫して変わる。
 *
 * 地面は平面とシェーダのグリッドのまま。起伏のある地形とボリュメトリック雲は
 * Phase 3 で入れる。
 */

/**
 * 地面のアルベド。
 *
 * 当初はグリッド線を読みやすくするため 0x1e2c22 まで落としていたが、
 * リニアでは 0.02 で舗装並みに暗く、3 km 先の大気の霞に完全に負けていた。
 * 植生として妥当な 0.07 前後へ上げる。グリッド線の側を暗くして対比を取る。
 */
const GROUND_COLOR = new THREE.Color(0x4a5f3e)

/** グリッドの目盛り間隔 m。速度の目安になる */
const GRID_SPACING = 400
/**
 * 地面の広さ m。
 *
 * 大気は楕円体の上に載っているので、平面を伸ばしすぎると地球の丸みから外れる。
 * 150 km 先では 1.8 km ずれて地平線の位置が合わなくなる。30 km で切り、
 * その先はライブラリ側の楕円体地面に任せる。
 */
const GROUND_EXTENT = 60_000
const GRID_FADE_START = 9_000
const GRID_FADE_END = 26_000

export interface SceneHandle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  chase: ChaseCamera
  /** 太陽高度 rad。デバッグ表示と E2E の検証に使う */
  readonly sunElevation: number
  readonly quality: QualitySettings
  /** sim の状態を描画へ反映する */
  sync(sample: AircraftSample, dt: number, look: LookOffset, snap?: boolean): void
  render(): void
  resize(width: number, height: number, devicePixelRatio: number): void
  setQuality(preset: PresetName): void
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

export interface SceneOptions {
  preset: PresetName
  hour?: number
  /** トーンマッピングの露出。調整用に上書きできる */
  exposure?: number
  /** 大気の LUT を置いた URL */
  texturesUrl: string
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
  let quality = getQuality(options.preset)

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
  renderer.toneMappingExposure = options.exposure ?? DEFAULT_EXPOSURE

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 400_000)
  const chase = createChaseCamera(camera)

  const atmosphere: AtmosphereHandle = await createAtmosphere(renderer, camera, {
    texturesUrl: options.texturesUrl,
    hour: options.hour ?? DEFAULT_HOUR,
    groundAlbedo: GROUND_COLOR,
  })

  scene.add(atmosphere.sky)
  scene.add(atmosphere.sunLight)
  scene.add(atmosphere.sunLight.target)
  scene.add(atmosphere.skyLight)

  const ground = createGround(quality)
  scene.add(ground)

  const aircraft: AircraftView = createAircraftView()
  scene.add(aircraft.object)

  const composer: ComposerHandle = createComposer({
    renderer,
    scene,
    camera,
    aerialPerspective: atmosphere.effect,
    quality,
  })

  const quaternion = new THREE.Quaternion()
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

  return {
    renderer,
    scene,
    camera,
    chase,

    get sunElevation() {
      return atmosphere.sunElevation
    },

    get quality() {
      return quality
    },

    sync(sample, dt, look, snap = false) {
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

      // 地面を機体に追従させて有限のジオメトリで無限に見せる。
      // グリッド模様はワールド座標で描くので、板が動いても線は流れない
      ground.position.x = sample.position.x
      ground.position.z = sample.position.z

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
      atmosphere.update()

      if (snap) chase.snap(sample, look)
      else chase.update(sample, dt, look)
    },

    render() {
      composer.render()
    },

    resize(width, height, devicePixelRatio) {
      cssWidth = width
      cssHeight = height
      dpr = devicePixelRatio
      applySize()
    },

    setQuality(preset) {
      quality = getQuality(preset)
      composer.setQuality(quality)
      applySize()
    },

    setHour(hour) {
      atmosphere.setHour(hour)
    },

    setExposure(value) {
      renderer.toneMappingExposure = value
    },

    dispose() {
      aircraft.dispose()
      atmosphere.dispose()
      composer.dispose()
      ground.geometry.dispose()
      ;(ground.material as THREE.Material).dispose()
      renderer.dispose()
    },
  }
}

/**
 * 地面。グリッドは別のジオメトリを重ねず、地面のシェーダに直接焼く。
 *
 * 線の板を地面の少し上に置く方式だと、遠距離で深度精度が足りなくなって
 * 線が消える。ワールド座標から模様を計算すれば深度の競合が起きないし、
 * fwidth でアンチエイリアスもかかり、距離フェードも入れられる。
 *
 * 照明を効かせたいので MeshStandardMaterial に差し込む。
 */
function createGround(quality: QualitySettings): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: 1,
    metalness: 0,
  })

  material.onBeforeCompile = (shader) => {
    shader.uniforms['minorSpacing'] = { value: GRID_SPACING }
    shader.uniforms['majorSpacing'] = { value: GRID_SPACING * 5 }
    shader.uniforms['minorColor'] = { value: new THREE.Color(0x33452e) }
    shader.uniforms['majorColor'] = { value: new THREE.Color(0x1b2617) }
    shader.uniforms['gridFadeStart'] = { value: GRID_FADE_START }
    shader.uniforms['gridFadeEnd'] = { value: GRID_FADE_END }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorldPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGroundWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vGroundWorldPos;
        uniform float minorSpacing;
        uniform float majorSpacing;
        uniform vec3 minorColor;
        uniform vec3 majorColor;
        uniform float gridFadeStart;
        uniform float gridFadeEnd;

        // 線からの距離をピクセル単位で測り、1 px 前後の幅に収める
        float gridMask(vec2 worldXZ, float spacing, float widthPx) {
          vec2 coord = worldXZ / spacing;
          vec2 derivative = fwidth(coord);
          vec2 distanceToLine = abs(fract(coord - 0.5) - 0.5) / max(derivative, vec2(1e-6));
          float nearest = min(distanceToLine.x, distanceToLine.y);
          return 1.0 - clamp(nearest / widthPx, 0.0, 1.0);
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        {
          float toCamera = distance(vGroundWorldPos.xz, cameraPosition.xz);
          float fade = 1.0 - smoothstep(gridFadeStart, gridFadeEnd, toCamera);
          float minorLine = gridMask(vGroundWorldPos.xz, minorSpacing, 1.1) * 0.5;
          float majorLine = gridMask(vGroundWorldPos.xz, majorSpacing, 1.6) * 0.95;
          diffuseColor.rgb = mix(diffuseColor.rgb, minorColor, minorLine * fade);
          diffuseColor.rgb = mix(diffuseColor.rgb, majorColor, majorLine * fade);
        }
        `,
      )
  }

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_EXTENT, GROUND_EXTENT),
    material,
  )
  mesh.rotation.x = -Math.PI / 2
  void quality
  return mesh
}

export { GROUND_COLOR }
