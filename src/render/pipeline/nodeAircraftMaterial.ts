import * as THREE from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import {
  abs,
  attribute,
  clamp,
  dFdx,
  dFdy,
  faceDirection,
  float,
  fract,
  fwidth,
  materialRoughness,
  max,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  normalView,
  positionView,
  smoothstep,
  vec2,
} from 'three/tsl'
import type { AircraftMaterialFactory, AircraftModel } from '../aircraft/model'
import type { MaterialDetail } from '../quality'

/**
 * 機体の材質を TSL 版へ写す。
 *
 * **写すだけなら絵は変えない。**`NodeLibrary.fromMaterial` は対応する
 * `NodeMaterial` のクラスを作り、原本の列挙可能なキーを全部写す。three が
 * 材質を組むときに内部でやるのと同じ手順を、公開の口で先に済ませるだけ。
 * 段 24 で**42 枚が 0 画素差**であることを単独で証明した。
 *
 * 写しておく理由は `normalNode` と `roughnessNode` を差す口が要ることで、
 * 段 25 の表面ディテールがそこを使う（`applySurfaceDetail`）。
 */

/**
 * 使うのは `fromMaterial` だけ。
 *
 * レンダラ全体を要求すると検査で器を作れない。`WebGPURenderer` はこの形に
 * 当てはまる
 */
export interface NodeMaterialLibrary {
  fromMaterial: (material: THREE.Material) => THREE.Material | null
}

/**
 * **クラスが見つからない型では `null` が返る。**`NodeLibrary.js` の
 * `fromMaterial` は `nodeMaterial` を `null` で初期化し、
 * `getMaterialNodeClass` が当たったときだけ代入する。例外は投げない。
 * 素通しすると材質が `null` になってメッシュが壊れるので、原本のまま使う。
 *
 * 既に `NodeMaterial` のときは three 側が原本をそのまま返す（二重に写らない）。
 */
export function toNodeAircraftMaterial(
  renderer: { library: NodeMaterialLibrary },
  detail: MaterialDetail = 'none',
  clearcoat = false,
): AircraftMaterialFactory {
  return (source) => {
    const copy = renderer.library.fromMaterial(source) ?? source
    if (detail === 'procedural' && wantsSurfaceDetail(source, copy)) {
      applySurfaceDetail(copy as MeshStandardNodeMaterial)
    }
    if (clearcoat && isCanopyGlass(source, copy)) {
      applyCanopyClearcoat(copy as MeshPhysicalNodeMaterial)
    }
    return copy
  }
}

/**
 * キャノピーのガラスか。**名前ではなく材質の形で見分ける。**
 *
 * F/A-18E で `KHR_materials_specular` を持つのは `Material.013` だけで、
 * three はそれを `MeshPhysicalMaterial` として読む（ほかは
 * `MeshStandardMaterial`）。塗装のテクスチャを持たない半透明の黒で、
 * 使うメッシュの主役は風防（`Meshpart137`、266 三角形、機体の座標で
 * x ±0.37・z −5.96〜−4.00）。残りは前面の風防と灯火の小片。
 *
 * F-16 の風防（`glassOutsideMat`）は拡張を持たない `MeshStandardMaterial`
 * なので入らない。敵機は小さく写るので扱わない
 */
export function isCanopyGlass(source: THREE.Material, copy: THREE.Material): boolean {
  if (!(source instanceof THREE.MeshPhysicalMaterial)) return false
  if (!(copy instanceof MeshPhysicalNodeMaterial)) return false
  return source.map == null
}

/** キャノピーの clearcoat の定数 */
export const CANOPY_CLEARCOAT = {
  /** 層の強さ。1 で全面に被せる */
  clearcoat: 1,
  /**
   * 層の粗さ。磨いたアクリルの値。
   *
   * 下地（粗さ 0.25）より十分小さくしないと、層を重ねても映り込みが
   * 締まらない
   */
  clearcoatRoughness: 0.04,
} as const

