import { DoubleSide } from 'three'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import type { OcclusionFactory } from './sceneOcclusion'

/**
 * 爆発の白い煙の尾の材質（段 29f、node 経路）。
 *
 * 色と濃さは頂点の色から取る（`Ribbon` が rgba で書く）。`opacityNode` は頂点の
 * アルファに**掛かる**ので（`NodeMaterial.setupDiffuseColor`）、場面の物に隠される
 * 割合をそのまま渡す。尾は爆発と同じ霞の後ろのパスで描く（`explosionTrails.ts`）
 */
export function createNodeTrailMaterial(occlusion: OcclusionFactory): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.color.set(0xffffff)
  material.vertexColors = true
  material.transparent = true
  material.depthWrite = false
  material.side = DoubleSide
  material.opacityNode = occlusion() as unknown as Node<'float'>
  return material
}
