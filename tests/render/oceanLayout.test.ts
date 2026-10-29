import { describe, it, expect } from 'vitest'
import {
  OCEAN_LEAF,
  OCEAN_LOD_BIAS,
  OCEAN_PATCH_CELLS,
  distanceToPatch,
  oceanCascadeLod,
  oceanCascadeSkipped,
  oceanUvOffset,
  oceanCoverage,
  oceanEdgeFade,
  oceanMorph,
  oceanRootSize,
  oceanTriangleCount,
  selectOceanPatches,
  type OceanCamera,
  type OceanPatch,
} from '@render/ocean/oceanLayout'
import { lodRange } from '@render/terrain/layout'
import { PRESET_ORDER, QUALITY_PRESETS } from '@render/quality'

/**
 * 海面のパッチの選び方（段 S4a-1）。
 *
 * 地形の四分木（`terrain.test.ts`）と同じ性質を縛る。覆い切り・重なりなし・深さの差 1 以内・
 * カメラの真下が最も細かい・寄せ終わりが分割距離の内側。海はカメラを中心に敷き、距離に
 * 高さを入れるので、そのぶんの性質（根の格子への寄せ・高さで粗くなる）を足す。
 */

const HIGH = QUALITY_PRESETS.high
const LEVELS = HIGH.oceanLodLevels
const SCALE = HIGH.lodDistanceScale

/** 低空・中空・高空と、根の格子の境目の上 */
const CAMERAS: OceanCamera[] = [
  { x: 0, y: 3, z: 0 },
  { x: 1_234.5, y: 40, z: -8_765.25 },
  { x: -20_000, y: 600, z: 15_000 },
  { x: oceanRootSize(LEVELS) * 7, y: 10, z: -oceanRootSize(LEVELS) * 3 },
]

describe('根の大きさと覆う範囲', () => {
  it('最も細かい段が 0.5 m、根は 0.5·2^(段数−1)', () => {
    expect(OCEAN_LEAF).toBe(0.5)
    expect(oceanRootSize(1)).toBe(0.5)
    expect(oceanRootSize(12)).toBe(1_024)
    expect(oceanRootSize(13)).toBe(2_048)
  })

  it('カメラは覆う範囲の真ん中の根に入る', () => {
    for (const camera of CAMERAS) {
      const root = oceanRootSize(LEVELS)
      const c = oceanCoverage(camera, LEVELS)
      expect(c.size).toBe(3 * root)
      expect(camera.x).toBeGreaterThanOrEqual(c.x0 + root)
      expect(camera.x).toBeLessThan(c.x0 + 2 * root)
      expect(camera.z).toBeGreaterThanOrEqual(c.z0 + root)
      expect(camera.z).toBeLessThan(c.z0 + 2 * root)
    }
  })

  it('覆う範囲は根の格子に乗り、根 1 つ動くまで変わらない', () => {
    // パッチの境目を世界に固定する。カメラと一緒に滑らせると波がパッチの上を流れて見える
    const root = oceanRootSize(LEVELS)
    const a = oceanCoverage({ x: 10, y: 5, z: 10 }, LEVELS)
    const b = oceanCoverage({ x: root - 1e-3, y: 5, z: root - 1e-3 }, LEVELS)
    const c = oceanCoverage({ x: root, y: 5, z: 10 }, LEVELS)
    expect(a).toEqual(b)
    expect(c.x0 - a.x0).toBe(root)
    expect(Number.isInteger(a.x0 / root)).toBe(true)
    expect(Number.isInteger(a.z0 / root)).toBe(true)
  })
})

describe('矩形までの 3 次元の距離', () => {
  it('真上なら高さ', () => {
    expect(distanceToPatch({ x: 5, y: 30, z: 5 }, 0, 0, 10)).toBeCloseTo(30, 9)
  })

  it('外なら水平と高さの合成', () => {
    expect(distanceToPatch({ x: 13, y: 4, z: 5 }, 0, 0, 10)).toBeCloseTo(5, 9)
  })

  it('海面の下は高さ 0 とみなす', () => {
    expect(distanceToPatch({ x: 5, y: -2, z: 5 }, 0, 0, 10)).toBe(0)
  })
})

