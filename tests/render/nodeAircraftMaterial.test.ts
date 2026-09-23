import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { toNodeAircraftMaterial } from '@render/pipeline/nodeAircraftMaterial'

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
