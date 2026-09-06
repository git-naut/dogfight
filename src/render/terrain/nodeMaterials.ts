import {
  attribute,
  positionGeometry,
  positionWorld,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import type { Texture } from 'three'
import {
  terrainPatchWorldNode,
  terrainSurfaceNode,
  waterSurfaceNode,
  type IlluminanceProvider,
  type SurfaceInputs,
} from './surfaceNodes'
import { terrainHeightNode } from './heightNodes'
import type { TerrainMaterial } from './terrainMesh'
import type { WaterMaterial } from './water'
import type { QualitySettings } from '../quality'

/**
 * 地形と海面の node 経路の材質。
 *
 * **格子もインスタンスの属性もパッチの選び方も GLSL 経路と同じものを使う。**
 * 差し替わるのは材質だけで、`createTerrainMesh` と `createWater` が
 * 工場を受け取る形になっている。
 *
 * `MeshBasicNodeMaterial` を土台にする。ライティングは自前で組むので
 * three のライトは効かせない（GLSL 経路の `ShaderMaterial` と同じ立場）。
 * 段 17c で `getSplitIlluminance` へ置き換えるときにここが変わる。
 *
 * `terrainAircraftShade` は無い。node 経路の機体の影は `shadow(light)` が
 * 係数を返すので、そちらを引数で渡す（段 15 と ADR 0010）。
 */

export interface NodeSurfaceUniforms {
  /** sim が焼いた高さ場 */
  heightMap: Texture
  /** 焼いた法線 */
  terrainNormalMap: Texture
  /** 雲影マップ。焼く側で v を打ち消してある */
  cloudShadowMap: Texture
  extent: number
  texels: number
  cloudShadowExtent: number
}

/**
 * 毎フレーム動かす値。
 *
 * GLSL 経路の `TerrainSharedUniforms` にあたる。**帳簿が同じ値を
 * 2 か所へ書かないよう、地形と海面で共有する**
 */
export interface NodeSurfaceState {
  readonly inputs: SurfaceInputs
  setSunDirection(x: number, y: number, z: number): void
  setSunRadiance(x: number, y: number, z: number): void
  setSkyRadiance(x: number, y: number, z: number): void
  setCloudShadowCenter(x: number, z: number): void
  setCloudShadowEnabled(enabled: boolean): void
  /** 寄せる基準の位置。主カメラのワールド位置を入れる */
  setMorphOrigin(x: number, y: number, z: number): void
  readonly morphOrigin: Node<'vec3'>
  setDetailNormals(enabled: boolean): void
  readonly detailNormals: Node<'float'>
  setWaveTime(seconds: number): void
  readonly waveTime: Node<'float'>
  setWaterSpecular(enabled: boolean): void
  readonly waterSpecular: Node<'float'>
}

export function createNodeSurfaceState(
  textures: NodeSurfaceUniforms,
  quality: QualitySettings,
): NodeSurfaceState {
  const sunDirectionWorld = uniform(vec3(0, 1, 0))
  const sunRadiance = uniform(vec3(1, 1, 1))
  const skyRadiance = uniform(vec3(0.1, 0.12, 0.15))
  const cloudShadowCenter = uniform(vec2(0, 0))
  const cloudShadowEnabled = uniform(1)
  const morphOrigin = uniform(vec3(0, 0, 0))
  const detailNormals = uniform(quality.terrainDetailNormals ? 1 : 0)
  const waveTime = uniform(0)
  const waterSpecular = uniform(quality.waterSpecular ? 1 : 0)

  const inputs: SurfaceInputs = {
    heightMap: textures.heightMap,
    extent: textures.extent,
    texels: textures.texels,
    terrainNormalMap: textures.terrainNormalMap,
    cloudShadowMap: textures.cloudShadowMap,
    cloudShadowCenter: cloudShadowCenter as unknown as Node<'vec2'>,
    cloudShadowExtent: uniform(textures.cloudShadowExtent) as unknown as Node<'float'>,
    cloudShadowEnabled: cloudShadowEnabled as unknown as Node<'float'>,
    sunDirectionWorld: sunDirectionWorld as unknown as Node<'vec3'>,
    sunRadiance: sunRadiance as unknown as Node<'vec3'>,
    skyRadiance: skyRadiance as unknown as Node<'vec3'>,
  }

  return {
    inputs,
    setSunDirection(x, y, z) {
      sunDirectionWorld.value.set(x, y, z)
    },
    setSunRadiance(x, y, z) {
      sunRadiance.value.set(x, y, z)
    },
    setSkyRadiance(x, y, z) {
      skyRadiance.value.set(x, y, z)
    },
    setCloudShadowCenter(x, z) {
      cloudShadowCenter.value.set(x, z)
    },
    setCloudShadowEnabled(enabled) {
      cloudShadowEnabled.value = enabled ? 1 : 0
    },
    setMorphOrigin(x, y, z) {
      morphOrigin.value.set(x, y, z)
    },
    morphOrigin: morphOrigin as unknown as Node<'vec3'>,
    setDetailNormals(enabled) {
      detailNormals.value = enabled ? 1 : 0
    },
    detailNormals: detailNormals as unknown as Node<'float'>,
    setWaveTime(seconds) {
      waveTime.value = seconds
    },
    waveTime: waveTime as unknown as Node<'float'>,
    setWaterSpecular(enabled) {
      waterSpecular.value = enabled ? 1 : 0
    },
    waterSpecular: waterSpecular as unknown as Node<'float'>,
  }
}

/**
 * 地形の材質。
 *
 * `positionNode` にワールド座標をそのまま入れる。メッシュは変換を持たない
 * ので、模型行列は単位行列で `positionWorld` と一致する。GLSL 側が
 * `gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0)` と
 * 書いていたのと同じ経路になる。
 *
 * @param aircraftShade 機体の影の係数。`shadow(light)` を渡す。無ければ 1
 */
export function createTerrainNodeMaterial(
  state: NodeSurfaceState,
  aircraftShade: Node<'float'>,
  illuminance?: IlluminanceProvider,
): TerrainMaterial {
  const material = new MeshBasicNodeMaterial()

  // インスタンスの属性は GLSL 側と同じ名前で引く
  const patchInfo = attribute('patchOrigin', 'vec4') as unknown as Node<'vec4'>
  const patchMorph = attribute('patchMorph', 'vec2') as unknown as Node<'vec2'>
  // 0..1 の格子座標。`positionNode` を差し替えても、生の属性はこちらで読める
  const unitGrid = positionGeometry.xy as unknown as Node<'vec2'>

  const patch = terrainPatchWorldNode(
    unitGrid,
    patchInfo,
    patchMorph,
    state.morphOrigin,
  )
  const worldXZ = vec2(patch.x, patch.y)
  const world = vec3(
    patch.x,
    terrainHeightNode(state.inputs, worldXZ),
    patch.y,
  ) as unknown as Node<'vec3'>

  ;(material as unknown as { positionNode: unknown }).positionNode = world
  ;(material as unknown as { fragmentNode: unknown }).fragmentNode =
    terrainSurfaceNode(
      state.inputs,
      positionWorld as unknown as Node<'vec3'>,
      // 距離は主カメラから測る。**組み込みのカメラ位置を読まない**のは
      // 影を焼くパスで基準が変わるのを避けるため（頂点側と同じ理由）
      state.morphOrigin,
      state.detailNormals,
      aircraftShade,
      illuminance !== undefined ? { illuminance } : {},
    )

  return {
    material,
    setDetailNormals(enabled) {
      state.setDetailNormals(enabled)
    },
    dispose() {
      material.dispose()
    },
  }
}

/** 海面の材質。板は変換を持つので `positionWorld` を使う */
export function createWaterNodeMaterial(
  state: NodeSurfaceState,
  aircraftShade: Node<'float'>,
): WaterMaterial {
  const material = new MeshBasicNodeMaterial()
  ;(material as unknown as { fragmentNode: unknown }).fragmentNode =
    waterSurfaceNode(
      state.inputs,
      positionWorld as unknown as Node<'vec3'>,
      state.morphOrigin,
      state.waveTime,
      state.waterSpecular,
      aircraftShade,
    )

  return {
    material,
    setWaveTime(seconds) {
      state.setWaveTime(seconds)
    },
    setQuality(next) {
      state.setWaterSpecular(next.waterSpecular)
    },
    dispose() {
      material.dispose()
    },
  }
}

/**
 * 地表の色を矩形のプローブ用に組む。
 *
 * 場面の材質と同じ状態（同じテクスチャ・同じ放射輝度・同じ雲影）を使い、
 * 照度の出どころだけを差し替えられるようにする。**ライティングの置き換えで
 * 何が動くかは、場面のカメラではなく矩形で測る**（地表が画面をほとんど
 * 覆わない構図では差が出てこない）
 */
export function terrainSurfaceForProbe(
  state: NodeSurfaceState,
  world: Node<'vec3'>,
  cameraPos: Node<'vec3'>,
  illuminance?: IlluminanceProvider,
): Node<'vec4'> {
  return terrainSurfaceNode(
    state.inputs,
    world,
    cameraPos,
    state.detailNormals,
    // 機体の影は入れない。ライティングの差だけを見る
    uniform(1) as unknown as Node<'float'>,
    illuminance !== undefined ? { illuminance } : {},
  )
}
