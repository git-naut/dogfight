import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import {
  selectPatches,
  distanceToBox,
  morphFactor,
  lodRange,
  triangleCount,
  patchCellSize,
  type TerrainPatch,
  type SelectOptions,
} from '@render/terrain/layout'
import { TERRAIN_EXTENT } from '@sim/terrain'
import { PRESET_ORDER, QUALITY_PRESETS } from '@render/quality'

/**
 * 地形パッチの選び方。
 *
 * three を import しない。GLSL と three に写す前に境界条件をここで固める。
 */

const HIGH: SelectOptions = {
  extent: TERRAIN_EXTENT,
  maxDepth: QUALITY_PRESETS.high.terrainLodLevels - 1,
  distanceScale: QUALITY_PRESETS.high.lodDistanceScale,
}

describe('矩形までの距離', () => {
  it('内側なら 0', () => {
    expect(distanceToBox(0, 0, -100, -100, 200)).toBe(0)
    expect(distanceToBox(-99, 99, -100, -100, 200)).toBe(0)
  })

  it('辺の外なら垂直距離', () => {
    expect(distanceToBox(0, 300, -100, -100, 200)).toBeCloseTo(200, 6)
    expect(distanceToBox(-400, 0, -100, -100, 200)).toBeCloseTo(300, 6)
  })

  it('角の外なら斜めの距離', () => {
    // 角 (100, 100) から (400, 500) までは 300, 400 の直角三角形
    expect(distanceToBox(400, 500, -100, -100, 200)).toBeCloseTo(500, 6)
  })
})

describe('パッチの選択', () => {
  it('定義域を隙間なく覆う', () => {
    // 四分木なので面積の合計が定義域と厳密に一致する。
    // リング方式だと親の穴と子の範囲がずれて隙間が出る
    for (const [x, z] of [
      [0, 0],
      [1_500, -11_000],
      [20_000, 20_000],
      [-60_000, 0],
    ]) {
      const patches = selectPatches(x!, z!, HIGH)
      const area = patches.reduce((sum, p) => sum + p.size * p.size, 0)
      expect(area).toBeCloseTo(TERRAIN_EXTENT * TERRAIN_EXTENT, 0)
    }
  })

  it('パッチどうしが重ならない', () => {
    const patches = selectPatches(1_500, -11_000, HIGH)
    for (let i = 0; i < patches.length; i++) {
      for (let j = i + 1; j < patches.length; j++) {
        const a = patches[i]!
        const b = patches[j]!
        const overlapX = Math.min(a.x + a.size, b.x + b.size) - Math.max(a.x, b.x)
        const overlapZ = Math.min(a.z + a.size, b.z + b.size) - Math.max(a.z, b.z)
        // どちらかの重なりが 0 以下なら接しているだけ
        expect(Math.min(overlapX, overlapZ)).toBeLessThanOrEqual(0)
      }
    }
  })

  it('同じカメラ位置からは同じ並びが出る', () => {
    const a = selectPatches(3_000, -5_000, HIGH)
    const b = selectPatches(3_000, -5_000, HIGH)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toEqual(b[i])
    }
  })

  it('隣り合うパッチの深さの差が 1 以内', () => {
    // 差が 2 以上あると、頂点を親の格子へ寄せても辺が繋がらない。
    // 分割距離がノードの一辺に比例していれば、この性質は自動的に成り立つ
    const patches = selectPatches(1_500, -11_000, HIGH)
    let checked = 0
    for (let i = 0; i < patches.length; i++) {
      for (let j = i + 1; j < patches.length; j++) {
        const a = patches[i]!
        const b = patches[j]!
        if (!touches(a, b)) continue
        checked++
        expect(Math.abs(a.depth - b.depth)).toBeLessThanOrEqual(1)
      }
    }
    // 検査が空回りしていないことを確かめる
    expect(checked).toBeGreaterThan(20)
  })

  it('カメラを含むパッチが最も細かい', () => {
    const camera = { x: 1_500, z: -11_000 }
    const patches = selectPatches(camera.x, camera.z, HIGH)
    const containing = patches.filter(
      (p) => distanceToBox(camera.x, camera.z, p.x, p.z, p.size) === 0,
    )
    // 重なりがないので、カメラを含むパッチはちょうど 1 枚
    expect(containing).toHaveLength(1)
    expect(containing[0]!.depth).toBe(HIGH.maxDepth)
  })

  it('定義域の外から見ても破綻しない', () => {
    // 地形の外まで飛べる。そのとき最も粗い段だけで覆われるはず
    const patches = selectPatches(200_000, 200_000, HIGH)
    expect(patches.length).toBe(1)
    expect(patches[0]!.depth).toBe(0)
    expect(patches[0]!.size).toBe(TERRAIN_EXTENT)
  })

  it('配列を使い回しても壊れない', () => {
    const out: TerrainPatch[] = []
    selectPatches(0, 0, HIGH, out)
    const first = out.length
    selectPatches(200_000, 200_000, HIGH, out)
    expect(out.length).toBe(1)
    expect(first).toBeGreaterThan(1)
  })
})

