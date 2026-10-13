import * as THREE from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { attribute, clamp, materialRoughness, mx_fractal_noise_float, mx_worley_noise_float } from 'three/tsl'
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
 * 別に扱う。透明なもの（F-16 のキャノピー）の粗さを揺らしても意味が無い
 */
export function wantsSurfaceDetail(source: THREE.Material, copy: THREE.Material): boolean {
  if (!(copy instanceof MeshStandardNodeMaterial)) return false
  if (source.transparent) return false
  return (source as THREE.MeshStandardMaterial).map != null
}

/** 外板の細部の定数。**メートル**（`AIRCRAFT_SPACE_ATTRIBUTE` の座標） */
export const SURFACE_DETAIL = {
  /** 汚れの大きさ（1 周期のメートル） */
  grimeScale: 1.1,
  /** 汚れで揺らす粗さの幅。計画書の ±0.12 */
  grimeRoughness: 0.12,
  /** パネルごとのむらの大きさ */
  mottleScale: 0.8,
  /** むらで揺らす粗さの幅 */
  mottleRoughness: 0.08,
} as const

/**
 * 汚れとパネルごとのむらを差す（粗さを揺らすだけ）。
 *
 * **パネルラインは外した**（2026-10-13、ユーザーの指摘「スクリーンショットに写っているマス目の
 * 黒い線」と判断「格子の線だけ外す」）。以前は機体の平面形（X と Z）に 1.2 m 間隔の溝を引き、
 * 遮蔽（`aoNode`）と法線の傾き（`normalNode`）で沈めていた。実機の外板の継ぎ目は不規則なのに、
 * 規則正しい格子が主翼と尾翼にマス目として写った。継ぎ目は原本の色のテクスチャに描かれている
 *
 * **金属度は触らない。**変換ツールが「`spec` から金属度を写したらパイロンと
 * ミサイルが鏡になった」と記録している（`tools/ac3d-to-glb.mjs`）。
 *
 * **粗さは原本の値のまわりで揺らす。**計画書は 0.45 を中心にと書いていたが、
 * 外板の原本は 0.82 の誘電体で、中心を 0.45 へ下げると逆光で空を映して中央値が
 * +10.4%（鏡）、ほかの構図では −16〜−18% 暗くなった。どちらでも模様が減った
 */
export function applySurfaceDetail(material: MeshStandardNodeMaterial): void {
  const d = SURFACE_DETAIL
  const p = attribute(AIRCRAFT_SPACE_ATTRIBUTE, 'vec3') as unknown as Node<'vec3'>
  const grime = mx_fractal_noise_float(p.mul(1 / d.grimeScale), 3, 2, 0.5)
  const mottle = mx_worley_noise_float(p.mul(1 / d.mottleScale)).sub(0.5)
  const roughness = materialRoughness
    .add(grime.mul(d.grimeRoughness))
    .add(mottle.mul(d.mottleRoughness * 2))
  material.roughnessNode = clamp(roughness, 0.2, 1)
}
