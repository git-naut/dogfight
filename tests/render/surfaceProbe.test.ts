import { describe, expect, it } from 'vitest'
import {
  SURFACE_PROBE_SHADOW_CENTER,
  SURFACE_PROBE_SHADOW_EXTENT,
  SURFACE_PROBE_SHADOW_SIZE,
  SURFACE_PROBE_SIDE,
  SURFACE_PROBE_SKY_RADIANCE,
  SURFACE_PROBE_SUN_DIRECTION,
  SURFACE_PROBE_SUN_RADIANCE,
  SURFACE_PROBE_WAVE_TIME,
  TERRAIN_PROBE_REGION,
  WATER_PROBE_REGIONS,
  surfaceBranchCounts,
  surfaceLevels,
  surfaceProbePoint,
  surfaceProbeShadowData,
  type SurfaceRegion,
} from '@render/terrain/surfaceProbe'
import { defaultTerrain, TERRAIN_EXTENT } from '@sim/terrain'

/**
 * 地表と海面の突き合わせに使う固定入力。
 *
 * **矩形が枝を通らなければ、移植を間違えても一致する。**段 13・14・16 で
 * 3 度踏んだ形なので、通ることを CPU 側でも縛る。GPU 側の実際の画素数は
 * `tests/e2e/node-path.spec.ts` が両側で突き合わせる。
 */

const terrain = defaultTerrain()

/** 矩形の 64x64 を CPU で走査して、条件に当たる点を数える */
function scan(
  region: SurfaceRegion,
  predicate: (x: number, z: number, height: number, toCamera: number) => boolean,
): number {
  let hits = 0
  for (let row = 0; row < SURFACE_PROBE_SIDE; row++) {
    for (let col = 0; col < SURFACE_PROBE_SIDE; col++) {
      const { x, z } = surfaceProbePoint(region, col, row)
      const height = terrain.heightAt(x, z)
      const dx = x - region.camera.x
      const dy = height - region.camera.y
      const dz = z - region.camera.z
      if (predicate(x, z, height, Math.sqrt(dx * dx + dy * dy + dz * dz))) hits++
    }
  }
  return hits
}

describe('矩形の中の標本点', () => {
  it('矩形の中に収まる', () => {
    const first = surfaceProbePoint(TERRAIN_PROBE_REGION, 0, 0)
    const last = surfaceProbePoint(
      TERRAIN_PROBE_REGION,
      SURFACE_PROBE_SIDE - 1,
      SURFACE_PROBE_SIDE - 1,
    )
    expect(first.x).toBeGreaterThan(TERRAIN_PROBE_REGION.origin.x)
    expect(last.x).toBeLessThan(
      TERRAIN_PROBE_REGION.origin.x + TERRAIN_PROBE_REGION.span,
    )
    expect(first.z).toBeGreaterThan(TERRAIN_PROBE_REGION.origin.z)
    expect(last.z).toBeLessThan(
      TERRAIN_PROBE_REGION.origin.z + TERRAIN_PROBE_REGION.span,
    )
  })

  it('高さ場の定義域に収まる', () => {
    // 縁で止める処理は `heightProbe.ts` の 2 つ目の区画が見ている。
    // こちらは色の検査なので、定義域の外へ出さない
    const half = TERRAIN_EXTENT / 2
    for (const region of [TERRAIN_PROBE_REGION, ...WATER_PROBE_REGIONS]) {
      const far = surfaceProbePoint(
        region,
        SURFACE_PROBE_SIDE - 1,
        SURFACE_PROBE_SIDE - 1,
      )
      expect(Math.abs(far.x)).toBeLessThan(half)
      expect(Math.abs(far.z)).toBeLessThan(half)
    }
  })
})

describe('地表の矩形が枝を通る', () => {
  const pixels = SURFACE_PROBE_SIDE * SURFACE_PROBE_SIDE

  it('雪の高さまで届く', () => {
    // 雪は標高 2,000 m から掛かる。届かない矩形では一度も通らない
    const high = scan(TERRAIN_PROBE_REGION, (_x, _z, h) => h > 2000)
    expect(high, `2,000 m 超が ${high} 点`).toBeGreaterThan(50)
  })

  it('海面近くの低い所も含む', () => {
    // 砂と草の境目（20〜140 m）を通さないと、下の帯の写し間違いが出ない
    const low = scan(TERRAIN_PROBE_REGION, (_x, _z, h) => h < 140)
    expect(low, `140 m 未満が ${low} 点`).toBeGreaterThan(50)
  })

  it('摂動の効く距離とその外の両方を含む', () => {
    // `strength > 0.01` はおよそ 2,850 m 以内。片側だけだと枝が固定される
    const near = scan(TERRAIN_PROBE_REGION, (_x, _z, _h, d) => d < 2850)
    const far = pixels - near
    expect(near, `近い点が ${near}`).toBeGreaterThan(pixels / 10)
    expect(far, `遠い点が ${far}`).toBeGreaterThan(pixels / 10)
  })
})

