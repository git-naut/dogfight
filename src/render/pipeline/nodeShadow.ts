import {
  BasicShadowMap,
  PCFShadowMap,
  PCFSoftShadowMap,
  Vector3,
  type OrthographicCamera,
  type ShadowMapType,
} from 'three'
import { float, mix, shadow, uniform } from 'three/tsl'
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
  /**
   * 実行時に影を効かせるか。1 で効き、0 で遮らない。
   *
   * **組み立てのあとに影を切る道はこれしかない。**`shadow(light)` は
   * ノードへ焼き込まれているので、`castShadow` を下ろすと本体が null の
   * まま `updateBefore` だけが走る。旧経路も同じ形で、深度テクスチャを
   * 束縛したまま `aircraftShadowEnabled` を 0 にしている
   * （`pipeline/webgl.ts` の `updateShadowUniforms`）
   */
  setEnabled(on: boolean): void
  /**
   * 実行時に影マップを張り替える。
   *
   * **0 を `mapSize` へ渡さない。**`low` の `aircraftShadowMapSize` は 0 で、
   * 0×0 のテクスチャは作られない。`createBindGroup` が
   * `undefined.mipLevelCount` を読んで落ち、**描画ループごと止まる**
   * （段 20c で実測。降格を止めると 2,216 フレーム回るのに、
   * 降格を許すと約 450 フレームで死ぬ）。
   *
   * 0 のときは大きさを据え置いて `setEnabled(false)` で遮らなくする。
   * 旧経路の `aircraftShadow.ts` の `setQuality` が手本で、あちらは
   * `Math.max(1, size)` で下限を切り、`shadow.map` を捨てて作り直させる。
   * **移植でその両方が落ちていた。**大きさを変えても作り直さないので、
   * 落ちない側の降格でも解像度が効いていなかった
   */
  setQuality(quality: QualitySettings): void
}

export function configureNodeAircraftShadow(
  input: NodeAircraftShadowInput,
): NodeAircraftShadow {
  const { renderer, light, quality } = input

  if (quality.aircraftShadowMapSize === 0) {
    light.castShadow = false
    return {
      shade: float(1) as unknown as Node<'float'>,
      enabled: false,
      // 立てていないので実行時に触るものが無い。**黙って無視する形にしない**
      setEnabled() {},
      setQuality() {},
    }
  }

  // **組み立てのあいだは伏せる。**理由は本文の注記
  light.castShadow = false
  light.position
    .copy(input.sunDirectionWorld)
    .multiplyScalar(AIRCRAFT_SHADOW_DISTANCE)
    .add(input.center)
  light.target.position.copy(input.center)

  let size = quality.aircraftShadowMapSize
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

  // 実行時の切り替えは uniform で行う。ノードを組み直さない
  const enabledFactor = uniform(1)
  const shadowNode = shadow(light as never)
  const shade = mix(
    float(1),
    shadowNode as never,
    enabledFactor as never,
  ) as unknown as Node<'float'>

  return {
    shade,
    enabled: true,
    setEnabled(on) {
      enabledFactor.value = on ? 1 : 0
    },
    setQuality(next) {
      renderer.shadowMap.type = shadowMapType(next)
      // **0 は据え置く。**0×0 の影マップは作られず、束縛が undefined になる
      const wanted = next.aircraftShadowMapSize
      this.setEnabled(wanted > 0)
      if (wanted === 0 || wanted === size) return
      size = wanted
      light.shadow.mapSize.set(size, size)
      // 大きさを変えたらテクスチャを作り直させる。旧経路と同じ一手
      light.shadow.map?.dispose()
      light.shadow.map = null
    },
  }
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
