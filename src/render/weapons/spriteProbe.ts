import {
  Color,
  DoubleSide,
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
import {
  CORE_CUT,
  RADIAL_SPRITE_FRAGMENT,
  RADIAL_SPRITE_VERTEX,
} from './radialSprite'

/**
 * 円形スプライトを固定の入力で焼いて読み戻す。TSL 版との突き合わせ専用。
 *
 * **ここが唯一の定義。**両方の経路がこの値を読む。断片は `vUv` だけの関数
 * なので、全画面のクアッドへ焼けば場面を組まずに比べられる。
 *
 * **three にも DOM にも依存しない値だけを外に出す。**焼く側は
 * `WebGLRenderer` を受け取る。
 */

/** 焼く大きさ。円が縁まで入る奇数でない一辺にする */
export const SPRITE_PROBE_SIDE = 64

/**
 * 色と濃さと落ち方。
 *
 * 濃さは `CORE_CUT`（0.5）を跨ぐ値にする。**下回ると芯の枝が全部捨てられ、
 * `OPAQUE_CORE` の側が真っ白な絵どうしの比較になる**
 */
export const SPRITE_PROBE_COLOR = { r: 0.92, g: 0.55, b: 0.2 } as const
export const SPRITE_PROBE_OPACITY = 0.8
export const SPRITE_PROBE_FALLOFF = 1.8

/** 芯の枝を通す濃さになっているか。検査で使う */
export function spriteProbeCrossesCoreCut(): boolean {
  // 中心（d = 0）の a は opacity そのもの
  return SPRITE_PROBE_OPACITY > CORE_CUT
}

/** 焼いた絵のうち、捨てられていない画素の数を数える */
export function spriteDrawnPixels(bytes: ArrayLike<number>): number {
  let drawn = 0
  for (let i = 0; i < bytes.length / 4; i++) {
    if (bytes[i * 4 + 3]! > 0) drawn++
  }
  return drawn
}

/**
 * GLSL 版を 1 枚焼いて読み戻す。
 *
 * 合成も深度も切る。**断片が出した値をそのまま比べる**ため
 */
export function renderSpriteProbe(
  renderer: WebGLRenderer,
  opaqueCore: boolean,
): number[] {
  const side = SPRITE_PROBE_SIDE
  const material = new ShaderMaterial({
    uniforms: {
      uColor: {
        value: new Color(
          SPRITE_PROBE_COLOR.r,
          SPRITE_PROBE_COLOR.g,
          SPRITE_PROBE_COLOR.b,
        ),
      },
      uOpacity: { value: SPRITE_PROBE_OPACITY },
      uFalloff: { value: SPRITE_PROBE_FALLOFF },
    },
    vertexShader: RADIAL_SPRITE_VERTEX,
    fragmentShader: RADIAL_SPRITE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    ...(opaqueCore
      ? { defines: { OPAQUE_CORE: '1', CORE_CUT: CORE_CUT.toFixed(2) } }
      : {}),
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
