import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  TRAIL_DRAG_TIME,
  TRAIL_EMIT_SECONDS,
  TRAIL_FALL,
  TRAIL_ROOT_FADE,
  TRAIL_SPEED_SCALE,
  trailCameraFade,
  trailEmission,
  trailRootFade,
  trailOffset,
} from '../../src/render/weapons/explosionTrails'

describe('爆発の白い煙の尾', () => {
  const out = new THREE.Vector3()

  it('破片は減速しながら飛び、速さ × 倍率 × 時定数で止まる', () => {
    const dir = { x: 1, y: 0, z: 0 }
    expect(trailOffset(dir, 50, 0, out).length()).toBe(0)
    const near = trailOffset(dir, 50, 0.1, out).x
    const far = trailOffset(dir, 50, 30, out).x
    expect(near).toBeGreaterThan(0)
    expect(far).toBeCloseTo(50 * TRAIL_SPEED_SCALE * TRAIL_DRAG_TIME, 3)
    // 減速するので、最初の 0.1 秒は後の 0.1 秒より長く飛ぶ
    const later = trailOffset(dir, 50, 1.1, out).x - trailOffset(dir, 50, 1.0, out).x
    expect(near).toBeGreaterThan(later)
  })

  it('破片は落ちる', () => {
    const y = trailOffset({ x: 1, y: 0, z: 0 }, 50, 2, out).y
    expect(y).toBeCloseTo(-0.5 * TRAIL_FALL * 4)
  })

  it('煙は放ち始めがいちばん濃く、燃え尽きたら出ない', () => {
    expect(trailEmission(0)).toBe(1)
    expect(trailEmission(TRAIL_EMIT_SECONDS / 2)).toBeCloseTo(0.5)
    expect(trailEmission(TRAIL_EMIT_SECONDS + 0.01)).toBe(0)
    expect(trailEmission(-0.01)).toBe(0)
  })

  it('火の玉の中の煙は出さず、外へ出たら濃くする', () => {
    // **火の芯の上に白い煙を乗せない。**距離は煙の点と「いまの」火の玉の中心とのもの
    // **期待値を定数から作らない。**`TRAIL_ROOT_FADE` から作ると、定数を壊したときに
    // 期待値も一緒に動いて素通りした（歯型 `trail-root-over-fire` が生き残った）
    expect(trailRootFade(10, 20), '半径の半分の所は火の玉の中').toBe(0)
    expect(trailRootFade(30, 20), '半径の 1.5 倍の所は外').toBe(1)
    const mid = trailRootFade(((TRAIL_ROOT_FADE.from + TRAIL_ROOT_FADE.to) / 2) * 20, 20)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })

  it('カメラの近くの煙は薄くして、視界を覆わない', () => {
    // **近い撃墜で、太い白い筋がカメラの手前を横切って HUD の中央まで覆った**
    // （段 29f の hud-mission-failed、48,567 画素）。期待値は固定の数で書く
    expect(trailCameraFade(10), '10 m は消す').toBe(0)
    expect(trailCameraFade(80), '80 m は薄めない').toBe(1)
    const mid = trailCameraFade(40)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })
})
