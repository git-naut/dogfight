import { describe, it, expect } from 'vitest'
import {
  createScreenPoint,
  directionFromAzimuthElevation,
  elevationOf,
  headingOf,
  projectDirection,
  projectPoint,
  wrapAngle,
} from '@hud/project'

/**
 * HUD の投影。
 *
 * three に触らず、ビュー射影行列を数値として受け取る形にしてある。だから
 * ここで算術そのものを固定できる。**HUD の線が 1 画素ずれる類の退行は
 * スクリーンショット回帰では捕まらない**（標的機で測ったとおり、許容差は
 * 4,608 画素まで許す）。数値で押さえる意味がここにある。
 *
 * 検証用の行列は three を使わず自分で組む。カメラを原点に置いて -Z を向かせ、
 * 標準の透視投影を列優先で並べたもの。ビュー行列が単位行列になるので、
 * ビュー射影行列は透視投影行列そのものになる。
 */

const W = 1280
const H = 720
const FOV = (66.4 * Math.PI) / 180
const ASPECT = W / H
const NEAR = 5
const FAR = 200_000

/** 原点で -Z を向くカメラのビュー射影行列。列優先 16 要素 */
function perspective(fov = FOV, aspect = ASPECT): Float64Array {
  const t = Math.tan(fov / 2)
  const m = new Float64Array(16)
  m[0] = 1 / (aspect * t)
  m[5] = 1 / t
  m[10] = -(FAR + NEAR) / (FAR - NEAR)
  m[11] = -1
  m[14] = (-2 * FAR * NEAR) / (FAR - NEAR)
  m[15] = 0
  return m
}

const M = perspective()
const CENTER_X = W / 2
const CENTER_Y = H / 2

/** 仰角 θ の方向が来るはずの画面 y。tan θ / tan(fov/2) が NDC */
function expectedY(elevation: number, fov = FOV): number {
  const ndc = Math.tan(elevation) / Math.tan(fov / 2)
  return (0.5 - ndc * 0.5) * H
}

describe('方向の投影', () => {
  it('真正面は画面の中心', () => {
    const p = projectDirection(M, 0, 0, -1, W, H)
    expect(p.inFront).toBe(true)
    expect(p.x).toBeCloseTo(CENTER_X, 9)
    expect(p.y).toBeCloseTo(CENTER_Y, 9)
  })

  it('仰角ぶん上へ、tan で写る', () => {
    for (const deg of [1, 5, 10, 20, 30]) {
      const e = (deg * Math.PI) / 180
      const d = directionFromAzimuthElevation(0, e)
      const p = projectDirection(M, d.x, d.y, d.z, W, H)
      expect(p.y, `${deg} 度`).toBeCloseTo(expectedY(e), 6)
      // 上を向くほど画面の上（y が小さい）
      expect(p.y, `${deg} 度`).toBeLessThan(CENTER_Y)
    }
  })

  it('伏角は画面の下', () => {
    const d = directionFromAzimuthElevation(0, (-10 * Math.PI) / 180)
    const p = projectDirection(M, d.x, d.y, d.z, W, H)
    expect(p.y).toBeGreaterThan(CENTER_Y)
  })

  it('方位角が正なら画面の右', () => {
    const d = directionFromAzimuthElevation((10 * Math.PI) / 180, 0)
    const p = projectDirection(M, d.x, d.y, d.z, W, H)
    expect(p.x).toBeGreaterThan(CENTER_X)
    expect(p.y).toBeCloseTo(CENTER_Y, 9)
  })

  it('画角の端がちょうど画面の端に来る', () => {
    const d = directionFromAzimuthElevation(0, FOV / 2)
    const p = projectDirection(M, d.x, d.y, d.z, W, H)
    expect(p.y).toBeCloseTo(0, 6)
  })

  it('後ろの方向は inFront が false', () => {
    const p = projectDirection(M, 0, 0, 1, W, H)
    expect(p.inFront).toBe(false)
  })

  it('真横は inFront が false。同次除算が 0 で割る', () => {
    const p = projectDirection(M, 1, 0, 0, W, H)
    expect(p.inFront).toBe(false)
  })

  it('方向は長さに依存しない。無限遠の点なので', () => {
    const a = projectDirection(M, 0, 0.5, -1, W, H)
    const b = projectDirection(M, 0, 50, -100, W, H)
    expect(b.x).toBeCloseTo(a.x, 9)
    expect(b.y).toBeCloseTo(a.y, 9)
  })
})

