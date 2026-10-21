import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * 実録音の効果音（段 B11a、ADR 0037）。`tools/audio-import.mjs` が元のファイルから切り出して
 * `public/audio/` に書き出し、測った値を `manifest.json` に残す。CI には ffmpeg が無いので、ここでは
 * 書き出したファイルと記録の食い違いと、合格の線（合計 1 MB 以内・長さ・継ぎ目）を見る
 */
interface Entry {
  name: string
  loop: boolean
  seconds: number
  decodedSeconds: number
  bytes: number
  seamDecoded?: number
}

const dir = fileURLToPath(new URL('../../public/audio/', import.meta.url))
const manifest = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8')) as Entry[]

describe('実録音の効果音', () => {
  it('8 本ある', () => {
    expect(manifest.map((e) => e.name)).toEqual([
      'engine-turbine',
      'engine-idle',
      'engine-burner',
      'burner-light',
      'flyby',
      'gun-loop',
      'gun-tail',
      'missile-launch',
    ])
  })

  it('ファイルの大きさが記録と一致し、合計は 1 MB 以内', () => {
    let total = 0
    for (const e of manifest) {
      const size = statSync(`${dir}${e.name}.ogg`).size
      expect(size, e.name).toBe(e.bytes)
      total += size
    }
    expect(total).toBeLessThanOrEqual(1024 * 1024)
  })

  it('読み戻した長さは書き出す前と 5 ms 以内', () => {
    for (const e of manifest) {
      expect(Math.abs(e.decodedSeconds - e.seconds), e.name).toBeLessThanOrEqual(0.005)
    }
  })

  it('ループの継ぎ目に段差がない（ふだんの隣り合うサンプルの差の 3 倍以内）', () => {
    const loops = manifest.filter((e) => e.loop)
    expect(loops.map((e) => e.name)).toEqual(['engine-turbine', 'engine-idle', 'engine-burner', 'gun-loop'])
    for (const e of loops) expect(e.seamDecoded, e.name).toBeLessThanOrEqual(3)
  })
})
