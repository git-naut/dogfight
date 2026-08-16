import { HalfFloatType, type Camera, type Scene, type WebGLRenderer } from 'three'
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  type Effect,
} from 'postprocessing'
import type { QualitySettings } from './quality'
import type { CloudsPass } from './clouds/cloudsPass'

/**
 * ポストプロセスの構成。
 *
 * 大気散乱は放射輝度を扱うので、8bit のバッファでは階調が破綻する。
 * 浮動小数点バッファで受けて、最後にトーンマッピングで表示域へ落とす。
 *
 * パスの順序が意味を持つ。RenderPass でシーンを描き、EffectPass で
 * 遠景の霞をかけ、アンチエイリアスをかけ、最後にトーンマッピングする。
 */

export interface ComposerHandle {
  render(): void
  /** @param updateStyle canvas の CSS サイズも書き換えるか。既定は stylesheet 任せ */
  setSize(width: number, height: number, updateStyle?: boolean): void
  /** プリセットが変わったらエフェクトの構成を組み直す */
  setQuality(quality: QualitySettings): void
  dispose(): void
}

export interface ComposerOptions {
  renderer: WebGLRenderer
  scene: Scene
  camera: Camera
  /** 遠景の霞。@takram/three-atmosphere の AerialPerspectiveEffect */
  aerialPerspective: Effect
  /** 雲のレイマーチ。RenderPass の後、EffectPass の前に入る */
  cloudsPass?: CloudsPass
  quality: QualitySettings
}

export function createComposer(options: ComposerOptions): ComposerHandle {
  const { renderer, scene, camera, aerialPerspective } = options

  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType,
  })

  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)

  // 雲はシーンを描いたあと、大気の合成より前に焼く。
  // 結果は overlay 経由で EffectPass の中へ入る
  if (options.cloudsPass) composer.addPass(options.cloudsPass)

  // SMAA はプリセットで切り替わるので使い回す。破棄すると再構築が要る
  const smaa = new SMAAEffect()
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })

  let effectPass: EffectPass | null = null

  function buildEffectPass(quality: QualitySettings): void {
    if (effectPass !== null) {
      composer.removePass(effectPass)
      effectPass.dispose()
    }

    const effects: Effect[] = [aerialPerspective]
    if (quality.smaa) effects.push(smaa)
    // トーンマッピングは必ず最後。これより後ろに効果を足さない
    effects.push(toneMapping)

    effectPass = new EffectPass(camera, ...effects)
    composer.addPass(effectPass)
  }

  buildEffectPass(options.quality)

  return {
    render() {
      composer.render()
    },

    setSize(width, height, updateStyle = false) {
      composer.setSize(width, height, updateStyle)
    },

    setQuality(quality) {
      buildEffectPass(quality)
    },

    dispose() {
      effectPass?.dispose()
      renderPass.dispose()
      smaa.dispose()
      toneMapping.dispose()
      composer.dispose()
    },
  }
}