describe('海面の矩形が枝を通る', () => {
  /** 1 タップの粗い深さ。GLSL の `terrainHeightNearest` と同じ丸め */
  function nearestHeight(x: number, z: number): number {
    const half = terrain.extent / 2
    const grid = (v: number) => Math.floor((v + half) / terrain.texel - 0.5 + 0.5)
    const clampi = (v: number) => Math.min(Math.max(v, 0), terrain.size - 1)
    return terrain.heights[clampi(grid(z)) * terrain.size + clampi(grid(x))]!
  }

  it('1 タップの枝と双三次の枝の両方を通る', () => {
    let tap = 0
    let bicubic = 0
    for (const region of WATER_PROBE_REGIONS) {
      tap += scan(region, (x, z) => nearestHeight(x, z) < -250)
      bicubic += scan(region, (x, z) => nearestHeight(x, z) >= -250)
    }
    expect(tap, `1 タップが ${tap} 点`).toBeGreaterThan(100)
    expect(bicubic, `双三次が ${bicubic} 点`).toBeGreaterThan(100)
  })

  it('白波の立つ浅さを含む', () => {
    let foam = 0
    for (const region of WATER_PROBE_REGIONS) {
      foam += scan(region, (_x, _z, h) => Math.max(-h, 0) < 16)
    }
    expect(foam, `白波が ${foam} 点`).toBeGreaterThan(100)
  })

  it('波を落とす遠さを含む', () => {
    // 波の法線は 12 km で切れる。1 つ目の矩形だけでは届かない
    let far = 0
    for (const region of WATER_PROBE_REGIONS) {
      // 海面は高度 0 の板なので、標高ではなく 0 からの距離で測る
      far += scan(region, (x, z) => {
        const dx = x - region.camera.x
        const dz = z - region.camera.z
        const d = Math.sqrt(dx * dx + region.camera.y ** 2 + dz * dz)
        return 1 - smoothstep(2000, 12000, d) < 0.01
      })
    }
    expect(far, `波を落とす点が ${far}`).toBeGreaterThan(100)
  })

  const smoothstep = (a: number, b: number, x: number): number => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
  }
})

describe('固定入力の値', () => {
  it('放射輝度の 3 成分が別々', () => {
    // 等しいと成分を取り違えても一致してしまう
    const sun = SURFACE_PROBE_SUN_RADIANCE
    const sky = SURFACE_PROBE_SKY_RADIANCE
    expect(new Set([sun.x, sun.y, sun.z]).size).toBe(3)
    expect(new Set([sky.x, sky.y, sky.z]).size).toBe(3)
  })

  it('太陽が雲影のずらしの枝を通る高さにある', () => {
    // `sunDirectionWorld.y > 0.05` でしか足元へのずらしが効かない
    expect(SURFACE_PROBE_SUN_DIRECTION.y).toBeGreaterThan(0.05)
  })

  it('太陽の向きが正規化されている', () => {
    const d = SURFACE_PROBE_SUN_DIRECTION
    const length = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
    expect(length).toBeCloseTo(1, 3)
  })

  it('波の位相が 0 でない', () => {
    // 0 だと 3 本の波の cos が揃い、向きを取り違えても差が出にくい
    expect(SURFACE_PROBE_WAVE_TIME).not.toBe(0)
  })

  it('雲影の矩形が地表の矩形を覆う', () => {
    const half = SURFACE_PROBE_SHADOW_EXTENT / 2
    const center = SURFACE_PROBE_SHADOW_CENTER
    const region = TERRAIN_PROBE_REGION
    expect(region.origin.x).toBeGreaterThan(center.x - half)
    expect(region.origin.x + region.span).toBeLessThan(center.x + half)
    expect(region.origin.z).toBeGreaterThan(center.z - half)
    expect(region.origin.z + region.span).toBeLessThan(center.z + half)
  })
})

describe('雲影の代わりの中身', () => {
  const data = surfaceProbeShadowData()

  it('大きさが合う', () => {
    expect(data.length).toBe(SURFACE_PROBE_SHADOW_SIZE * SURFACE_PROBE_SHADOW_SIZE)
  })

  it('一様でない', () => {
    // 一様だと雲影の式を間違えても一致してしまう
    expect(new Set(data).size).toBeGreaterThan(64)
    expect(Math.min(...data)).toBeLessThan(30)
    expect(Math.max(...data)).toBeGreaterThan(230)
  })
})

describe('枝の数え方', () => {
  const rgba = (values: number[][]): Uint8Array => {
    const out = new Uint8Array(values.length * 4)
    values.forEach((v, i) => {
      out[i * 4] = v[0]!
      out[i * 4 + 1] = v[1]!
      out[i * 4 + 2] = v[2]!
      out[i * 4 + 3] = v[3]!
    })
    return out
  }

  it('成分ごとに 255 を数える', () => {
    expect(
      surfaceBranchCounts(
        rgba([
          [255, 0, 255, 0],
          [0, 255, 0, 255],
        ]),
      ),
    ).toEqual({ r: 1, g: 1, b: 1, a: 1, other: 0 })
  })

  it('0 でも 255 でもない値を別に数える', () => {
    // 枝の書き分けが壊れて中間の値が出たときに、数が合っているだけで通さない
    expect(surfaceBranchCounts(rgba([[128, 0, 0, 255]])).other).toBe(1)
  })

  it('階調を数える', () => {
    expect(
      surfaceLevels(
        rgba([
          [10, 0, 0, 0],
          [20, 0, 0, 0],
          [10, 0, 0, 0],
        ]),
      ),
    ).toBe(2)
  })
})
