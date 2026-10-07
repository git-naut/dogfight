import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import type { AircraftGearLeg } from '@render/aircraft/model'

/**
 * 脚の付け根を、出来上がった glb で確かめる（Phase 9 の段 6）。
 *
 * **歯型の期待先にしない。**`public/aircraft/` は生成物で、歯型の作業場には無い。
 * 変換の道具を壊しても作り済みの glb は変わらないので、ここでは変異を捕まえられない。
 * 畳む向きは `tests/tools/f18eParts.test.ts` が道具の出力で、`setGear` は
 * `tests/render/gearLegs.test.ts` が作り物の脚で見張る。ここは通しの確認。
 *
 * **glb の extras から読む。**脚の付け根は `tools/f18e-hinges.mjs` の `buildGearHinges` が
 * 頂点から決め、`tools/f18e-to-glb.mjs` が座標系を回して載せる。出来上がった glb を読み、
 * view の `setGear` を通して、脚が畳む向きへ回ることを確かめる。
 *
 * この作品の座標は機首 −Z、上 +Y、右 +X。前脚は前（−Z）へ、主脚は後ろ（+Z）へ畳む
 */
const extras = (() => {
  const path = fileURLToPath(new URL('../../public/aircraft/f18e.glb', import.meta.url))
  if (!existsSync(path)) throw new Error(`${path} が無い。npm run assets を走らせること`)
  const buf = readFileSync(path)
  const jsonLength = buf.readUInt32LE(12)
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'))
  return gltf.scenes[0].extras as {
    gear: AircraftGearLeg[]
    hook: { node: string; origin: [number, number, number]; axis: [number, number, number] }
  }
})()

describe('脚の付け根（glb の extras）', () => {
  it('前脚・左主脚・右主脚の 3 本', () => {
    expect(extras.gear.map((g) => g.leg).sort()).toEqual(['left', 'nose', 'right'])
  })

  it('前脚は機首側、主脚は左右に分かれる（右が +X）', () => {
    const at = (leg: string) => extras.gear.find((g) => g.leg === leg)!.origin
    expect(at('nose')[2]).toBeLessThan(-4)
    expect(at('left')[0]).toBeLessThan(-0.3)
    expect(at('right')[0]).toBeGreaterThan(0.3)
    // 付け根は機体の下面より上（脚の部品の最上部）
    for (const g of extras.gear) expect(g.origin[1], g.leg).toBeLessThan(0)
  })

  it('フックは尾部の下に付け根がある', () => {
    expect(extras.hook.node).toBe('Hook')
    expect(extras.hook.origin[2]).toBeGreaterThan(4)
    expect(extras.hook.origin[1]).toBeLessThan(0)
  })
})
