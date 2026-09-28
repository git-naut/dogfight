import type { Texture } from 'three'
import { Fn, cameraFar, cameraNear, clamp, perspectiveDepthToViewZ, positionView, screenUV, texture } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * 場面の物に隠される割合（段 29c、node 経路）。1 で見える、0 で隠れる。
 *
 * **爆発は場面のパスの外で描く。**場面のパスで描くと、深度を書かない爆発の画素に
 * 下の物の深度で霞が掛かる。296 m 先の煙の下半分が、数 km 先の海面の霞に埋もれて
 * 海の色になり、水平線でまっすぐ切れた。爆発だけを別のパスで描いて霞の後ろに
 * 重ねるので、地形や機体に隠される判定はここで自前に持つ。
 *
 * 場面の深度と断片の深度を視点空間の距離で比べ、`soft` m かけて消す（ソフト
 * パーティクル）。板が地形を跨ぐ所で、切り口が直線にならない。空（深度 1）は
 * 遠平面の距離になるので、いつも見える。
 *
 * **深度は素の `texture()` で引く。**`pass.getTextureNode('depth')` を材質へ渡すと、
 * 材質を焼くたびに場面がもう 1 度描かれる（`cloudsNodePass.ts` と同じ約束）
 */
export type OcclusionFactory = () => Node<'float'>

/** 隠れ始めから隠れ切るまでの距離 m */
export const OCCLUSION_SOFT = 4

export function sceneOcclusion(depthTexture: Texture, soft = OCCLUSION_SOFT): OcclusionFactory {
  // 材質ごとに式を組む。1 つの節を複数の材質で共有しない
  return () =>
    Fn(() => {
      const depth = texture(depthTexture, screenUV).r
      const sceneZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar)
      // 視点空間の z は負。手前の物ほど大きい。断片が場面より手前なら正
      return clamp(positionView.z.sub(sceneZ).div(soft), 0, 1)
    })() as unknown as Node<'float'>
}
