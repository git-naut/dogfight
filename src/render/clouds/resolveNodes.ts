import {
  Fn,
  If,
  abs,
  clamp,
  float,
  max,
  min,
  mix,
  normalize,
  uv,
  vec2,
  vec4,
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'
import {
  CLOUD_BOTTOM,
  CLOUD_TOP,
  RESOLVE_FALLBACK_DISTANCE,
  RESOLVE_FAR_CLAMP,
  RESOLVE_SLAB_MIX,
} from './geometry'

/**
 * 雲のマーチ結果をフレーム間で足し込む TSL 版。
 *
 * `shaders/cloudResolve.frag` の写し。**式を 1 つずつ写す。**定数は
 * `geometry.ts` から取り、`tests/render/densityConstants.test.ts` が GLSL の
 * 本文と突き合わせる。
 *
 * `previousCameraPosition` は移していない。GLSL 側で宣言されて毎フレーム
 * 代入されていたが、**本文が一度も読んでいなかった。**移植のついでに
 * 落とした（絵は動かない。`npm run exact` で確かめた）。
 */

/**
 * 引き方は three に任せる。
 *
 * 入力は `rtt()` か `texture()` が返す `TextureNode` で、`.sample(uv)` が
 * 公式の引き方（`examples/jsm/tsl/utils/TAAUtils.js` も
 * `previousDepthNode.sample( uv )` と書く）。`TextureNode.setupUV()` が
 * `isRenderTargetTexture` を見て、WebGL2（`isFlipY()` が true）と WebGPU
 * （false）の並びの差を吸収する。
 *
 * **手で `1 - v` を掛けない。**掛けると WebGPU でだけ二重になる。
 * 旧経路（GLSL 版）とのビット一致は基準から外した（2026-09-14）。
 */

/**
 * レンダーターゲットを「書いたときと同じ位置」で引く。
 *
 * **手で裏返す。**`TextureNode.setupUV()` は `isFlipY()` を見るが
 * `WGSLNodeBuilder` では false なので WebGPU では何もしない。全画面
 * クアッドをレンダーターゲットへ描く時点で上下が入れ替わっているので、
 * 読む側で戻す。
 *
 * 2026-09-14 に「three に任せる」で外したが、**バンク中の同じフレームを
 * 両経路で撮ると上下が反転していた**（暗い雲の塊が旧経路で画面左下、
 * node で左上）。反転した絵はロールに対して逆向きに回るので、「機体を
 * 傾けた同じ量の方向に雲が動く」という報告になる。
 */
function sampleTarget(source: TextureNode, at: Node<'vec2'>): Node<'vec4'> {
  return source.sample(vec2(at.x, float(1).sub(at.y)))
}

export interface ResolveInputs {
  /** 現フレームのマーチ結果。`rtt()` の戻り値 */
  currentFrame: TextureNode
  /** 前フレームまでの蓄積。ping-pong なので自前の的 */
  historyFrame: TextureNode
  inverseProjectionMatrix: Node<'mat4'>
  inverseViewMatrix: Node<'mat4'>
  previousViewProjection: Node<'mat4'>
  cameraPositionWorld: Node<'vec3'>
  /**
   * 現フレームを混ぜる割合。1 なら履歴を使わない。
   *
   * **JS の定数にしない。**キャプチャは `1 / (n + 1)` で真の平均を取るので
   * フレームごとに変わる
   */
  blendWeight: Node<'float'>
  /** テクセルの大きさ。近傍を舐めるのに使う */
  texelSize: Node<'vec2'>
  /**
   * 近傍で挟む幅の倍率。0 なら挟まない。
   *
   * **JS の定数で畳む。**組み立てのときに決まって以後変わらないので、
   * 3x3 を舐める枝ごと消せる
   */
  clampScale: number
  /**
   * `prevUv` を色として出すか。**JS の定数で畳む。**
   *
   * 両経路で座標を数値で突き合わせるために要る。絵の印象では座標のずれが
   * 読めず、上下反転の切り分けで何度も外した（2026-09-14）
   */
  uvProbe?: boolean | 'world'
}

/**
 * 視線と雲層の交わり。再投影に使う代表距離を返す。
 *
 * TSL は値を返す早期 return を持たないので、既定値を入れた var を素通り
 * させる形で写す。通る経路は同じになる
 */
function slabDistance(
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
): Node<'float'> {
  return Fn(() => {
    const result = float(RESOLVE_FALLBACK_DISTANCE).toVar()
    const dirY = direction.y.toVar()

    If(abs(dirY).greaterThanEqual(1e-5), () => {
      const toBottom = float(CLOUD_BOTTOM).sub(origin.y).div(dirY).toVar()
      const toTop = float(CLOUD_TOP).sub(origin.y).div(dirY).toVar()
      const near = max(min(toBottom, toTop), 0).toVar()
      const far = max(toBottom, toTop).toVar()

      If(far.greaterThan(0), () => {
        // 区間の手前寄りを代表点にする。雲は入り口の付近に濃さが集まる
        result.assign(
          mix(near, min(far, RESOLVE_FAR_CLAMP), float(RESOLVE_SLAB_MIX)),
        )
      })
    })

    return result
  })()
}

export function cloudResolveFragmentNode(inputs: ResolveInputs): Node<'vec4'> {
  return Fn(() => {
    const pixelUv = uv().toVar()
    const current = sampleTarget(inputs.currentFrame, pixelUv).toVar()
    const result = vec4(current).toVar()

    If(inputs.blendWeight.lessThan(1), () => {
      // 画素のワールド方向
      const clip = vec4(pixelUv.mul(2).sub(1), -1, 1)
      const viewPos = inputs.inverseProjectionMatrix.mul(clip).toVar()
      viewPos.divAssign(viewPos.w)
      const rayDirection = normalize(
        inputs.inverseViewMatrix.mul(vec4(viewPos.xyz, 0)).xyz,
      ).toVar()

      // 代表点を前フレームの画面へ投影する
      const world = inputs.cameraPositionWorld
        .add(
          rayDirection.mul(slabDistance(inputs.cameraPositionWorld, rayDirection)),
        )
        .toVar()
      const prevClip = inputs.previousViewProjection.mul(vec4(world, 1)).toVar()

      If(prevClip.w.greaterThan(0), () => {
        const prevUv = prevClip.xy.div(prevClip.w).mul(0.5).add(0.5).toVar()

        // 画面の外へ出た履歴は使えない
        const outside = prevUv.x
          .lessThan(0)
          .or(prevUv.y.lessThan(0))
          .or(prevUv.x.greaterThan(1))
          .or(prevUv.y.greaterThan(1))

        // **TSL に早期 return が無い。**`Return()` は値を返さない
        // （`expression('return')`）。プローブの代入だけを置くと、後続の
        // `If(outside.not(), ...)` が同じ `result` を上書きする。**実測で
        // B が 0/255 ではなく 115 になり、プローブ自体が壊れていた。**
        // 枝ごと JS で分ける
        if (inputs.uvProbe === 'world') {
          // **代表点そのものを見る。**`prevUv` がずれる前の段階で
          // 食い違っていれば、原因は光線か slab の側にある。
          // 10 km で割って 0..1 へ詰める
          result.assign(
            vec4(
              clamp(world.x.div(10000).add(0.5), 0, 1),
              clamp(world.y.div(10000), 0, 1),
              clamp(world.z.div(10000).add(0.5), 0, 1),
              1,
            ),
          )
        } else if (inputs.uvProbe === true) {
          // **8 ビットへ詰める。**RG に prevUv、B に「画面内か」
          result.assign(
            vec4(
              clamp(prevUv.x, 0, 1),
              clamp(prevUv.y, 0, 1),
              outside.select(float(0), float(1)),
              1,
            ),
          )
        } else
        If(outside.not(), () => {
          const history = sampleTarget(inputs.historyFrame, prevUv).toVar()

          if (inputs.clampScale > 0) {
            // 近傍の最小最大で挟む。挟まないと雲の縁で古い値が尾を引く。
            // 9 通りは定数なので JS で展開する。中心は飛ばす
            const minColor = vec4(current).toVar()
            const maxColor = vec4(current).toVar()
            for (let y = -1; y <= 1; y++) {
              for (let x = -1; x <= 1; x++) {
                if (x === 0 && y === 0) continue
                const s = sampleTarget(
                  inputs.currentFrame,
                  pixelUv.add(vec2(x, y).mul(inputs.texelSize)),
                )
                minColor.assign(min(minColor, s))
                maxColor.assign(max(maxColor, s))
              }
            }
            // 中心から広げて挟む。狭いと平均の効果が消える
            const mid = minColor.add(maxColor).mul(0.5).toVar()
            const halfRange = maxColor
              .sub(minColor)
              .mul(0.5)
              .mul(inputs.clampScale)
              .toVar()
            history.assign(clamp(history, mid.sub(halfRange), mid.add(halfRange)))
          }

          result.assign(mix(history, current, inputs.blendWeight))
        })
      })
    })

    return result
  })()
}
