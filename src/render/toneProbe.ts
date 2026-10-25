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
 * three の `AgXToneMapping`（`tonemapping_pars_fragment`）を CPU へ写したもの。
 *
 * **GLSL 版を捨てたあとの突き合わせの相手。**TSL 版（`agxToneMapping`）と
 * 同じ式で、入出力はどちらも線形の sRGB。GLSL の `mat3(a, b, c)` は列で
 * 並ぶので、`M * v` は `a * v.x + b * v.y + c * v.z` になる
 */
export function agxToneMap(
  color: { r: number; g: number; b: number },
  exposure: number,
): [number, number, number] {
  type Vec = [number, number, number]
  const mul = (cols: readonly [Vec, Vec, Vec], v: Vec): Vec => [
    cols[0][0] * v[0] + cols[1][0] * v[1] + cols[2][0] * v[2],
    cols[0][1] * v[0] + cols[1][1] * v[1] + cols[2][1] * v[2],
    cols[0][2] * v[0] + cols[1][2] * v[1] + cols[2][2] * v[2],
  ]
  const srgbToRec2020: readonly [Vec, Vec, Vec] = [
    [0.6274, 0.0691, 0.0164],
    [0.3293, 0.9195, 0.088],
    [0.0433, 0.0113, 0.8956],
  ]
  const rec2020ToSrgb: readonly [Vec, Vec, Vec] = [
    [1.6605, -0.1246, -0.0182],
    [-0.5876, 1.1329, -0.1006],
    [-0.0728, -0.0083, 1.1187],
  ]
  const inset: readonly [Vec, Vec, Vec] = [
    [0.856627153315983, 0.137318972929847, 0.11189821299995],
    [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
    [0.0482516061458583, 0.101439036467562, 0.811302368396859],
  ]
  const outset: readonly [Vec, Vec, Vec] = [
    [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
    [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
    [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
  ]
  const minEv = -12.47393
  const maxEv = 4.026069
  const contrast = (x: number) => {
    const x2 = x * x
    const x4 = x2 * x2
    return (
      15.5 * x4 * x2 -
      40.14 * x4 * x +
      31.96 * x4 -
      6.868 * x2 * x +
      0.4298 * x2 +
      0.1191 * x -
      0.00232
    )
  }
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

  let c: Vec = [color.r * exposure, color.g * exposure, color.b * exposure]
  c = mul(inset, mul(srgbToRec2020, c))
  c = c.map((x) => contrast(clamp01((Math.log2(Math.max(x, 1e-10)) - minEv) / (maxEv - minEv)))) as Vec
  c = mul(outset, c)
  c = c.map((x) => Math.pow(Math.max(0, x), 2.2)) as Vec
  c = mul(rec2020ToSrgb, c)
  return c.map(clamp01) as Vec
}

/**
 * 焼いた絵の CPU 参照。標本の番号 i が読み戻しの i 番目の画素に入る
 * （断片シェーダは `row * SIDE + col` で番号を振り、読み戻しも下の行から並ぶ）。
 * 出力は線形のまま 8 ビットへ丸める。GPU とは 1 階調まで違いうる
 */
export function toneProbeExpected(): number[] {
  const out: number[] = []
  for (let i = 0; i < TONE_PROBE_COUNT; i++) {
    const [r, g, b] = agxToneMap(toneProbeValue(i), TONE_PROBE_EXPOSURE)
    out.push(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255)
  }
  return out
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