/** キャノピーに clearcoat を重ねる。下地の材質の値には触らない */
export function applyCanopyClearcoat(material: MeshPhysicalNodeMaterial): void {
  material.clearcoat = CANOPY_CLEARCOAT.clearcoat
  material.clearcoatRoughness = CANOPY_CLEARCOAT.clearcoatRoughness
}

/**
 * 外板の座標を入れる頂点属性の名前。
 *
 * **メッシュのローカル座標では模様の細かさが部品ごとに変わる。**F/A-18E の
 * glb は 220 のメッシュがそれぞれ別の行列を持ち、ローカルの頂点は
 * -44.8〜58.5 に広がる（全長 18 m の機体なのに）。根元から見た座標を
 * 読み込み時に焼けば、どの部品でもメートルで揃う。
 *
 * 根元の逆行列を一様変数で渡す形は採らない。**舵面が動くと模様が面の上を
 * 滑る**うえ、自機と敵機で作り手を共有しているので状態を分けられない
 */
export const AIRCRAFT_SPACE_ATTRIBUTE = 'aircraftPosition'

/**
 * 根元から見た頂点の座標を焼く。
 *
 * **ジオメトリを使い回すノードが無いことが前提。**F/A-18E は 220 ノードが
 * 別々のジオメトリを持つ（実測）。使い回しがあると後から焼いた行列で
 * 上書きされるので、見つけたら焼かずに止める。
 *
 * 増えるのは頂点 1 つにつき 12 バイト。F/A-18E の 167,537 頂点で 2.0 MB
 */
export function bakeAircraftSpace(model: Pick<AircraftModel, 'object'>): number {
  const root = model.object
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const relative = new THREE.Matrix4()
  const seen = new Set<THREE.BufferGeometry>()
  const v = new THREE.Vector3()
  let vertices = 0
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    const geometry = node.geometry as THREE.BufferGeometry
    if (seen.has(geometry)) {
      throw new Error(`ジオメトリを使い回すノードがある: ${node.name}`)
    }
    seen.add(geometry)
    const position = geometry.getAttribute('position')
    relative.multiplyMatrices(toRoot, node.matrixWorld)
    const out = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(relative)
      out[i * 3] = v.x
      out[i * 3 + 1] = v.y
      out[i * 3 + 2] = v.z
    }
    geometry.setAttribute(AIRCRAFT_SPACE_ATTRIBUTE, new THREE.BufferAttribute(out, 3))
    vertices += position.count
  })
  return vertices
}

/**
 * 細部を差すのは**塗装のテクスチャを持つ不透明な外板だけ。**
 *
 * キャノピー（F/A-18E の `Material.013`、粗さ 0.25 に鏡面の拡張）は
 * テクスチャを持たないのでここで落ちる。計画書はキャノピーを clearcoat で
 * 別に扱う。透明なもの（F-16 のキャノピー）に溝を掘っても意味が無い
 */
export function wantsSurfaceDetail(source: THREE.Material, copy: THREE.Material): boolean {
  if (!(copy instanceof MeshStandardNodeMaterial)) return false
  if (source.transparent) return false
  return (source as THREE.MeshStandardMaterial).map != null
}

/** 外板の細部の定数。**メートル**（`AIRCRAFT_SPACE_ATTRIBUTE` の座標） */
export const SURFACE_DETAIL = {
  /** パネルラインの間隔。F/A-18 の外板の点検口がおよそこの大きさ */
  panelSpacing: 1.2,
  /** 溝の幅の半分。1.2 m 間隔に対して 3 cm 幅 */
  lineHalfWidth: 0.015,
  /** 溝の深さ。法線の傾きにだけ効く */
  lineDepth: 0.004,
  /** 汚れの大きさ（1 周期のメートル） */
  grimeScale: 1.1,
  /** 汚れで揺らす粗さの幅。計画書の ±0.12 */
  grimeRoughness: 0.12,
  /** パネルごとのむらの大きさ */
  mottleScale: 0.8,
  /** むらで揺らす粗さの幅 */
  mottleRoughness: 0.08,
  /**
   * 溝の中で環境光を遮る割合。
   *
   * **粗さを上げて溝を沈める形は逆に光った。**最初は溝の粗さを 0.15 上げて
   * いたが、粗い面はぼけた空を映すので、拡大すると溝が周りより明るい線に
   * 見えた。遮蔽は間接光にだけ掛かり（`AONode`）、太陽の直達は残る
   */
  lineOcclusion: 0.5,
} as const

