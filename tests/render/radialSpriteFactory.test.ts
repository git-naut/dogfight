import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  makeRadialSprite,
  radialSpriteHandle,
  type RadialSpriteOptions,
} from '@render/weapons/radialSprite'
import { createNodeRadialSprite } from '@render/weapons/spriteNodes'

/**
 * 円形スプライトの材質の器を確かめる。
 *
 * **断片が正しくても材質が正しいとは限らない。**`?spriteprobe=1` は断片を
 * 全画面クアッドへ焼いてバイトを比べるだけで、合成の仕方も深度の書き込みも
 * 両面描画も通っていない。フレアの芯は深度を書き、暈は書かない。ここが
 * 食い違うと「縁のはっきりした暗い円」が出る（`docs/weapons.md`）。
 *
 * もとは GLSL 版と node 版の設定を突き合わせていた。段 S1 で GLSL 版を
 * 捨てたので、GLSL 版が持っていた設定を既知の値として書いて比べる。
 * 値の一致は E2E の `?spriteprobe=1` が CPU 参照と比べて見る。
 */
const CASES: {
  label: string
  options: RadialSpriteOptions
  blending: THREE.Blending
  depthWrite: boolean
}[] = [
  {
    label: '通常合成の暈',
    options: { color: new THREE.Color(0.92, 0.55, 0.2), falloff: 1.8, additive: false },
    blending: THREE.NormalBlending,
    depthWrite: false,
  },
  {
    label: '加算合成の破片',
    options: { color: new THREE.Color(1, 0.8, 0.4), falloff: 2.4, additive: true },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  },
  {
    label: '不透明な芯',
    options: {
      color: new THREE.Color(1, 0.95, 0.8),
      falloff: 1.8,
      additive: false,
      opaqueCore: true,
    },
    blending: THREE.NormalBlending,
    depthWrite: true,
  },
]

describe('円形スプライトの材質', () => {
  it('合成・深度・面の設定が GLSL 版の持っていた値と同じ', () => {
    for (const { label, options, blending, depthWrite } of CASES) {
      const node = createNodeRadialSprite(options).material
      expect(node.blending, `${label} の合成`).toBe(blending)
      expect(node.depthWrite, `${label} の深度書き込み`).toBe(depthWrite)
      expect(node.transparent, `${label} の透明`).toBe(true)
      expect(node.side, `${label} の面`).toBe(THREE.DoubleSide)
    }
  })

  it('不透明な芯だけが深度を書く', () => {
    const soft = createNodeRadialSprite({ color: new THREE.Color(1, 1, 1), falloff: 1.8, additive: false })
    const core = createNodeRadialSprite({
      color: new THREE.Color(1, 1, 1),
      falloff: 1.8,
      additive: false,
      opaqueCore: true,
    })
    expect(soft.material.depthWrite).toBe(false)
    expect(core.material.depthWrite).toBe(true)
  })

  it('加算と通常が書き分けられている', () => {
    const normal = createNodeRadialSprite({ color: new THREE.Color(1, 1, 1), falloff: 1, additive: false })
    const additive = createNodeRadialSprite({ color: new THREE.Color(1, 1, 1), falloff: 1, additive: true })
    expect(normal.material.blending).toBe(THREE.NormalBlending)
    expect(additive.material.blending).toBe(THREE.AdditiveBlending)
  })

  it('ShaderMaterial ではない', () => {
    // **node 経路の `ShaderMaterial` は落ちない。**コンソールに 1 行出して
    // 描画は進むので、そのメッシュだけが静かに消える（段 9 の教訓）
    const node = createNodeRadialSprite(CASES[0]!.options).material
    expect(node instanceof THREE.ShaderMaterial).toBe(false)
  })

  it('材質から作り手へ戻れる', () => {
    // `place()` はメッシュしか持たない。戻る道が切れると不透明度が
    // 一切書き込まれず、**フレアと爆発が丸ごと出なくなる**
    const made = makeRadialSprite(createNodeRadialSprite, CASES[0]!.options)
    expect(radialSpriteHandle(made.material)).toBe(made)
  })

  it('登録していない材質では戻れない', () => {
    // 検査が空振りしていないことを確かめる
    expect(radialSpriteHandle(new THREE.MeshBasicMaterial())).toBeUndefined()
  })
})
