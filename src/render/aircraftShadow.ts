import * as THREE from 'three'
import type { QualitySettings } from './quality'

/**
 * 機体の影。
 *
 * 影マップ 1 枚で自己遮蔽と対地影の両方をまかなう。遮蔽物が機体だけなので、
 * 機体を囲む正射影の箱を太陽方向へ長く伸ばせば足りる。カスケードは要らない。
 *
 * 機体は `MeshStandardMaterial` なので three の影がそのまま効く。地形と海面は
 * 自前シェーダなので、同じ深度テクスチャと行列を渡して参照を足す
 * （`heightfield.glsl` の `terrainShadow`）。
 *
 * 影マップの種類は `BasicShadowMap`。深度テクスチャに比較モードを付けさせない
 * ため。理由は下の `renderer.shadowMap.type` のところに書いてある。
 */

/** 正射影の箱の半幅 m。機体は全長 17.8 m・翼幅 11.6 m */
const HALF_EXTENT = 14

/** 光源を機体からどれだけ離すか m。近すぎると箱の手前で切れる */
const LIGHT_DISTANCE = 400

/**
 * 高さ場の最も深いところ m。影の far 面を決めるのに使う。
 *
 * 地形は海面下 320 m まで下がる（src/sim/terrain.ts の SEABED_HEIGHT）。
 * 少し余裕を足す。
 */
const SEABED_MARGIN = 400

/**
 * 影が届く距離の上限 m。
 *
 * 太陽高度が低いと光路が伸びる。高度 2,000 m・太陽高度 10 度で 11.5 km。
 * 深度は正射影なので線形で、Float32 なら 14 km でも精度は足りる。
 */
const MAX_REACH = 14_000

export interface AircraftShadow {
  readonly enabled: boolean
  /** 影マップが焼けているか。1 フレーム目は false */
  readonly ready: boolean
  /**
   * 影の深度テクスチャ。
   *
   * 最初の描画までは形だけ合わせた 1x1 の代わりを返す。null を返すと
   * three が RGBA を束縛して型が食い違う
   */
  readonly depthTexture: THREE.Texture
  /** world から影の UV と深さへ写す行列 */
  readonly matrix: THREE.Matrix4
  /**
   * 機体の位置と太陽の向きに合わせる。毎フレーム呼ぶ。
   *
   * @param center 機体の位置
   * @param sunDirection 太陽へ向かう単位ベクトル
   */
  update(center: THREE.Vector3, sunDirection: THREE.Vector3): void
  setQuality(quality: QualitySettings): void
}

/**
 * 影を投げる光源。
 *
 * `SunDirectionalLight`（@takram/three-atmosphere）は target からの距離を
 * `distance` で持つ。ライブラリの型を直接持ち込まず、必要な形だけ書く。
 */
export interface ShadowLight extends THREE.DirectionalLight {
  distance: number
}

export interface AircraftShadowOptions {
  renderer: THREE.WebGLRenderer
  light: ShadowLight
  /** 影を落とす対象。機体そのもの */
  caster: THREE.Object3D
  quality: QualitySettings
}

/**
 * 影マップができるまでの代わり。
 *
 * null を渡すと three は 1x1 の白い RGBA を束縛する。深度テクスチャを想定した
 * サンプラに RGBA が来ると型が食い違い、そのドローコールが捨てられる。
 * 1 フレーム目だけの話だが、形の合う空のテクスチャを置いておく。
 */
function createPlaceholderDepth(): THREE.DepthTexture {
  const texture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  texture.format = THREE.DepthFormat
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  return texture
}

export function createAircraftShadow(
  options: AircraftShadowOptions,
): AircraftShadow {
  const { renderer, light, caster } = options
  let size = options.quality.aircraftShadowMapSize
  const placeholder = createPlaceholderDepth()

  renderer.shadowMap.enabled = size > 0
  /**
   * `BasicShadowMap` を使う。深度テクスチャに比較モードを付けさせないため。
   *
   * `PCFShadowMap` は深度テクスチャに `compareFunction` を付ける
   * （`WebGLShadowMap.js` の 263 行目）。すると `sampler2DShadow` でしか
   * 引けなくなり、地形と海面の自前シェーダから素直に読めない。実測で
   * `GL_INVALID_OPERATION: Mismatch between texture format and sampler type` が
   * 出て、そのドローコールごと捨てられた（地形が丸ごと消えた）。
   *
   * `BasicShadowMap` なら比較モードが付かず、ただの深度テクスチャとして
   * 引ける。縁が硬くなるが、地形側は自前で 2x2 の平均を取るので目立たない。
   * 機体の自己遮蔽は 28 m の箱を 1024 px で割って 2.7 cm/テクセルなので、
   * 硬くても画面上では分からない。
   *
   * `PCFSoftShadowMap` は three 0.185 で廃止されていて、指定すると警告を出して
   * `PCFShadowMap` へ倒れる。倒れた先で上の問題を踏んだ。
   */
  renderer.shadowMap.type = THREE.BasicShadowMap

  light.castShadow = size > 0
  light.shadow.mapSize.set(Math.max(1, size), Math.max(1, size))
  // 箱の中心が機体なので、光源はそのぶん手前に置く
  light.distance = LIGHT_DISTANCE

  const camera = light.shadow.camera
  camera.left = -HALF_EXTENT
  camera.right = HALF_EXTENT
  camera.top = HALF_EXTENT
  camera.bottom = -HALF_EXTENT
  camera.near = 1
  camera.far = LIGHT_DISTANCE + MAX_REACH
  camera.updateProjectionMatrix()

  // 影の縞（自分の面に自分の影が乗る）を抑える。正射影の 28 m を 1024 px で
  // 割ると 1 テクセル 2.7 cm。法線方向へ 5 cm ずらせば足りる
  light.shadow.bias = -0.0005
  light.shadow.normalBias = 0.05

  caster.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    node.castShadow = true
    // 自己遮蔽。主翼が胴体に落とす影が出る
    node.receiveShadow = true
  })

  return {
    get enabled() {
      return size > 0
    },

    get ready() {
      return size > 0 && light.shadow.map !== null
    },

    get depthTexture() {
      return light.shadow.map?.depthTexture ?? placeholder
    },

    matrix: light.shadow.matrix,

    update(center, sunDirection) {
      if (size === 0) return
      // 箱の中心を機体に置く。太陽光の位置は atmosphere.update() が
      // target + sunDirection * distance で決めるので、target だけ動かす
      light.target.position.copy(center)
      light.target.updateMatrixWorld()

      // 太陽高度が低いほど光路が伸びる。届く距離を高度から決める。
      //
      // 余裕を取らないと影が落ちる地点がちょうど far 面に来て、深度が 1.0 を
      // 超えて弾かれる。実測でそれが起きて、海面にまったく影が出なかった。
      // 地形は海面下 320 m まであるので、その下まで見ておく
      const elevation = Math.max(0.05, sunDirection.y)
      const drop = center.y + SEABED_MARGIN
      const reach = Math.min(MAX_REACH, LIGHT_DISTANCE + drop / elevation + 200)
      if (camera.far !== reach) {
        camera.far = reach
        camera.updateProjectionMatrix()
      }
    },

    setQuality(quality) {
      if (quality.aircraftShadowMapSize === size) return
      size = quality.aircraftShadowMapSize
      renderer.shadowMap.enabled = size > 0
      light.castShadow = size > 0
      light.shadow.mapSize.set(Math.max(1, size), Math.max(1, size))
      // 解像度を変えたらテクスチャを作り直させる
      light.shadow.map?.dispose()
      light.shadow.map = null
    },
  }
}
