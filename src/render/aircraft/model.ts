import * as THREE from 'three'
import type { Nozzle } from './afterburner'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 機体モデルの読み込み。
 *
 * 原本は 3 機種。自機の F/A-18E（Sketchfab、CC BY 4.0）、`?craft=f18` で
 * 出る F/A-18C と敵機の F-16（どちらも FlightGear FGAddon、GPLv2+）。
 * `tools/f18e-to-glb.mjs` と `tools/ac3d-to-glb.mjs` が当プロジェクトの座標系
 * （機首 −Z、上 +Y、右 +X）へ移した glb を読む。座標変換は変換ツール側で
 * 済んでいるので、ここでは回さない。
 *
 * ノードの構成は変換ツールが決めている。`body` が本体、`gear` が降着装置、
 * 残りが舵面（`AileronLeft` など）。C 型と F-16 はこれに `cockpit`（操縦席の
 * 内装）が付く。**E 型には無い**が、読み手は `getObjectByName` で探して
 * 無ければ null にするので、機種ごとの分岐は要らない。舵面のノードは
 * 原点がヒンジの位置に移してあるので、回転を代入するだけで舵が切れる。
 */

/** 舵面が読む指令の種類 */
export type SurfaceChannel = 'elevator' | 'aileron' | 'rudder'

/** 舵面のヒンジ。変換ツールが glTF の extras に載せた値をそのまま読む */
export interface AircraftHinge {
  node: string
  origin: [number, number, number]
  axis: [number, number, number]
  maxDeg: number
  /** どの指令で動くか */
  channel: SurfaceChannel
  /**
   * 舵の向き。指令に掛ける符号。
   *
   * **機体ごとに違う。**ヒンジの軸がどちらを向いているかで決まるので、
   * 描画側に表を持てない。F/A-18C はエレベータの軸が左右で同じ向きなので
   * 同じ符号、F-16 は逆向きなので左右で符号が違う。F/A-18E は bbox から軸を
   * 組むので、C 型から符号を写せない（実測で 2 つとも反転した）。値は機体の
   * 定義（`tools/f18e-hinges.mjs` など）が持ち、glb の extras 経由で届く。
   */
  sign: number
}

export interface AircraftModel {
  readonly object: THREE.Object3D
  /** エンジンノズル。原本に無ければ空。炎を描く位置 */
  readonly nozzles: readonly Nozzle[]
  /** 降着装置のノード。原本に無ければ null */
  readonly gear: THREE.Object3D | null
  /** 舵面のノード。名前で引く */
  readonly surfaces: ReadonlyMap<string, THREE.Object3D>
  /** 変換ツールが埋めたヒンジの定義 */
  readonly hinges: readonly AircraftHinge[]
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  dispose(): void
}

/**
 * 空中では見せないノード。
 *
 * `gear` は降着装置。地上の場面を作るときに戻す。
 *
 * `stowed` は原本の側で条件付きだった部品を集めたもの（変換ツールが分ける）。
 * 塗装の変種、空のパイロン、既定で消えている灯火、重なっている円盤。**全部
 * 出すと塗装が二重になり、翼下に空のパイロンが垂れる。**F-16 で実際にそう
 * なっていた。どの部品をここへ入れるかは機体の定義が持つ。
 */
const HIDDEN_NODES = ['gear', 'stowed']

/**
 * 降着装置のノード名。
 *
 * `HIDDEN_NODES` に入っているので既定では隠れている。地上にいるあいだ
 * だけ出す（`AircraftSample.gearDown`）
 */
export const GEAR_NODE = 'gear'

/**
 * 機体の材質の作り手。
 *
 * **node 経路では TSL の材質へ写す。**`MeshStandardMaterial` のままでも絵は
 * 出るが、`normalNode` と `roughnessNode` を差す口が無い。表面ディテールの
 * 前提として、写す口だけを先に開ける。
 *
 * 既定は恒等（`keepAircraftMaterial`）。GLSL 経路は引数を渡さないので、
 * **型として動かないことが保証される**（`views.ts` の `sprite` と同じ形）。
 */
export type AircraftMaterialFactory = (material: THREE.Material) => THREE.Material

/** 原本の材質をそのまま返す。既定 */
export const keepAircraftMaterial: AircraftMaterialFactory = (material) => material

/** 写しを共有する作り手と、置き換えた原本の後始末 */
export interface SharedAircraftMaterial {
  convert: (source: THREE.Material | THREE.Material[]) => THREE.Material | THREE.Material[]
  /**
   * 置き換えた原本を捨てる。
   *
   * **メッシュを辿るだけでは写しにしか届かない。**原本はどこからも参照され
   * なくなるので、対応表から捨てる。恒等なら捨てるものが無い
   */
  disposeSources: () => void
}

/**
 * 原本 1 つにつき写し 1 つ。
 *
 * **同じ材質を参照するメッシュが複数ある。**写しをまとめないと材質の実体が
 * 増え、描画の状態切り替えが増える。恒等のときは同じ実体が返るので、
 * この表は素通りになる。
 */
export function shareAircraftMaterial(factory: AircraftMaterialFactory): SharedAircraftMaterial {
  const made = new Map<THREE.Material, THREE.Material>()
  const one = (source: THREE.Material): THREE.Material => {
    const cached = made.get(source)
    if (cached !== undefined) return cached
    const copy = factory(source)
    made.set(source, copy)
    return copy
  }
  return {
    convert: (source) => (Array.isArray(source) ? source.map(one) : one(source)),
    disposeSources: () => {
      for (const [source, copy] of made) if (source !== copy) source.dispose()
    },
  }
}

export async function loadAircraftModel(
  url: string,
  material: AircraftMaterialFactory = keepAircraftMaterial,
): Promise<AircraftModel> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)

  const object = gltf.scene
  const surfaces = new Map<string, THREE.Object3D>()
  let triangles = 0

  const shared = shareAircraftMaterial(material)

  object.traverse((node) => {
    if (HIDDEN_NODES.includes(node.name)) node.visible = false
    if (!(node instanceof THREE.Mesh)) return

    const geometry = node.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    triangles += index ? index.count / 3 : geometry.attributes['position']!.count / 3

    node.material = shared.convert(node.material as THREE.Material | THREE.Material[])

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
    nozzles: readNozzles(gltf),
    gear: object.getObjectByName(GEAR_NODE) ?? null,
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
      shared.disposeSources()
    },
  }
}

/**
 * glTF の extras からエンジンノズルを読む。
 *
 * **無くてもよい。**F/A-18C と F-16 は原本が炎の板を持っているので載せて
 * いない。無い機体は自前の炎を描かず、原本の板を使う（`aircraftView.ts`）。
 */
function readNozzles(gltf: { parser: { json: unknown } }): Nozzle[] {
  const json = gltf.parser.json as {
    scenes?: { extras?: { nozzles?: Nozzle[] } }[]
  }
  return json.scenes?.[0]?.extras?.nozzles ?? []
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