describe('三角形の予算', () => {
  it('どのプリセットでも 90 万を下回る', () => {
    // ポリゴン予算はシーン合計 1.5M（CLAUDE.md）。Phase 4 の機体 9 機で
    // 550k 前後を見込むので、地形はそれを引いた範囲に収める。
    // 実測は low 31k / medium 132k / high 451k / ultra 819k
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      const patches = selectPatches(1_500, -11_000, {
        extent: TERRAIN_EXTENT,
        maxDepth: q.terrainLodLevels - 1,
        distanceScale: q.lodDistanceScale,
      })
      expect(triangleCount(patches, q.terrainPatchCells)).toBeLessThan(900_000)
    }
  })

  it('High の最も細かいセルが高さ場のテクセルより細かい', () => {
    const patches = selectPatches(1_500, -11_000, HIGH)
    const deepest = patches.reduce((best, p) => (p.depth > best.depth ? p : best), patches[0]!)
    const cell = patchCellSize(deepest, QUALITY_PRESETS.high.terrainPatchCells)
    // 高さ場は 48 m 刻み。それより細かく刻めば双三次の滑らかさが出る
    expect(cell).toBeLessThanOrEqual(48)
  })
})

describe('親の格子への寄せ', () => {
  it('寄せ始める前は 0、寄せ終われば 1', () => {
    expect(morphFactor(0, 100, 200)).toBe(0)
    expect(morphFactor(100, 100, 200)).toBe(0)
    expect(morphFactor(150, 100, 200)).toBeCloseTo(0.5, 6)
    expect(morphFactor(200, 100, 200)).toBe(1)
    expect(morphFactor(999, 100, 200)).toBe(1)
  })

  it('幅がゼロでも NaN を出さない', () => {
    expect(morphFactor(150, 200, 200)).toBe(0)
  })

  it('分割距離の内側で寄せ終わる', () => {
    // 寄せ終わる距離が分割距離を超えると、まだ細かいままの隣と繋がらない
    for (const patch of selectPatches(1_500, -11_000, HIGH)) {
      expect(patch.morphEnd).toBeLessThanOrEqual(
        lodRange(patch.size, HIGH.distanceScale) + 1e-6,
      )
      expect(patch.morphStart).toBeLessThan(patch.morphEnd)
    }
  })
})

/** 2 つのパッチが辺で接しているか */
function touches(a: TerrainPatch, b: TerrainPatch): boolean {
  const shareX =
    Math.abs(a.x + a.size - b.x) < 1e-6 || Math.abs(b.x + b.size - a.x) < 1e-6
  const shareZ =
    Math.abs(a.z + a.size - b.z) < 1e-6 || Math.abs(b.z + b.size - a.z) < 1e-6
  const overlapX = Math.min(a.x + a.size, b.x + b.size) - Math.max(a.x, b.x) > 1e-6
  const overlapZ = Math.min(a.z + a.size, b.z + b.size) - Math.max(a.z, b.z) > 1e-6
  return (shareX && overlapZ) || (shareZ && overlapX)
}

/**
 * 頂点シェーダがモーフの基準に何を使っているか。
 *
 * **組み込みの `cameraPosition` を使ってはいけない。**影を焼くパスでは
 * three が光源のカメラを入れてくるので、基準が描くパスごとに変わる。
 * いまは地形が影を投げないので絵に出ないが、Phase 9 でカスケード影を
 * 入れた瞬間に裂け目として出る。**出てから気づく形にしない。**
 */
describe('モーフの基準位置', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/render/terrain/shaders/terrain.vert', import.meta.url)),
    'utf8',
  )

  /** コメントを外した本文。**注記に名前が出るだけで落ちる形にしない** */
  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  it('頂点シェーダは組み込みの cameraPosition を使わない', () => {
    expect(body.includes('cameraPosition')).toBe(false)
  })

  it('明示した uniform を宣言して使っている', () => {
    expect(body).toContain('uniform vec3 morphOrigin;')
    expect(body).toContain('distance(morphOrigin.xz, unmorphed)')
  })

  it('コメントを外す処理が本文を消していない', () => {
    // 検査そのものが働くことの確認。全部消してしまえば上の 2 件は
    // 「無いこと」を空振りで通す
    expect(body).toContain('void main()')
    expect(body.includes('uniform vec3 notAUniform;')).toBe(false)
    // 注記のほうには名前が残っている（本文だけを見ていることの裏取り）
    expect(source.includes('cameraPosition')).toBe(true)
  })
})
