import * as THREE from 'three'
import type { QualitySettings } from './quality'

/**
 * 環境反射を空から焼く。
 *
 * 機体は `MeshStandardMaterial` なので、金属の映り込みには環境マップが要る。
 * HDRI を取り込むと出典管理とライセンスが増えるうえ、時刻を変えても映り込みが
 * 変わらない。ここでは大気の空のクアッドを 6 面に描いて `PMREMGenerator` で
 * 放射照度マップにする。時刻を変えれば映り込みも一貫して変わる。
 *
 * 焼き直すのは時刻が変わったときだけ。毎フレームの費用はない。
 *
 * 空のクアッドは頂点シェーダが position をそのままクリップ座標として使う
 * 全画面のもの。どのカメラでも画面を埋め、フラグメント側がカメラ行列から
 * 視線方向を作る。だから `CubeCamera` の 6 面それぞれで正しい方向が出る。
 */

export interface EnvironmentProbe {
  /** `scene.environment` へ入れるテクスチャ。切ってあれば null */
  readonly texture: THREE.Texture | null
  /** 焼き直す。時刻が変わったときに呼ぶ */
  refresh(): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: EnvironmentProbe = {
  texture: null,
  refresh() {},
  setQuality() {},
  dispose() {},
}

export interface EnvironmentOptions {
  renderer: THREE.WebGLRenderer
  /** 空を含むシーン。焼くあいだ空以外は隠す */
  scene: THREE.Scene
  /** 空のクアッド。これだけを見せて焼く */
  sky: THREE.Object3D
  quality: QualitySettings
}

export function createEnvironmentProbe(options: EnvironmentOptions): EnvironmentProbe {
  const { renderer, scene, sky } = options
  let size = options.quality.environmentMapSize
  if (size === 0) return NOT_ENABLED

  let cubeTarget = new THREE.WebGLCubeRenderTarget(size, {
    // 空は放射輝度なので 8bit では階調が破綻する。雲のバッファで踏んだのと同じ
    type: THREE.HalfFloatType,
  })
  const cubeCamera = new THREE.CubeCamera(1, 100_000, cubeTarget)
  const pmrem = new THREE.PMREMGenerator(renderer)
  let baked: THREE.Texture | null = null

  /** 焼くあいだ空以外を隠す。地形や機体が映り込むと自己参照になる */
  function bake(): void {
    const hidden: THREE.Object3D[] = []
    for (const child of scene.children) {
      if (child === sky) continue
      if (!child.visible) continue
      child.visible = false
      hidden.push(child)
    }

    const previous = renderer.getRenderTarget()
    cubeCamera.update(renderer, scene)
    renderer.setRenderTarget(previous)

    for (const child of hidden) child.visible = true

    baked?.dispose()
    baked = pmrem.fromCubemap(cubeTarget.texture).texture
  }

  bake()

  return {
    get texture() {
      return baked
    },

    refresh() {
      bake()
    },

    setQuality(quality) {
      if (quality.environmentMapSize === size) return
      size = quality.environmentMapSize
      if (size === 0) return
      cubeTarget.dispose()
      cubeTarget = new THREE.WebGLCubeRenderTarget(size, {
        type: THREE.HalfFloatType,
      })
      cubeCamera.renderTarget = cubeTarget
      bake()
    },

    dispose() {
      baked?.dispose()
      cubeTarget.dispose()
      pmrem.dispose()
    },
  }
}