describe('パッチの選択', () => {
  it('覆う範囲を隙間なく覆う', () => {
    for (const camera of CAMERAS) {
      const c = oceanCoverage(camera, LEVELS)
      const patches = selectOceanPatches(camera, LEVELS, SCALE)
      const area = patches.reduce((sum, p) => sum + p.size * p.size, 0)
      expect(area).toBe(c.size * c.size)
      for (const p of patches) {
        expect(p.x).toBeGreaterThanOrEqual(c.x0)
        expect(p.z).toBeGreaterThanOrEqual(c.z0)
        expect(p.x + p.size).toBeLessThanOrEqual(c.x0 + c.size)
        expect(p.z + p.size).toBeLessThanOrEqual(c.z0 + c.size)
      }
    }
  })

  it('パッチどうしが重ならない', () => {
    const patches = selectOceanPatches(CAMERAS[1]!, LEVELS, SCALE)
    for (let i = 0; i < patches.length; i++) {
      for (let j = i + 1; j < patches.length; j++) {
        const a = patches[i]!
        const b = patches[j]!
        const overlapX = Math.min(a.x + a.size, b.x + b.size) - Math.max(a.x, b.x)
        const overlapZ = Math.min(a.z + a.size, b.z + b.size) - Math.max(a.z, b.z)
        expect(Math.min(overlapX, overlapZ)).toBeLessThanOrEqual(0)
      }
    }
  })

  it('同じカメラからは同じ並び', () => {
    const a = selectOceanPatches(CAMERAS[1]!, LEVELS, SCALE)
    const b = selectOceanPatches(CAMERAS[1]!, LEVELS, SCALE)
    expect(b).toEqual(a)
  })

  it('隣り合うパッチの深さの差が 1 以内', () => {
    for (const camera of CAMERAS) {
      const patches = selectOceanPatches(camera, LEVELS, SCALE)
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
      expect(checked).toBeGreaterThan(20)
    }
  })

  it('カメラの真下が最も細かい', () => {
    for (const camera of CAMERAS) {
      const patches = selectOceanPatches(camera, LEVELS, SCALE)
      const below = patches.filter((p) => distanceToPatch({ ...camera, y: 0 }, p.x, p.z, p.size) === 0)
      // 格子の角の上なら 4 枚に当たる
      expect(below.length).toBeGreaterThanOrEqual(1)
      const deepest = Math.max(...patches.map((p) => p.depth))
      for (const p of below) expect(p.depth).toBe(deepest)
    }
  })

  it('海面すれすれなら最も細かい段（0.5 m）まで割る', () => {
    const camera = { x: 10.1, y: 0.2, z: 10.1 }
    const patches = selectOceanPatches(camera, LEVELS, SCALE)
    const below = patches.find((p) => distanceToPatch({ ...camera, y: 0 }, p.x, p.z, p.size) === 0)!
    expect(below.depth).toBe(LEVELS - 1)
    expect(below.size).toBe(OCEAN_LEAF)
  })

  it('高く上がるほど真下が粗くなる', () => {
    // 3 次元で測る理由。高度 600 m から 0.5 m のセルは画素より細かい
    const depthBelow = (y: number) => {
      const camera = { x: 100.25, y, z: 100.25 }
      const p = selectOceanPatches(camera, LEVELS, SCALE).find(
        (q) => distanceToPatch({ ...camera, y: 0 }, q.x, q.z, q.size) === 0,
      )!
      return p.depth
    }
    const depths = [2, 20, 200, 2_000].map(depthBelow)
    for (let i = 1; i < depths.length; i++) expect(depths[i]!).toBeLessThan(depths[i - 1]!)
  })

  it('配列を使い回しても壊れない', () => {
    const out: OceanPatch[] = []
    selectOceanPatches(CAMERAS[0]!, LEVELS, SCALE, out)
    const near = out.length
    selectOceanPatches({ x: 0, y: 50_000, z: 0 }, LEVELS, SCALE, out)
    // 雲の上からは根の 9 枚だけ
    expect(out.length).toBe(9)
    expect(near).toBeGreaterThan(9)
  })
})

