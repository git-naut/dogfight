import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import {
  CLOUD_BOTTOM,
  CLOUD_TOP,
  COVER_BAND,
  DETAIL_SCALE,
  EXTINCTION,
  SHADOW_STEPS,
  SHAPE_SCALE,
  WEATHER_SCALE,
  WIND,
} from '@render/clouds/geometry'
import { DETAIL_SIZE, SHAPE_SIZE } from '@render/clouds/noise'

/**
 * 密度の定数が GLSL と TS でずれていないことを守る。
 *
 * **GLSL は TS を import できない。**段 12 で密度を TSL へ移すあいだ、
 * 同じ定義が 2 つ並ぶ。どちらかだけ直すと、影の形と見えている雲の形がずれる。
 * ずれても絵では気づきにくい（影は地面に落ちるので雲と並べて見られない）。
 *
 * `density.glsl` の本文から数値を読んで突き合わせる。期待値を 2 度書かない
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const source = readFileSync(`${ROOT}src/render/clouds/shaders/density.glsl`, 'utf8')
const shadowSource = readFileSync(
  `${ROOT}src/render/clouds/shaders/cloudShadow.frag`,
  'utf8',
)

/** `const float NAME = 値;` を読む */
function glslFloat(text: string, name: string): number {
  const m = text.match(new RegExp(`const float ${name} = ([-0-9.e]+)`))
  expect(m, `${name} が GLSL に見つからない`).not.toBeNull()
  return Number(m![1])
}

function glslInt(text: string, name: string): number {
  const m = text.match(new RegExp(`const int ${name} = ([-0-9]+)`))
  expect(m, `${name} が GLSL に見つからない`).not.toBeNull()
  return Number(m![1])
}

describe('密度の定数', () => {
  it('雲層の高さが一致する', () => {
    expect(glslFloat(source, 'CLOUD_BOTTOM')).toBe(CLOUD_BOTTOM)
    expect(glslFloat(source, 'CLOUD_TOP')).toBe(CLOUD_TOP)
  })

  it('ノイズの周期が一致する', () => {
    expect(glslFloat(source, 'SHAPE_SCALE')).toBe(SHAPE_SCALE)
    expect(glslFloat(source, 'DETAIL_SCALE')).toBe(DETAIL_SCALE)
    expect(glslFloat(source, 'WEATHER_SCALE')).toBe(WEATHER_SCALE)
  })

  it('ノイズテクスチャの一辺が noise.ts と一致する', () => {
    expect(glslFloat(source, 'SHAPE_SIZE')).toBe(SHAPE_SIZE)
    expect(glslFloat(source, 'DETAIL_SIZE')).toBe(DETAIL_SIZE)
  })

  it('消散係数が一致する', () => {
    expect(glslFloat(source, 'EXTINCTION')).toBe(EXTINCTION)
  })

  it('風が一致する', () => {
    const m = source.match(/const vec3 WIND = vec3\(([^)]+)\)/)
    expect(m, 'WIND が GLSL に見つからない').not.toBeNull()
    const parts = m![1]!.split(',').map((v) => Number(v.trim()))
    expect(parts).toEqual([WIND.x, WIND.y, WIND.z])
  })

  it('雲量のしきい値の幅が一致する', () => {
    // `smoothstep(threshold, threshold + 0.22, weather.r)` の 0.22
    const m = source.match(/smoothstep\(threshold, threshold \+ ([0-9.]+),/)
    expect(m, 'しきい値の幅が GLSL に見つからない').not.toBeNull()
    expect(Number(m![1])).toBe(COVER_BAND)
  })

  it('影のステップ数が一致する', () => {
    expect(glslInt(shadowSource, 'SHADOW_STEPS')).toBe(SHADOW_STEPS)
  })

  it('検査そのものが働くことを、存在しない名前で確かめる', () => {
    const m = source.match(/const float NOT_A_CONSTANT = ([-0-9.]+)/)
    expect(m).toBeNull()
  })
})
