import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  createGlRadialSprite,
  makeRadialSprite,
  radialSpriteHandle,
  type RadialSpriteFactory,
  type RadialSpriteOptions,
} from '@render/weapons/radialSprite'
import { createNodeRadialSprite } from '@render/weapons/spriteNodes'

/**
 * 円形スプライトの材質を GLSL 版と node 版で突き合わせる。
 *
 * **断片が一致していても材質が一致しているとは限らない。**`?spriteprobe=1`
 * は断片を全画面クアッドへ焼いてバイトを比べるだけで、合成の仕方も深度の
 * 書き込みも両面描画も通っていない。フレアの芯は深度を書き、暈は書かない。
 * ここが食い違うと「縁のはっきりした暗い円」が出る（`docs/weapons.md`）。
 * 絵に出るのは 42 枚のうち数枚で、しかも小さい。
 *
 * 値の一致は E2E の `?spriteprobe=1` が見る。ここが見るのは器のほう。
 */
const CASES: { label: string; options: RadialSpriteOptions }[] = [
  {
    label: '通常合成の暈',
    options: { color: new THREE.Color(0.92, 0.55, 0.2), falloff: 1.8, additive: false },
  },
  {
    label: '加算合成の破片',
    options: { color: new THREE.Color(1, 0.8, 0.4), falloff: 2.4, additive: true },
  },
  {
    label: '不透明な芯',
    options: {
      color: new THREE.Color(1, 0.95, 0.8),
      falloff: 1.8,
      additive: false,
      opaqueCore: true,
    },
  },
]

const FACTORIES: { label: string; make: RadialSpriteFactory }[] = [
  { label: 'GLSL', make: createGlRadialSprite },
  { label: 'node', make: createNodeRadialSprite },
]

describe('円形スプライトの材質', () => {
  it('両版で合成・深度・面の設定が一致する', () => {
    for (const { label, options } of CASES) {
      const gl = createGlRadialSprite(options).material
      const node = createNodeRadialSprite(options).material
      expect(node.blending, `${label} の合成`).toBe(gl.blending)
      expect(node.depthWrite, `${label} の深度書き込み`).toBe(gl.depthWrite)
      expect(node.transparent, `${label} の透明`).toBe(gl.transparent)
      expect(node.side, `${label} の面`).toBe(gl.side)
    }
  })

  it('不透明な芯だけが深度を書く', () => {
    // **抽出そのものが働くことを既知の値で確かめる。**上の一致だけでは、
    // 両方とも false になっていても通る
    for (const { make } of FACTORIES) {
      const soft = make({ color: new THREE.Color(1, 1, 1), falloff: 1.8, additive: false })
      const core = make({
        color: new THREE.Color(1, 1, 1),
        falloff: 1.8,
        additive: false,
        opaqueCore: true,
      })
      expect(soft.material.depthWrite).toBe(false)
      expect(core.material.depthWrite).toBe(true)
    }
  })

  it('加算と通常が書き分けられている', () => {
    for (const { make } of FACTORIES) {
      const normal = make({ color: new THREE.Color(1, 1, 1), falloff: 1, additive: false })
      const additive = make({ color: new THREE.Color(1, 1, 1), falloff: 1, additive: true })
      expect(normal.material.blending).toBe(THREE.NormalBlending)
      expect(additive.material.blending).toBe(THREE.AdditiveBlending)
    }
  })

  it('node 版は ShaderMaterial ではない', () => {
    // **node 経路の `ShaderMaterial` は落ちない。**コンソールに 1 行出して
    // 描画は進むので、そのメッシュだけが静かに消える（段 9 の教訓）
    const node = createNodeRadialSprite(CASES[0]!.options).material
    expect(node instanceof THREE.ShaderMaterial).toBe(false)
    expect(createGlRadialSprite(CASES[0]!.options).material instanceof THREE.ShaderMaterial).toBe(
      true,
    )
  })

  it('色は複製されて入る', () => {
    // 参照のまま入れると、スロット全部が同じ器を指して 1 つ書き換えた
    // 瞬間に全部同じ色になる（`flares.ts` が踏んだ形）
    const source = new THREE.Color(0.1, 0.2, 0.3)
    const gl = createGlRadialSprite({ color: source, falloff: 1, additive: false })
    const stored = (gl.material as THREE.ShaderMaterial).uniforms['uColor']!.value as THREE.Color
    expect(stored).not.toBe(source)
    source.setRGB(0.9, 0.9, 0.9)
    expect(stored.r).toBeCloseTo(0.1, 6)
  })

  it('材質から作り手へ戻れる', () => {
    // `place()` はメッシュしか持たない。戻る道が切れると不透明度が
    // 一切書き込まれず、**フレアと爆発が丸ごと出なくなる**
    for (const { label, make } of FACTORIES) {
      const made = makeRadialSprite(make, CASES[0]!.options)
      expect(radialSpriteHandle(made.material), `${label} の戻る道`).toBe(made)
    }
  })

  it('登録していない材質では戻れない', () => {
    // 検査が空振りしていないことを確かめる
    expect(radialSpriteHandle(new THREE.MeshBasicMaterial())).toBeUndefined()
  })
})
