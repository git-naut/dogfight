import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  keepAircraftMaterial,
  shareAircraftMaterial,
  type AircraftMaterialFactory,
} from '@render/aircraft/model'

/**
 * 機体の材質の作り手。
 *
 * **写しを共有しないと材質の実体が増える。**glb は同じ材質を複数のメッシュ
 * から参照する（F/A-18E は本体と舵面が塗装を共有する）。メッシュごとに写すと
 * 実体がその数だけ増え、描画の状態切り替えが増える。
 *
 * 絵が変わらないことは E2E の基準画像 42 枚が見る。ここが見るのは器のほう。
 */
describe('機体の材質の作り手', () => {
  it('既定は恒等。原本の実体がそのまま返る', () => {
    const source = new THREE.MeshStandardMaterial()
    const shared = shareAircraftMaterial(keepAircraftMaterial)

    expect(shared.convert(source)).toBe(source)
  })

  it('同じ原本には同じ写しを返す。作り手は 1 度しか呼ばれない', () => {
    const source = new THREE.MeshStandardMaterial()
    const factory = vi.fn<AircraftMaterialFactory>(() => new THREE.MeshBasicMaterial())
    const shared = shareAircraftMaterial(factory)

    const first = shared.convert(source)
    const second = shared.convert(source)

    expect(first).toBe(second)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('原本が違えば写しも違う', () => {
    const factory: AircraftMaterialFactory = () => new THREE.MeshBasicMaterial()
    const shared = shareAircraftMaterial(factory)

    const first = shared.convert(new THREE.MeshStandardMaterial())
    const second = shared.convert(new THREE.MeshStandardMaterial())

    expect(first).not.toBe(second)
  })

  it('配列の材質は要素ごとに写す', () => {
    const shared = shareAircraftMaterial(() => new THREE.MeshBasicMaterial())
    const sources = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]

    const made = shared.convert(sources)

    expect(Array.isArray(made)).toBe(true)
    expect(made).toHaveLength(2)
    expect(made).not.toContain(sources[0])
  })

  it('置き換えた原本を捨てる。メッシュを辿るだけでは写しにしか届かない', () => {
    const source = new THREE.MeshStandardMaterial()
    const dispose = vi.spyOn(source, 'dispose')
    const shared = shareAircraftMaterial(() => new THREE.MeshBasicMaterial())

    shared.convert(source)
    shared.disposeSources()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('恒等なら捨てるものが無い。写しが原本そのものなので二重に捨てない', () => {
    const source = new THREE.MeshStandardMaterial()
    const dispose = vi.spyOn(source, 'dispose')
    const shared = shareAircraftMaterial(keepAircraftMaterial)

    shared.convert(source)
    shared.disposeSources()

    expect(dispose).not.toHaveBeenCalled()
  })
})
