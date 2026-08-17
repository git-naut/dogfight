import { describe, it, expect } from 'vitest'
import {
  Terrain,
  TERRAIN_EXTENT,
  TERRAIN_SIZE,
  TERRAIN_TEXEL,
  TERRAIN_SEED,
  SEABED_HEIGHT,
  terrainIslands,
} from '@sim/terrain'
import { Vec3 } from '@sim/vec3'

/**
 * 地形の高さ場。
 *
 * ここは three もブラウザも要らない純粋な数値なので、GLSL に写す前に
 * 境界条件をすべて確定させておく。雲で `geometry.ts` に同じことをして、
 * シェーダ側で疑う範囲がだいぶ狭まった。
 */

/** 雲底の高度 m。density.glsl の CLOUD_BOTTOM と揃える */
const CLOUD_BOTTOM = 1200

const terrain = new Terrain(TERRAIN_SEED)
const half = TERRAIN_EXTENT / 2

/** テクセル (ix, iz) の中心のワールド座標 */
function texelCenter(ix: number, iz: number): { x: number; z: number } {
  return {
    x: -half + (ix + 0.5) * TERRAIN_TEXEL,
    z: -half + (iz + 0.5) * TERRAIN_TEXEL,
  }
}

describe('高さ場の寸法', () => {
  it('テクセルが割り切れる大きさになっている', () => {
    expect(TERRAIN_TEXEL).toBe(48)
    expect(TERRAIN_SIZE * TERRAIN_TEXEL).toBe(TERRAIN_EXTENT)
  })

  it('配列の長さが一辺の二乗', () => {
    expect(terrain.heights.length).toBe(TERRAIN_SIZE * TERRAIN_SIZE)
  })
})

describe('双三次補間', () => {
  it('格子点では焼いた値をそのまま返す', () => {
    // t=0 のとき Catmull-Rom は p1 を厳密に返す。ここがずれると
    // 描画（頂点シェーダ）と物理（heightAt）で地形の形が食い違う
    for (const [ix, iz] of [
      [512, 512],
      [300, 700],
      [1, 1],
      [1022, 1022],
    ]) {
      const { x, z } = texelCenter(ix!, iz!)
      const baked = terrain.heights[iz! * TERRAIN_SIZE + ix!]!
      expect(terrain.heightAt(x, z)).toBeCloseTo(baked, 4)
    }
  })

  it('格子をまたいでも段差が出ない', () => {
    // 主峰の斜面をテクセル境界を跨いで細かく歩く
    const z = -11_500
    let previous = terrain.heightAt(-3_000, z)
    let maxJump = 0
    for (let x = -3_000; x < -2_000; x += 1.5) {
      const h = terrain.heightAt(x, z)
      maxJump = Math.max(maxJump, Math.abs(h - previous))
      previous = h
    }
    // 1.5 m 進むあいだの高さ変化。斜面でも 1 m を超えたら折れ目がある
    expect(maxJump).toBeLessThan(1)
  })

  it('定義域の外は海底になる', () => {
    for (const [x, z] of [
      [half + 5_000, 0],
      [-half - 5_000, 0],
      [0, half + 20_000],
      [half * 3, -half * 3],
    ]) {
      expect(terrain.heightAt(x!, z!)).toBeCloseTo(SEABED_HEIGHT, 3)
    }
  })
})

describe('決定論', () => {
  it('同じシードから同じ配列が出る', () => {
    const again = new Terrain(TERRAIN_SEED)
    expect(again.heights.length).toBe(terrain.heights.length)
    // 全要素を回す。1 要素でも違えばリプレイと回帰が壊れる
    let differences = 0
    for (let i = 0; i < terrain.heights.length; i++) {
      if (again.heights[i] !== terrain.heights[i]) differences++
    }
    expect(differences).toBe(0)
  })

  it('統計が縮退していない', () => {
    expect(terrain.stats.min).toBeCloseTo(SEABED_HEIGHT, 3)
    expect(terrain.stats.max).toBeGreaterThan(1_500)
    // 面積の大半は海なので平均は海底寄りになる
    expect(terrain.stats.mean).toBeLessThan(0)
    expect(terrain.stats.mean).toBeGreaterThan(SEABED_HEIGHT)
  })
})

