import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { toNodeFlameMaterial } from '@render/pipeline/nodeFlameMaterial'
import { createAfterburner } from '@render/aircraft/afterburner'

/**
 * 炎を発光体として MRT の `emissive` へ書かせる（段 27b）。
 *
 * **炎は three の `MeshBasicMaterial` なので `mrtNode` を差す口が無い。**
 * node 版へ写してから差す。写せなければ原本のまま返し、炎は光らないだけで
 * 消えない
 */
type WithMrt = { mrtNode: { outputNodes: Record<string, unknown> } | null }

describe('炎の材質を発光体にする', () => {
  it('写した材質に emissive の MRT を差す', () => {
    const copy = new MeshBasicNodeMaterial()
    const made = toNodeFlameMaterial({ library: { fromMaterial: () => copy } })(
      new THREE.MeshBasicMaterial(),
    )
    expect(made).toBe(copy)
    expect(Object.keys((made as unknown as WithMrt).mrtNode!.outputNodes)).toEqual(['emissive'])
  })

  it('写せない型では原本のまま返し、MRT を差さない', () => {
    const source = new THREE.MeshBasicMaterial()
    const made = toNodeFlameMaterial({ library: { fromMaterial: () => null } })(source)
    expect(made).toBe(source)
    expect((made as unknown as { mrtNode?: unknown }).mrtNode).toBeUndefined()
  })
})

describe('アフターバーナーの材質の作り手', () => {
  const nozzles = [{ position: [0, 0, 5] as [number, number, number], radius: 0.4 }]

  it('作り手が返した材質で描き、その不透明度を強さに追従させる', () => {
    // **写しを返すなら写しのほうが炎の強さに追従する。**原本を書き換えても
    // 描かれている材質は変わらない
    const made: THREE.Material[] = []
    const burner = createAfterburner(nozzles as never, (m) => {
      const copy = m.clone()
      made.push(copy)
      return copy
    })
    const used = new Set<THREE.Material>()
    burner.object.traverse((o) => {
      if (o instanceof THREE.Mesh) used.add(o.material as THREE.Material)
    })
    expect(used.size).toBe(made.length)
    for (const m of made) expect(used.has(m)).toBe(true)

    burner.setStrength(1)
    for (const m of made) expect(m.opacity).toBe(1)
    burner.setStrength(0.5)
    expect(made.map((m) => m.opacity).sort()).toEqual([0.75, 0.875])
  })

  it('既定は原本のまま', () => {
    const burner = createAfterburner(nozzles as never)
    burner.object.traverse((o) => {
      if (o instanceof THREE.Mesh) expect(o.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    })
  })
})
