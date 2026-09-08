import { Discard, Fn, float, length, max, pow, uniform, uv, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import { AdditiveBlending, Color, DoubleSide, NormalBlending } from 'three'
import {
  ALPHA_CUT,
  CORE_CUT,
  type RadialSpriteMaterial,
  type RadialSpriteOptions,
} from './radialSprite'

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

/**
 * node 経路の円形スプライト。`createGlRadialSprite` と同じ口を返す。
 *
 * **`fragmentNode` は使わない。**断片を丸ごと置き換えると、材質の出力を
 * レンダラが整える段（出力の色空間と un/premultiply）を跨いでしまう。
 * `colorNode` と `opacityNode` に分けて渡せば、GLSL 版の
 * `gl_FragColor = vec4(uColor, a)` と同じ位置に収まる。
 *
 * 色と不透明度は `uniform()` の器で持つ。GLSL 版の `uniforms` と違い、
 * ノードそのものが値を抱えるので、setter は器の中身を書き換える。
 *
 * `Discard` は断片のノードの中にある。**両方から参照しても本体は 1 度しか
 * 生成されない**ので、捨てる判定が二重に走ることはない。
 */
export function createNodeRadialSprite(options: RadialSpriteOptions): RadialSpriteMaterial {
  const opaqueCore = options.opaqueCore ?? false
  // **複製する。**参照のまま入れるとスロット全部が同じ器を指す
  const color = uniform(options.color.clone())
  const opacity = uniform(0)
  const falloff = uniform(options.falloff)

  const rgba = radialSpriteFragmentNode(
    {
      color: color as unknown as Node<'vec3'>,
      opacity: opacity as unknown as Node<'float'>,
      falloff: falloff as unknown as Node<'float'>,
    },
    opaqueCore,
  )

  const material = new MeshBasicNodeMaterial()
  material.colorNode = rgba.rgb
  material.opacityNode = rgba.a
  material.transparent = true
  material.blending = options.additive ? AdditiveBlending : NormalBlending
  // 不透明な芯だけ深度を書く。理由は `CORE_CUT` の節（`docs/weapons.md`）
  material.depthWrite = opaqueCore
  material.side = DoubleSide

  return {
    material,
    setColor(next) {
      ;(color.value as Color).copy(next)
    },
    setOpacity(value) {
      opacity.value = value
    },
  }
}
