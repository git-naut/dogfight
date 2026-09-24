import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  AIRCRAFT_SPACE_ATTRIBUTE,
  bakeAircraftSpace,
  toNodeAircraftMaterial,
  wantsSurfaceDetail,
} from '@render/pipeline/nodeAircraftMaterial'

/**
 * `NodeLibrary.fromMaterial` の受け方。
 *
 * **クラスが見つからない型では `null` が返る。**例外は投げず、コンソールにも
 * 何も出ない。素通しすると材質が `null` になり、そのメッシュだけが消える。
 * 絵で気づける保証が無いので、ここで縛る。
 */
describe('機体の材質を node 版へ写す', () => {
  it('写しが返ればそれを使う', () => {
    const made = new THREE.MeshBasicMaterial()
    const factory = toNodeAircraftMaterial({ library: { fromMaterial: () => made } })

    expect(factory(new THREE.MeshStandardMaterial())).toBe(made)
  })

  it('null が返ったら原本のまま。材質を null にしない', () => {
    const source = new THREE.MeshStandardMaterial()
    const factory = toNodeAircraftMaterial({ library: { fromMaterial: () => null } })

    expect(factory(source)).toBe(source)
  })

  it('原本をそのまま返す実装でも壊れない（既に node 材質のとき）', () => {
    const source = new THREE.MeshStandardMaterial()
    const factory = toNodeAircraftMaterial({ library: { fromMaterial: (m) => m } })

    expect(factory(source)).toBe(source)
  })
})

/** 塗装のテクスチャを持つ外板の原本と、node 版の写し */
function painted(): { source: THREE.MeshStandardMaterial; copy: MeshStandardNodeMaterial } {
  const source = new THREE.MeshStandardMaterial({ map: new THREE.Texture() })
  return { source, copy: new MeshStandardNodeMaterial() }
}

describe('外板の細部を差す相手', () => {
  it('塗装のある不透明な外板には差す', () => {
    const { source, copy } = painted()
    expect(wantsSurfaceDetail(source, copy)).toBe(true)
  })

  it('テクスチャの無い材質には差さない（F/A-18E のキャノピー）', () => {
    expect(wantsSurfaceDetail(new THREE.MeshStandardMaterial(), new MeshStandardNodeMaterial())).toBe(false)
  })

  it('透明なものには差さない（F-16 のキャノピー）', () => {
    const { source, copy } = painted()
    source.transparent = true
    expect(wantsSurfaceDetail(source, copy)).toBe(false)
  })

  it('写しが node の標準材質でなければ差さない', () => {
    const { source } = painted()
    expect(wantsSurfaceDetail(source, new THREE.MeshStandardMaterial())).toBe(false)
  })
})

describe('外板の細部の有無', () => {
  it('none なら粗さも法線も触らない', () => {
    // **既定の口は絵を変えない**（段 24 の 0 画素差を守る）
    const { source, copy } = painted()
    const factory = toNodeAircraftMaterial({ library: { fromMaterial: () => copy } }, 'none')
    factory(source)
    expect(copy.roughnessNode).toBeNull()
    expect(copy.normalNode).toBeNull()
  })

  it('既定は none', () => {
    const { source, copy } = painted()
    toNodeAircraftMaterial({ library: { fromMaterial: () => copy } })(source)
    expect(copy.roughnessNode).toBeNull()
  })

  it('procedural なら粗さと法線を差す', () => {
    const { source, copy } = painted()
    toNodeAircraftMaterial({ library: { fromMaterial: () => copy } }, 'procedural')(source)
    expect(copy.roughnessNode).not.toBeNull()
    expect(copy.normalNode).not.toBeNull()
    // 溝は遮蔽で沈める。粗さを上げると逆に光った
    expect(copy.aoNode).not.toBeNull()
  })

  it('procedural でも金属度は触らない', () => {
    // **金属度を上げると鏡になる**（`tools/ac3d-to-glb.mjs` の実測）
    const { source, copy } = painted()
    toNodeAircraftMaterial({ library: { fromMaterial: () => copy } }, 'procedural')(source)
    expect(copy.metalnessNode).toBeNull()
  })
})

describe('外板の座標を焼く', () => {
  it('根元から見た座標になる。部品の行列を掛ける', () => {
    const root = new THREE.Group()
    root.position.set(100, 0, 0)
    const part = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([1, 0, 0]), 3),
      ),
    )
    part.scale.setScalar(0.5)
    part.position.set(0, 2, 0)
    root.add(part)

    expect(bakeAircraftSpace({ object: root })).toBe(1)
    // 根元の移動（100, 0, 0）は入らず、部品の縮小と移動だけが掛かる
    const baked = part.geometry.getAttribute(AIRCRAFT_SPACE_ATTRIBUTE)
    expect([baked.getX(0), baked.getY(0), baked.getZ(0)]).toEqual([0.5, 2, 0])
  })

  it('ジオメトリを使い回すノードがあれば止める', () => {
    // **後から焼いた行列で上書きされる。**黙って半分の部品の模様がずれる
    const root = new THREE.Group()
    const geometry = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(3), 3),
    )
    root.add(new THREE.Mesh(geometry), new THREE.Mesh(geometry))
    expect(() => bakeAircraftSpace({ object: root })).toThrow('使い回す')
  })
})
