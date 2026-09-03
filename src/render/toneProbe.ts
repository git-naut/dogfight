import {
  GLSL3,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { DEFAULT_EXPOSURE } from './pipeline/types'

/**
 * トーンマッピングを GLSL 版と TSL 版で突き合わせる。
 *
 * 計画は「AgX は式が同じで、露出 6 はそのまま持ち越せる」と書いている。
 * **持ち越せるなら VFX の色定数を測り直さずに済む**ので、段 17 の入口で
 * 確かめる。
 *
 * 既定の経路は `postprocessing` の `ToneMappingEffect` を通すが、AGX モードは
 * `AgXToneMapping(texel)` を呼ぶだけで、実体は three の GLSL チャンク
 * （`tonemapping_pars_fragment`）。**比べるのは three の GLSL 版と TSL 版。**
 *
 * 露出の渡し方だけが違う。GLSL は `toneMappingExposure` の uniform を関数の
 * 中で読み、TSL は `agxToneMapping(color, exposure)` の引数で受ける。
 */

/** 標本の格子の一辺。32x32 で 1,024 段 */
export const TONE_PROBE_SIDE = 32
export const TONE_PROBE_COUNT = TONE_PROBE_SIDE * TONE_PROBE_SIDE

/** 露出。本番の既定と同じ */
export const TONE_PROBE_EXPOSURE = DEFAULT_EXPOSURE

/**
 * 入れる放射輝度の範囲。10^-3 から 10^2 まで。
 *
 * **暗部から白飛びまで通す。**AgX は暗い側で対数、明るい側で肩を持つので、
 * 狭い範囲だけ見ると曲線の写し間違いが埋もれる
 */
export const TONE_PROBE_MIN_LOG = -3
export const TONE_PROBE_MAX_LOG = 2

/** 色の比。3 成分が別々に通ることを見るため等しくしない */
export const TONE_PROBE_RATIO = { r: 1, g: 0.8, b: 0.6 } as const

/** 標本の番号から入れる放射輝度を出す。GPU 側も同じ式で導く */
export function toneProbeValue(index: number): {
  r: number
  g: number
  b: number
} {
  const t = index / (TONE_PROBE_COUNT - 1)
  const v = Math.pow(10, TONE_PROBE_MIN_LOG + (TONE_PROBE_MAX_LOG - TONE_PROBE_MIN_LOG) * t)
  return {
    r: v * TONE_PROBE_RATIO.r,
    g: v * TONE_PROBE_RATIO.g,
    b: v * TONE_PROBE_RATIO.b,
  }
}

/**
 * 焼いた絵が階調を使い切っているか。
 *
 * **全部 0 か全部 255 なら、曲線を間違えても一致してしまう。**返すのは
 * R 成分の相異なる値の数
 */
export function toneProbeLevels(bytes: ArrayLike<number>): number {
  const seen = new Set<number>()
  for (let i = 0; i < bytes.length / 4; i++) seen.add(bytes[i * 4]!)
  return seen.size
}

/** GLSL 版を 1 枚焼いて読み戻す */
export function renderToneProbe(renderer: WebGLRenderer): number[] {
  const side = TONE_PROBE_SIDE
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { toneMappingExposure: { value: TONE_PROBE_EXPOSURE } },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <tonemapping_pars_fragment>
      in vec2 vUv;
      out vec4 fragColor;
      const float SIDE = ${side}.0;
      const float COUNT = ${TONE_PROBE_COUNT}.0;
      void main() {
        float col = floor(vUv.x * SIDE);
        float row = floor(vUv.y * SIDE);
        float index = row * SIDE + col;
        float t = index / (COUNT - 1.0);
        float v = pow(10.0, ${TONE_PROBE_MIN_LOG}.0 + ${TONE_PROBE_MAX_LOG - TONE_PROBE_MIN_LOG}.0 * t);
        vec3 hdr = v * vec3(${TONE_PROBE_RATIO.r}, ${TONE_PROBE_RATIO.g}, ${TONE_PROBE_RATIO.b});
        fragColor = vec4(AgXToneMapping(hdr), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  })

  const scene = new Scene()
  const geometry = new PlaneGeometry(2, 2)
  scene.add(new Mesh(geometry, material))
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const target = new WebGLRenderTarget(side, side, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const previous = renderer.getRenderTarget()
  const buffer = new Uint8Array(side * side * 4)
  try {
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, side, side, buffer)
  } finally {
    renderer.setRenderTarget(previous)
    geometry.dispose()
    material.dispose()
    target.dispose()
  }
  return [...buffer]
}
