import { Discard, Fn, float, length, max, pow, uv, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { ALPHA_CUT, CORE_CUT } from './radialSprite'

/**
 * 円形スプライトの色と不透明度を TSL で書く。
 *
 * `radialSprite.ts` の GLSL の写し。**`#ifdef OPAQUE_CORE` はリポジトリで
 * 唯一の `defines` だった。**TSL には前処理が無いので、JS の分岐で別の枝を
 * 組み立てる。生成時に決まるので、GLSL の `#ifdef` と同じく実行時の分岐は
 * 残らない。
 *
 * `discard` は `Discard(条件)` の 1 行になる。
 */
export interface RadialSpriteInputs {
  color: Node<'vec3'>
  opacity: Node<'float'>
  falloff: Node<'float'>
}

export function radialSpriteFragmentNode(
  inputs: RadialSpriteInputs,
  opaqueCore: boolean,
): Node<'vec4'> {
  return Fn(() => {
    // 中心からの距離。0.5 で縁
    const d = length(uv().sub(0.5)).mul(2).toVar()
    Discard(d.greaterThan(1))

    const a = pow(max(float(0), float(1).sub(d)), inputs.falloff)
      .mul(inputs.opacity)
      .toVar()
    Discard(a.lessThan(ALPHA_CUT))

    if (opaqueCore) {
      // 芯は不透明にして深度を書く。縁は捨てる
      Discard(a.lessThan(CORE_CUT))
      return vec4(inputs.color, 1)
    }
    return vec4(inputs.color, a)
  })()
}