describe('寄せ（モーフ）', () => {
  it('分割距離の内側で寄せ終わる', () => {
    for (const p of selectOceanPatches(CAMERAS[1]!, LEVELS, SCALE)) {
      expect(p.morphEnd).toBeLessThanOrEqual(lodRange(p.size, SCALE) + 1e-9)
      expect(p.morphStart).toBeLessThan(p.morphEnd)
    }
  })

  it('粗い隣と接する辺では細かい側が寄せ終わっている', () => {
    // CDLOD で隙間が出ない条件。細かい側の辺の頂点が親の格子へ寄り切っていれば、
    // 粗い側の頂点と同じ位置に乗る。3 次元の距離でも、点までの距離 ≥ 箱までの距離なので成り立つ
    for (const camera of CAMERAS) {
      const patches = selectOceanPatches(camera, LEVELS, SCALE)
      let checked = 0
      for (const fine of patches) {
        for (const coarse of patches) {
          if (coarse.depth !== fine.depth - 1 || !touches(fine, coarse)) continue
          for (const [px, pz] of sharedEdgePoints(fine, coarse)) {
            checked++
            expect(oceanMorph(camera, px, pz, fine)).toBe(1)
          }
        }
      }
      expect(checked).toBeGreaterThan(0)
    }
  })

  it('カメラの高さが分割距離の 1.73〜2 倍でも、粗い隣と接する辺は寄せ終わっている', () => {
    // 水平の距離だけで寄せを測ると、ここで寄り切らない。細かい側の分割距離を R として、
    // 親が割れる（3 次元で 2R 未満）のに粗い隣は割れない（2R 超）辺が、水平に R 未満の所に
    // 来うるのは、高さが √3 R〜2R の帯にあるときだけ。帯の中に高さを置く
    let checked = 0
    for (const s of [1, 2, 4, 8, 16, 32, 64]) {
      const R = lodRange(s, SCALE)
      const camera = { x: 100.3, y: 1.85 * R, z: -50.7 }
      const patches = selectOceanPatches(camera, LEVELS, SCALE)
      for (const fine of patches) {
        for (const coarse of patches) {
          if (coarse.depth !== fine.depth - 1 || !touches(fine, coarse)) continue
          for (const [px, pz] of sharedEdgePoints(fine, coarse)) {
            checked++
            expect(oceanMorph(camera, px, pz, fine), `高さ ${camera.y} m、${fine.size} m の辺 (${px}, ${pz})`).toBe(1)
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('同じ深さの隣どうしは辺の上で同じ寄せ量', () => {
    // 寄せ量はパッチでなく点とカメラで決まるので、同じ深さなら辺の頂点が一致する
    const camera = CAMERAS[1]!
    const patches = selectOceanPatches(camera, LEVELS, SCALE)
    let checked = 0
    for (const a of patches) {
      for (const b of patches) {
        if (a === b || a.depth !== b.depth || !touches(a, b)) continue
        for (const [px, pz] of sharedEdgePoints(a, b)) {
          checked++
          expect(oceanMorph(camera, px, pz, a)).toBe(oceanMorph(camera, px, pz, b))
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('縁で変位を絞る', () => {
  const camera = CAMERAS[1]!
  const root = oceanRootSize(LEVELS)
  const c = oceanCoverage(camera, LEVELS)

  it('外の縁で 0、内側の根では 1', () => {
    expect(oceanEdgeFade(c.x0, c.z0 + c.size / 2, c, root)).toBe(0)
    expect(oceanEdgeFade(c.x0 + c.size, c.z0 + c.size / 2, c, root)).toBe(0)
    expect(oceanEdgeFade(c.x0 + c.size / 2, c.z0 + c.size, c, root)).toBe(0)
    // カメラのいる真ん中の根は全部 1
    for (const [fx, fz] of [
      [1, 1],
      [2, 2],
      [1.5, 1.5],
      [1, 2],
    ]) {
      expect(oceanEdgeFade(c.x0 + fx! * root, c.z0 + fz! * root, c, root)).toBe(1)
    }
  })

  it('縁へ向けて単調に減る', () => {
    let prev = 1
    for (let i = 0; i <= 100; i++) {
      const x = c.x0 + root - (root * i) / 100
      const f = oceanEdgeFade(x, c.z0 + c.size / 2, c, root)
      expect(f).toBeLessThanOrEqual(prev)
      prev = f
    }
    expect(prev).toBe(0)
  })
})

describe('三角形の予算', () => {
  it('どのプリセットでも 40 万を下回る', () => {
    // 地形（high 45 万・ultra 82 万、terrain.test）と合わせてシーンの 150 万の内に置く。
    // 実測は high 27 万・ultra 35 万（高度 2.5 m）。40 万は推測の線
    for (const name of PRESET_ORDER) {
      const q = QUALITY_PRESETS[name]
      for (const camera of [...CAMERAS, { x: 1_234.5, y: 2.5, z: -876.25 }]) {
        const patches = selectOceanPatches(camera, q.oceanLodLevels, q.lodDistanceScale)
        expect(oceanTriangleCount(patches)).toBeLessThan(400_000)
      }
    }
  })

  it('パッチのセルは 16', () => {
    expect(OCEAN_PATCH_CELLS).toBe(16)
  })
})

/** 2 つのパッチが辺で接しているか */
function touches(a: OceanPatch, b: OceanPatch): boolean {
  const shareX = a.x + a.size === b.x || b.x + b.size === a.x
  const shareZ = a.z + a.size === b.z || b.z + b.size === a.z
  const overlapX = Math.min(a.x + a.size, b.x + b.size) - Math.max(a.x, b.x) > 0
  const overlapZ = Math.min(a.z + a.size, b.z + b.size) - Math.max(a.z, b.z) > 0
  return (shareX && overlapZ) || (shareZ && overlapX)
}

/** a の頂点のうち、b と共有する辺に乗るもの */
function sharedEdgePoints(a: OceanPatch, b: OceanPatch): [number, number][] {
  const cell = a.size / OCEAN_PATCH_CELLS
  const pts: [number, number][] = []
  for (let k = 0; k <= OCEAN_PATCH_CELLS; k++) {
    const t = k * cell
    for (const [px, pz] of [
      [a.x, a.z + t],
      [a.x + a.size, a.z + t],
      [a.x + t, a.z],
      [a.x + t, a.z + a.size],
    ] as [number, number][]) {
      const onB =
        px >= b.x && px <= b.x + b.size && pz >= b.z && pz <= b.z + b.size &&
        (px === b.x || px === b.x + b.size || pz === b.z || pz === b.z + b.size)
      if (onB) pts.push([px, pz])
    }
  }
  return pts
}

describe('カスケードを引く段と uv', () => {
  it('頂点の間隔が texel 以下なら段 0 に半段の足し', () => {
    // web-ocean の `+ 0.5`。頂点の間隔より細かい波を半段ぼかす
    expect(OCEAN_LOD_BIAS).toBe(0.5)
    expect(oceanCascadeLod(0.001, 7.43, 256)).toBe(0.5)
    expect(oceanCascadeLod(7.43 / 256, 7.43, 256)).toBeCloseTo(0.5, 12)
  })

  it('間隔が texel の 2^k 倍なら段 k に半段の足し', () => {
    for (const k of [1, 3, 6]) {
      expect(oceanCascadeLod((7.43 / 256) * 2 ** k, 7.43, 256)).toBeCloseTo(k + 0.5, 12)
    }
  })

  it('最後の段（1 × 1）に届くカスケードは足さない', () => {
    expect(oceanCascadeSkipped(7.9, 256)).toBe(false)
    expect(oceanCascadeSkipped(8, 256)).toBe(true)
    expect(oceanCascadeSkipped(7, 128)).toBe(true)
  })

  it('uv の起点の端数は [0, 1)、負の起点でも', () => {
    for (const [o, L] of [
      [-3_071.25, 7.43],
      [2_050.5, 0.2617],
      [-0.1, 1103],
      [0, 39.7],
    ] as const) {
      const f = oceanUvOffset(o, L)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
      // 起点 / L との差が整数
      expect(Math.abs(o / L - f - Math.round(o / L - f))).toBeLessThan(1e-9)
    }
  })

  it('端数を足せば、起点からの差でワールドの uv と同じ位置を引く', () => {
    // GPU は (x − 起点)/L + 端数 で、CPU 参照は x/L で引く。差は整数（repeat で同じ texel）
    const L = 7.43
    const origin = -3_071.25
    for (const x of [-3_000.5, -1.25, 0, 17.75, 1_234.5]) {
      const gpu = (x - origin) / L + oceanUvOffset(origin, L)
      const d = gpu - x / L
      expect(Math.abs(d - Math.round(d))).toBeLessThan(1e-9)
    }
  })
})
