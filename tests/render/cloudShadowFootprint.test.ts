import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * 雲の影が画素の大きさで細かい段を消すこと（段 S4d）。
 *
 * 影は画素の幅 0 のまま細かい段までノイズを引いていて、実機の朝の海で、遠くの影が規則正しい
 * 模様になり網目を強めていた。空の雲と同じく `fp`（画素の幅 km）を密度の関数へ渡す。
 * 値は GPU でしか測れないので、本文で縛る
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/render/${path}`, import.meta.url)), 'utf8')
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('雲の影の画素の幅', () => {
  const layers = strip(read('sky/cloudLayerNodes.ts'))
  const ocean = strip(read('ocean/oceanSurface.ts'))

  it('影は画素の幅（m を km に直したもの）を密度の関数へ渡す', () => {
    expect(layers).toContain('const fp = (footprint === undefined ? float(0) : footprint.div(1000)).toVar()')
    expect(layers).toContain('(q, fp, O(CLOUD_SHADOW_OCTAVE_DROP), high ? veil : coverage, time)')
  })

  it('海面は画素が海面で覆う幅を影へ渡す', () => {
    expect(ocean).toContain('lighting.sunShade(world, footMajor)')
  })
})