describe('点の投影', () => {
  it('正面 1,000 m の点は中心', () => {
    const p = projectPoint(M, 0, 0, -1000, W, H)
    expect(p.inFront).toBe(true)
    expect(p.x).toBeCloseTo(CENTER_X, 9)
    expect(p.y).toBeCloseTo(CENTER_Y, 9)
  })

  it('近いほど大きくずれる。1/z で効く', () => {
    const near = projectPoint(M, 20, 0, -100, W, H)
    const far = projectPoint(M, 20, 0, -1000, W, H)
    expect(near.x - CENTER_X).toBeCloseTo((far.x - CENTER_X) * 10, 6)
  })

  it('カメラの後ろの点は inFront が false', () => {
    const p = projectPoint(M, 0, 0, 100, W, H)
    expect(p.inFront).toBe(false)
  })

  it('方向と違って位置に依存する', () => {
    const dir = projectDirection(M, 0, 100, -1000, W, H)
    const pt = projectPoint(M, 0, 100, -1000, W, H)
    expect(pt.y).toBeCloseTo(dir.y, 6)
    // 同じ向きでも遠い点はより中心へ寄る
    const farther = projectPoint(M, 0, 100, -10_000, W, H)
    expect(Math.abs(farther.y - CENTER_Y)).toBeLessThan(Math.abs(pt.y - CENTER_Y))
  })

  it('器を渡すと使い回す。毎フレーム作らないため', () => {
    const out = createScreenPoint()
    const returned = projectPoint(M, 0, 0, -1000, W, H, out)
    expect(returned).toBe(out)
  })
})

describe('画角を変えると写る位置が変わる', () => {
  it('画角が広いほど同じ仰角が中心寄りに来る', () => {
    const e = (20 * Math.PI) / 180
    const d = directionFromAzimuthElevation(0, e)
    const narrow = projectDirection(perspective((60 * Math.PI) / 180), d.x, d.y, d.z, W, H)
    const wide = projectDirection(perspective((78 * Math.PI) / 180), d.x, d.y, d.z, W, H)
    expect(Math.abs(wide.y - CENTER_Y)).toBeLessThan(Math.abs(narrow.y - CENTER_Y))
  })
})

describe('方位と仰角', () => {
  it('-Z が方位 0', () => {
    expect(headingOf(0, 0, -1)).toBeCloseTo(0, 12)
  })

  it('+X が方位 90 度。右が正', () => {
    expect(headingOf(1, 0, 0)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('+Z が方位 180 度', () => {
    expect(Math.abs(headingOf(0, 0, 1))).toBeCloseTo(Math.PI, 12)
  })

  it('仰角は上が正', () => {
    expect(elevationOf(0, 1, -1)).toBeCloseTo(Math.PI / 4, 12)
    expect(elevationOf(0, -1, -1)).toBeCloseTo(-Math.PI / 4, 12)
    expect(elevationOf(0, 0, -1)).toBeCloseTo(0, 12)
  })

  it('真上を向くと方位が定まらないので 0 を返す', () => {
    expect(headingOf(0, 1, 0)).toBe(0)
    expect(elevationOf(0, 1, 0)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('方位と仰角から作った方向を戻すと一致する', () => {
    for (const az of [-2.5, -1, 0, 0.7, 3]) {
      for (const el of [-1.2, -0.3, 0, 0.4, 1.1]) {
        const d = directionFromAzimuthElevation(az, el)
        expect(headingOf(d.x, d.y, d.z), `${az} ${el}`).toBeCloseTo(wrapAngle(az), 9)
        expect(elevationOf(d.x, d.y, d.z), `${az} ${el}`).toBeCloseTo(el, 9)
      }
    }
  })
})

describe('wrapAngle', () => {
  it('半開区間 [-π, π) へ畳む', () => {
    expect(wrapAngle(0)).toBeCloseTo(0, 12)
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI * 0.5, 12)
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI * 0.5, 12)
    expect(wrapAngle(Math.PI * 4)).toBeCloseTo(0, 12)
  })

  it('端は -π 側に寄せる。±π のあいだで数字がちらつかないため', () => {
    expect(wrapAngle(Math.PI)).toBeCloseTo(-Math.PI, 12)
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI, 12)
    expect(wrapAngle(-Math.PI)).toBeCloseTo(-Math.PI, 12)
  })

  it('何周してもずれない', () => {
    for (const turns of [-5, -2, 0, 3, 7]) {
      expect(wrapAngle(0.75 + turns * Math.PI * 2), `${turns} 周`).toBeCloseTo(0.75, 9)
    }
  })

  it('方位の差が 350 度ではなく -10 度になる', () => {
    const a = (5 * Math.PI) / 180
    const b = (355 * Math.PI) / 180
    expect((wrapAngle(a - b) * 180) / Math.PI).toBeCloseTo(10, 9)
  })
})
