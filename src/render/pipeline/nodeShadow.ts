import {
  BasicShadowMap,
  PCFShadowMap,
  PCFSoftShadowMap,
  Vector3,
  type OrthographicCamera,
  type ShadowMapType,
} from 'three'
import { float, shadow } from 'three/tsl'
import type { Node, Renderer } from 'three/webgpu'
import type { AtmosphereSunLight } from '../atmosphereNodes'
import type { QualitySettings } from '../quality'

/**
 * 機体の影を node 経路で組む。
 *
 * **`renderer.shadowMap.enabled` を先に立てる。**立てずに `shadow(light)` を
 * 呼ぶと、ノードは本体を生成せず `TSL: Invalid generated code, expected a
 * "float"` をコンソールへ出すだけで進む。材質は組み上がったように見えるが
 * 影マップは null のままで、最初の描画が `updateShadow` の中で
 * `Cannot read properties of null (reading 'depthTexture')` で落ちる。
 * **例外の出どころが 2 段離れる**ので、原因が影の有効化だと分かりにくい
 * （段 20a-2-3 で実際に踏んだ）。
 *
 * **`castShadow` は立てない。**立てたまま組むと three の光の系が影のノードを
 * もう 1 つ作る。立てるのは `buildNodePipeline` が `compileAsync` のあとに
 * 行う（`nodeBuild.ts` の注記）。
 *
 * 影の箱は機体を囲む 28 m 角。CSM は採らない（ADR 0010）。遮蔽物が機体
 * 1 機（全長 17.8 m）しかなく、地形を投げ手にするのは別の仕事。
 */
export const AIRCRAFT_SHADOW_HALF_EXTENT = 14
/** 投げ手を機体からどれだけ離すか。影の箱の far より内側に収める */
export const AIRCRAFT_SHADOW_DISTANCE = 200

export interface NodeAircraftShadowInput {
  renderer: Renderer
  light: AtmosphereSunLight
  quality: QualitySettings
  /** 影の箱の中心。機体の位置 */
  center: Vector3
  /** ワールド座標の太陽の向き */
  sunDirectionWorld: Vector3
}

/** `quality.shadowFilter` を three の定数へ。**PCFSoft は node 経路では生きている** */
export function shadowMapType(quality: QualitySettings): ShadowMapType {
  if (quality.shadowFilter === 'pcfSoft') return PCFSoftShadowMap
  if (quality.shadowFilter === 'pcf') return PCFShadowMap
  return BasicShadowMap
}

export interface NodeAircraftShadow {
  /** 影の係数。立てていなければ 1（遮らない） */
  shade: Node<'float'>
  /**
   * 影を立てたか。
   *
   * **`aircraftShadowMapSize` が 0 のプリセット（low）では立てない。**
   * 立てると `low では影も環境反射も切れている` が通らない。false のときは
   * `buildNodePipeline` へ投げ手を渡さない（渡すと `castShadow` が立つ）
   */
  enabled: boolean
}

export function configureNodeAircraftShadow(
  input: NodeAircraftShadowInput,
): NodeAircraftShadow {
  const { renderer, light, quality } = input

  if (quality.aircraftShadowMapSize === 0) {
    light.castShadow = false
    return { shade: float(1) as unknown as Node<'float'>, enabled: false }
  }

  // **組み立てのあいだは伏せる。**理由は本文の注記
  light.castShadow = false
  light.position
    .copy(input.sunDirectionWorld)
    .multiplyScalar(AIRCRAFT_SHADOW_DISTANCE)
    .add(input.center)
  light.target.position.copy(input.center)

  const size = quality.aircraftShadowMapSize
  light.shadow.mapSize.set(size, size)

  const box = light.shadow.camera as OrthographicCamera
  box.left = -AIRCRAFT_SHADOW_HALF_EXTENT
  box.right = AIRCRAFT_SHADOW_HALF_EXTENT
  box.top = AIRCRAFT_SHADOW_HALF_EXTENT
  box.bottom = -AIRCRAFT_SHADOW_HALF_EXTENT
  box.near = 1
  box.far = 400
  box.updateProjectionMatrix()

  // **ここが要。**立てずに `shadow()` を呼ぶと本体が生成されない
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = shadowMapType(quality)

  return { shade: shadow(light as never) as unknown as Node<'float'>, enabled: true }
}

/**
 * 影の箱を機体へ追従させる。
 *
 * **`AtmosphereLight` は自分の位置を更新しない。**`directionECEF` を持つ
 * だけなので、ワールド座標の太陽の向きから位置を入れる
 */
export function followAircraftShadow(
  light: AtmosphereSunLight,
  center: Vector3,
  sunDirectionWorld: Vector3,
): void {
  light.target.position.copy(center)
  light.position
    .copy(sunDirectionWorld)
    .multiplyScalar(AIRCRAFT_SHADOW_DISTANCE)
    .add(center)
  light.shadow.needsUpdate = true
}
