import { describe, expect, it } from 'vitest'
import { DirectionalLight, Vector3 } from 'three'
import type { Renderer } from 'three/webgpu'
import {
  configureNodeAircraftShadow,
  type NodeAircraftShadow,
} from '../../src/render/pipeline/nodeShadow'
import type { AtmosphereSunLight } from '../../src/render/atmosphereNodes'
import { getQuality } from '../../src/render/quality'

/**
 * 機体の影の実行時の張り替え。
 *
 * **0 を `mapSize` へ渡すと描画ループごと止まる。**`low` の
 * `aircraftShadowMapSize` は 0 で、0×0 のテクスチャは作られない。WebGPU
 * バックエンドの `createBindGroup` が `undefined.mipLevelCount` を読んで
 * 落ちる。旧経路の `aircraftShadow.ts` は `Math.max(1, size)` の下限と
 * `shadow.map` の作り直しを持っていたが、**移植でその両方が落ちていた**
 * （段 20c）。
 *
 * ここは `three/tsl` の `shadow()` を組むだけでレンダラを要らないので、
 * 単体で縛れる（`nodeTimer.test.ts` と同じ作り）。
 */
function fakeRenderer(): Renderer {
  return { shadowMap: { enabled: false, type: -1 } } as unknown as Renderer
}

function build(preset: 'low' | 'medium' | 'high' | 'ultra'): {
  renderer: Renderer
  light: DirectionalLight
  shadow: NodeAircraftShadow
} {
  const renderer = fakeRenderer()
  const light = new DirectionalLight()
  const shadow = configureNodeAircraftShadow({
    renderer,
    light: light as unknown as AtmosphereSunLight,
    quality: getQuality(preset),
    center: new Vector3(0, 0, 0),
    sunDirectionWorld: new Vector3(0, 1, 0),
  })
  return { renderer, light, shadow }
}

describe('node 経路の機体の影', () => {
  it('high では立ち、箱の大きさがプリセットどおり', () => {
    const { renderer, light, shadow } = build('high')
    expect(shadow.enabled, '影が立っていない').toBe(true)
    expect(light.shadow.mapSize.x).toBe(getQuality('high').aircraftShadowMapSize)
    expect(
      (renderer as unknown as { shadowMap: { enabled: boolean } }).shadowMap.enabled,
      '`shadowMap.enabled` を立てないと本体が生成されない',
    ).toBe(true)
  })

  it('low では立てない', () => {
    const { light, shadow } = build('low')
    expect(shadow.enabled).toBe(false)
    expect(light.castShadow).toBe(false)
  })

  it('**降格で 0 を `mapSize` へ渡さない**', () => {
    const { light, shadow } = build('high')
    shadow.setQuality(getQuality('low'))
    // 0×0 のテクスチャは作られず、束縛が undefined になる（段 20c）
    expect(light.shadow.mapSize.x, '影マップの幅が 0 になった').toBeGreaterThan(0)
    expect(light.shadow.mapSize.y, '影マップの高さが 0 になった').toBeGreaterThan(0)
  })

  it('大きさが変わったら影マップを捨てて作り直させる', () => {
    const { light, shadow } = build('ultra')
    const before = light.shadow.mapSize.x
    // 作り直しを観測するために、焼かれた後の状態を作る
    light.shadow.map = { dispose() {} } as unknown as typeof light.shadow.map
    shadow.setQuality(getQuality('medium'))
    expect(light.shadow.mapSize.x, '解像度が変わっていない').toBe(
      getQuality('medium').aircraftShadowMapSize,
    )
    expect(light.shadow.mapSize.x).not.toBe(before)
    expect(
      light.shadow.map,
      '影マップを捨てていない。**大きさだけ変えても張り替わらない**',
    ).toBeNull()
  })

  it('フィルタの種別もプリセットから追う', () => {
    const { renderer, shadow } = build('high')
    const map = (renderer as unknown as { shadowMap: { type: number } }).shadowMap
    const atHigh = map.type
    shadow.setQuality(getQuality('ultra'))
    expect(map.type, 'ultra で `pcfSoft` へ上がっていない').not.toBe(atHigh)
  })
})