describe('法線', () => {
  it('単位ベクトルになっている', () => {
    const out = new Vec3()
    for (const [x, z] of [
      [0, 0],
      [1_500, -11_500],
      [-3_000, -9_000],
      [13_000, -17_500],
    ]) {
      terrain.normalAt(x!, z!, out)
      expect(out.length()).toBeCloseTo(1, 6)
    }
  })

  it('外洋では真上を向く', () => {
    const out = terrain.normalAt(20_000, 20_000)
    expect(out.approxEquals(new Vec3(0, 1, 0), 1e-6)).toBe(true)
  })

  it('斜面では上を向きつつ傾く', () => {
    // 主峰の中心から外れた斜面
    const out = terrain.normalAt(1_500 + 3_500, -11_500)
    expect(out.y).toBeGreaterThan(0)
    expect(out.y).toBeLessThan(1)
    // 中心へ向かって登るので、法線は外向きに倒れる
    expect(out.x).toBeGreaterThan(0)
  })
})

describe('島の配置', () => {
  const islands = terrainIslands()

  it('原点は外洋である', () => {
    // 全スクリプトが原点にスポーンする。島の上に湧くと low-pass が即墜落する
    expect(terrain.isWater(0, 0)).toBe(true)
    expect(terrain.heightAt(0, 0)).toBeLessThan(-100)
  })

  it('スポーン地点の周囲 3 km も外洋である', () => {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const x = Math.cos(angle) * 3_000
      const z = Math.sin(angle) * 3_000
      expect(terrain.isWater(x, z)).toBe(true)
    }
  })

  it('直径が 8 km から 15 km に収まる', () => {
    for (const island of islands) {
      expect(island.radius * 2).toBeGreaterThanOrEqual(8_000)
      expect(island.radius * 2).toBeLessThanOrEqual(15_000)
    }
  })

  it('海岸が定義域の縁から 2 km 以上内側にある', () => {
    // 定義域の外は海底へクランプするので、島が縁に掛かると崖が見える。
    // 海岸線はノイズで崩すぶん、半径の 1.4 倍を見て余裕を取る
    for (const island of islands) {
      const reach = Math.max(Math.abs(island.x), Math.abs(island.z)) + island.radius * 1.4
      expect(half - reach).toBeGreaterThan(2_000)
    }
  })

  it('主峰だけが雲底を突き抜ける', () => {
    const [main, ...others] = islands
    expect(terrain.heightAt(main!.x, main!.z)).toBeGreaterThan(CLOUD_BOTTOM)
    for (const island of others) {
      // 中心が最も高い。そこが雲底より下なら島全体が雲の下にある
      expect(terrain.heightAt(island.x, island.z)).toBeLessThan(CLOUD_BOTTOM)
    }
  })

  it('島の中心は陸である', () => {
    for (const island of islands) {
      expect(terrain.isWater(island.x, island.z)).toBe(false)
    }
  })

  it('島は海で隔てられている', () => {
    // 全方位を海と決めつけない。主峰の島と第 2 の島は半径の和に近い距離に
    // 置いてあり、方向によっては隣の島に当たる（狭い海峡になる）。
    // 環状に測って過半が海であることを見る
    for (const island of islands) {
      let water = 0
      const samples = 16
      for (let i = 0; i < samples; i++) {
        const angle = (i / samples) * Math.PI * 2
        const x = island.x + Math.cos(angle) * island.radius * 1.5
        const z = island.z + Math.sin(angle) * island.radius * 1.5
        if (terrain.isWater(x, z)) water++
      }
      expect(water).toBeGreaterThan(samples / 2)
    }
  })
})