/**
 * 溝の濃さ（0..1）。整数の位置に線を引く。
 *
 * **画素より細い線は縞になる。**`fwidth` の幅でぼかし、線が画素を割るほど
 * 遠いときは被覆率ぶんだけ薄める
 */
function panelLine(v: Node<'float'>, halfWidth: number): Node<'float'> {
  const distance = abs(fract(v.add(0.5)).sub(0.5))
  const w = max(fwidth(v), float(1e-5))
  const line = float(1).sub(smoothstep(float(halfWidth), w.add(halfWidth), distance))
  const coverage = clamp(float(halfWidth * 2).div(w), 0, 1)
  return line.mul(coverage)
}

/**
 * 高さから法線を傾ける（Mikkelsen, "Bump Mapping Unparametrized Surfaces
 * on the GPU"）。
 *
 * three の `bumpMap` は**テクスチャしか受け取れない。**UV をずらして引き直す
 * 形なので、手続きの高さには使えない。同じ式を高さの画面微分で組む
 * （`BumpMapNode.js` の `perturbNormalArb`）
 */
function perturbNormal(height: Node<'float'>): Node<'vec3'> {
  const dHdxy = vec2(dFdx(height), dFdy(height))
  const sigmaX = dFdx(positionView).normalize()
  const sigmaY = dFdy(positionView).normalize()
  const n = normalView
  const r1 = sigmaY.cross(n)
  const r2 = n.cross(sigmaX)
  const det = sigmaX.dot(r1).mul(faceDirection)
  const grad = det.sign().mul(dHdxy.x.mul(r1).add(dHdxy.y.mul(r2)))
  return det.abs().mul(n).sub(grad).normalize() as unknown as Node<'vec3'>
}

/**
 * 汚れ・パネルごとのむら・パネルラインを差す。
 *
 * **金属度は触らない。**変換ツールが「`spec` から金属度を写したらパイロンと
 * ミサイルが鏡になった」と記録している（`tools/ac3d-to-glb.mjs`）。
 *
 * **粗さは原本の値のまわりで揺らす。**計画書は 0.45 を中心にと書いていたが、
 * 外板の原本は 0.82 の誘電体で、中心を 0.45 へ下げると逆光で空を映して中央値が
 * +10.4%（鏡）、ほかの構図では −16〜−18% 暗くなった。どちらでも模様が減った
 *
 * パネルラインは機体の平面形（X と Z）で引く。Y で引くと主翼の上面のわずかな
 * 反りが等高線になって、翼の上を曲線が這う
 */
export function applySurfaceDetail(material: MeshStandardNodeMaterial): void {
  const d = SURFACE_DETAIL
  const p = attribute(AIRCRAFT_SPACE_ATTRIBUTE, 'vec3') as unknown as Node<'vec3'>
  const k = 1 / d.panelSpacing
  const halfWidth = d.lineHalfWidth * k
  const line = max(panelLine(p.x.mul(k), halfWidth), panelLine(p.z.mul(k), halfWidth))

  const grime = mx_fractal_noise_float(p.mul(1 / d.grimeScale), 3, 2, 0.5)
  const mottle = mx_worley_noise_float(p.mul(1 / d.mottleScale)).sub(0.5)
  const roughness = materialRoughness
    .add(grime.mul(d.grimeRoughness))
    .add(mottle.mul(d.mottleRoughness * 2))
  material.roughnessNode = clamp(roughness, 0.2, 1)
  material.aoNode = float(1).sub(line.mul(d.lineOcclusion))
  material.normalNode = perturbNormal(line.mul(-d.lineDepth) as Node<'float'>)
}
