import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import {
  CLOUD_BOTTOM,
  RESOLVE_FALLBACK_DISTANCE,
  RESOLVE_FAR_CLAMP,
  RESOLVE_SLAB_MIX,
  DETAIL_FAR,
  DETAIL_NEAR,
  EMPTY_SKIP,
  EXIT_TRANSMITTANCE,
  LIGHT_FULL_DISTANCE,
  LIGHT_HALF_DISTANCE,
  LIGHT_MARCH_LIMIT,
  LIGHT_STEP_BASE,
  MARCH_LOOP_LIMIT,
  MULTI_SCATTER_OCTAVES,
  NEAR_STEP,
  SCATTER_ALBEDO,
  START_AMP,
  TAU_PI,
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
const marchSource = readFileSync(
  `${ROOT}src/render/clouds/shaders/clouds.frag`,
  'utf8',
)
const resolveSource = readFileSync(
  `${ROOT}src/render/clouds/shaders/cloudResolve.frag`,
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

/**
 * マーチ本体の定数。
 *
 * 段 13 で `clouds.frag` を TSL へ移すあいだ、同じ定義が 2 つ並ぶ。
 * 密度と同じ理由で、片方だけ直しても絵ではほぼ気づけない
 */
describe('マーチの定数', () => {
  it('名前の付いた定数が一致する', () => {
    expect(glslFloat(marchSource, 'SCATTER_ALBEDO')).toBe(SCATTER_ALBEDO)
    expect(glslFloat(marchSource, 'NEAR_STEP')).toBe(NEAR_STEP)
    expect(glslFloat(marchSource, 'START_AMP')).toBe(START_AMP)
    expect(glslFloat(marchSource, 'DETAIL_NEAR')).toBe(DETAIL_NEAR)
    expect(glslFloat(marchSource, 'DETAIL_FAR')).toBe(DETAIL_FAR)
    expect(glslFloat(marchSource, 'EXIT_TRANSMITTANCE')).toBe(EXIT_TRANSMITTANCE)
    expect(glslFloat(marchSource, 'LIGHT_FULL_DISTANCE')).toBe(LIGHT_FULL_DISTANCE)
    expect(glslFloat(marchSource, 'LIGHT_HALF_DISTANCE')).toBe(LIGHT_HALF_DISTANCE)
    expect(glslFloat(marchSource, 'EMPTY_SKIP')).toBe(EMPTY_SKIP)
  })

  it('円周率の桁が一致する', () => {
    // **`Math.PI` ではない。**GLSL が桁を切って書いてあるので、そのまま写す
    expect(glslFloat(marchSource, 'TAU_PI')).toBe(TAU_PI)
    expect(TAU_PI).not.toBe(Math.PI)
  })

  it('ループの上限が一致する', () => {
    // GLSL は名前を付けずに書いてある。本文の形で読む
    const main = marchSource.match(/for \(int i = 0; i < (\d+); i\+\+\) \{\n\s*if \(t >= end/)
    expect(main, '主マーチのループが見つからない').not.toBeNull()
    expect(Number(main![1])).toBe(MARCH_LOOP_LIMIT)

    const light = marchSource.match(/for \(int i = 0; i < (\d+); i\+\+\) \{\n\s*if \(i >= steps\)/)
    expect(light, '光マーチのループが見つからない').not.toBeNull()
    expect(Number(light![1])).toBe(LIGHT_MARCH_LIMIT)

    const octaves = marchSource.match(/for \(int n = 0; n < (\d+); n\+\+\)/)
    expect(octaves, '多重散乱のループが見つからない').not.toBeNull()
    expect(Number(octaves![1])).toBe(MULTI_SCATTER_OCTAVES)
  })

  it('光マーチの最初の歩幅が一致する', () => {
    const m = marchSource.match(/float stepSize = ([0-9.]+);/)
    expect(m, '光マーチの歩幅が見つからない').not.toBeNull()
    expect(Number(m![1])).toBe(LIGHT_STEP_BASE)
  })

  it('検査そのものが働くことを、存在しない名前で確かめる', () => {
    expect(marchSource.match(/const float NOT_A_MARCH_CONSTANT = /)).toBeNull()
  })
})

/**
 * 時間方向の足し込みの定数。
 *
 * `cloudResolve.frag` は雲層の高さを自分でもう一度書いている。**密度の
 * 定義とは別の写し**なので、ここでも突き合わせる
 */
describe('足し込みの定数', () => {
  it('雲層の高さが density.glsl と一致する', () => {
    expect(glslFloat(resolveSource, 'CLOUD_BOTTOM')).toBe(CLOUD_BOTTOM)
    expect(glslFloat(resolveSource, 'CLOUD_TOP')).toBe(CLOUD_TOP)
  })

  it('代表距離の式が一致する', () => {
    // `if (abs(dirY) < 1e-5) return 8000.0;` と `if (far <= 0.0) return 8000.0;`
    const fallback = [...resolveSource.matchAll(/return ([0-9.]+);/g)].map((m) =>
      Number(m[1]),
    )
    expect(fallback.length, '代表距離の既定が見つからない').toBe(2)
    for (const v of fallback) expect(v).toBe(RESOLVE_FALLBACK_DISTANCE)

    const m = resolveSource.match(
      /mix\(near, min\(far, ([0-9.]+)\), ([0-9.]+)\)/,
    )
    expect(m, '代表点の式が見つからない').not.toBeNull()
    expect(Number(m![1])).toBe(RESOLVE_FAR_CLAMP)
    expect(Number(m![2])).toBe(RESOLVE_SLAB_MIX)
  })

  it('死んだ uniform を戻していない', () => {
    // 宣言されて毎フレーム代入されていたが本文が一度も読んでいなかった。
    // 段 13 の後半で落とした
    expect(resolveSource.includes('previousCameraPosition')).toBe(false)
  })
})
