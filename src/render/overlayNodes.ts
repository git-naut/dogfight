import { Fn, If, float, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * 雲を大気へ差し込む合成を TSL で書く。
 *
 * `AerialPerspectiveNode` に `overlay` が無いので、GLSL 版
 * （`aerialPerspectiveEffect.frag:283-289, 387-389`）から写して自前に持つ。
 * 写した 2 か所の原本との照合は `overlayProbe.ts` の文字列と
 * `tests/render/overlayProbe.test.ts` が担う。
 *
 * **下地を関数で受ける。**GLSL 版は雲が完全不透明なら `return` で抜けて
 * 大気を 1 度も計算しない。TSL でこれを再現するには
 * `aerialPerspective(...)` の参照が `Else` の中だけに現れる必要がある。
 * 値で受け取ると呼び出し側で先に組み立てられ、`.toVar()` が外へ出て
 * 稼ぎが消える。**関数で受ければ、組み立てる場所が `Else` の中に決まる。**
 */

export interface OverlayCompositeOptions {
  /**
   * 枝のマーカーを出すか。
   *
   * 早期打ち切りが赤 (255,0,0)、合成が緑 (0,255,0)。**合成の結果では枝を
   * 数えられない。**`overlay.a == 1` の画素は、打ち切っても打ち切らなくても
   * `base * 0 + overlay.rgb` で同じ値になるため。JS の分岐なので生成時に
   * 決まり、実行時の分岐は残らない（段 16 の `OPAQUE_CORE` と同じ形）
   */
  marker?: boolean
}

/**
 * 雲を大気の結果へ重ねる。
 *
 * @param overlay 雲。rgb は前乗算、a が被覆率
 * @param base 大気の結果を組み立てる関数。**`Else` の中でだけ呼ばれる**
 */
export function overlayCompositeNode(
  overlay: Node<'vec4'>,
  base: () => Node<'vec4'>,
  options: OverlayCompositeOptions = {},
): Node<'vec4'> {
  const marker = options.marker ?? false
  return Fn(() => {
    // 1 度だけ引く。GLSL 版の `vec4 overlay = texture(overlayBuffer, uv);`
    const cloud = overlay.toVar()
    const out = vec4(0).toVar()

    If(cloud.a.equal(1), () => {
      // `outputColor = overlay; return;` にあたる。アルファも雲のものを使う
      out.assign(marker ? vec4(1, 0, 0, 1) : cloud)
    }).Else(() => {
      // **ここでだけ大気を組み立てる。**外へ出すと早期打ち切りの意味が消える
      const atmosphere = base().toVar()
      // `outputColor.rgb * (1.0 - overlay.a) + overlay.rgb` の順で書く。
      // 掛けてから足す順序を変えると丸めが動く
      const composited = atmosphere.rgb
        .mul(float(1).sub(cloud.a))
        .add(cloud.rgb)
      out.assign(marker ? vec4(0, 1, 0, 1) : vec4(composited, atmosphere.a))
    })

    return out
  })() as Node<'vec4'>
}
