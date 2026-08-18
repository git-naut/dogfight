import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 機体モデルの読み込み。
 *
 * 原本は FlightGear FGAddon の F/A-18C（作者 Fabrice Kauffmann、GPLv2+）。
 * `tools/ac3d-to-glb.mjs` が当プロジェクトの座標系（機首 −Z、上 +Y、右 +X）へ
 * 移した glb を読む。座標変換は変換ツール側で済んでいるので、ここでは回さない。
 *
 * ノードの構成は変換ツールが決めている。`body` が本体、`gear` が降着装置、
 * `cockpit` が操縦席の内装、残りが舵面（`AileronLeft` など）。舵面のノードは
 * 原点がヒンジの位置に移してあるので、回転を代入するだけで舵が切れる。
 */

/** 舵面のヒンジ。変換ツールが glTF の extras に載せた値をそのまま読む */
export interface AircraftHinge {
  node: string
  origin: [number, number, number]
  axis: [number, number, number]
  maxDeg: number
}

export interface AircraftModel {
  readonly object: THREE.Object3D
  /** 舵面のノード。名前で引く */
  readonly surfaces: ReadonlyMap<string, THREE.Object3D>
  /** 変換ツールが埋めたヒンジの定義 */
  readonly hinges: readonly AircraftHinge[]
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  dispose(): void
}

/** 降着装置は空中では見せない。地上の場面を作るときに戻す */
const HIDDEN_NODES = ['gear']

export async function loadAircraftModel(url: string): Promise<AircraftModel> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)

  const object = gltf.scene
  const surfaces = new Map<string, THREE.Object3D>()
  let triangles = 0

  object.traverse((node) => {
    if (HIDDEN_NODES.includes(node.name)) node.visible = false
    if (!(node instanceof THREE.Mesh)) return

    const geometry = node.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    triangles += index ? index.count / 3 : geometry.attributes['position']!.count / 3

    // 追従カメラは機体の後方 23 m にいる。視錐台で捨てられると機体が消える
    node.frustumCulled = false
  })

  const hinges = readHinges(gltf)
  for (const hinge of hinges) {
    const node = object.getObjectByName(hinge.node)
    if (node !== undefined) surfaces.set(hinge.node, node)
  }

  return {
    object,
    surfaces,
    hinges,
    triangles,

    dispose() {
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return
        node.geometry.dispose()
        const material = node.material as THREE.Material | THREE.Material[]
        if (Array.isArray(material)) for (const m of material) m.dispose()
        else material.dispose()
      })
    },
  }
}

/**
 * glTF の extras からヒンジを読む。
 *
 * 別ファイルに置くとモデルと定義がずれる。同じ glb に入れておけば、
 * 変換ツールを直した時点で両方が変わる。
 */
function readHinges(gltf: { parser: { json: unknown } }): AircraftHinge[] {
  const json = gltf.parser.json as {
    scenes?: { extras?: { hinges?: AircraftHinge[] } }[]
  }
  const hinges = json.scenes?.[0]?.extras?.hinges
  if (hinges === undefined) {
    throw new Error('glb に舵面のヒンジが入っていない。tools/ac3d-to-glb.mjs を確認')
  }
  return hinges
}
