import { describe, it, expect } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { DOORS, doorHinges, lowestHit } from '../../tools/f18e-doors.mjs'
import { identifyParts } from '../../tools/f18e-parts.mjs'

/**
 * 脚の扉（2026-10-08）。原本に扉は無いので板を足す。**位置が原本の形に合っているか**を、
 * 下から真上への光線（`lowestHit`）で確かめる。脚の部品は光線から外す
 */
const GLTF = fileURLToPath(new URL('../../assets/upstream/f18e/scene.gltf', import.meta.url))
const parts = identifyParts(GLTF)
const exclude = new Set(parts.gear.map((p) => p.raw.parent ?? p.name))
const nose = DOORS.filter((d) => d.leg === 'nose')
const main = DOORS.filter((d) => d.leg !== 'nose')

describe('前脚の扉', () => {
  // 前脚の扉 2 枚を合わせた範囲
  const xs = nose.flatMap((d) => d.corners.map((c) => c[0]))
  const zs = nose.flatMap((d) => d.corners.map((c) => c[2]))
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]

  it('扉の内側は格納部の開口（光線が奥の天井まで届く）、すぐ外は外板', () => {
    // **開口は完全な長方形ではない。**左前の角（x −0.16〜−0.12、z −6.1〜−5.74）に出っ張りが
    // あるので、内側の点は真ん中の高さの左右と、中心線の前寄り・後ろ寄りに取る
    const mid = (z0 + z1) / 2
    const inside = lowestHit(GLTF, [[0, mid], [x0 + 0.05, mid], [x1 - 0.05, mid], [0, z0 + 0.1], [0, z1 - 0.1]], exclude)
    for (const y of inside) expect(y!, '開口の中').toBeGreaterThan(0.3)
    const outside = lowestHit(GLTF, [[x0 - 0.04, (z0 + z1) / 2], [x1 + 0.04, (z0 + z1) / 2]], exclude)
    for (const y of outside) expect(y!, '開口のすぐ外').toBeLessThan(-0.15)
  })

  it('閉じたときの高さが開口の縁の外板と 2 cm 以内で合う', () => {
    const z = (z0 + z1) / 2
    const [left, right] = lowestHit(GLTF, [[x0 - 0.03, z], [x1 + 0.03, z]], exclude)
    const door = nose[0]!.corners
    // 扉は前後で傾くので、真ん中の高さで比べる
    const doorY = (door[0]![1] + door[1]![1]) / 2
    expect(Math.abs(doorY - left!)).toBeLessThan(0.02)
    expect(Math.abs(doorY - right!)).toBeLessThan(0.02)
  })
})

describe('主脚の扉', () => {
  it('閉じたときの高さが下面と 1.5 cm 以内で合う', () => {
    for (const d of main) {
      const c = d.corners
      const cx = (c[0]![0] + c[2]![0]) / 2
      const pts = [c[0]![2] + 0.2, (c[0]![2] + c[1]![2]) / 2, c[1]![2] - 0.2].map((z) => [cx, z] as [number, number])
      for (const y of lowestHit(GLTF, pts, exclude)) expect(Math.abs(y! - c[0]![1]), d.node).toBeLessThan(0.015)
    }
  })

  it('主脚の付け根（x ±0.475、z 0.05）の後ろ、畳む通り道を覆う', () => {
    for (const d of main) {
      const xs = d.corners.map((c) => c[0])
      const zs = d.corners.map((c) => c[2])
      const x = d.leg === 'left' ? -0.475 : 0.475
      expect(x).toBeGreaterThan(Math.min(...xs))
      expect(x).toBeLessThan(Math.max(...xs))
      expect(Math.min(...zs)).toBeLessThan(0.05)
      expect(Math.max(...zs)).toBeGreaterThan(1.2)
    }
  })
})

describe('扉の蝶番', () => {
  it('どの扉も、正の角で自由な縁が下がる（下へ開く）', () => {
    for (const h of doorHinges()) {
      const [a, , c] = h.corners
      const v = [0, 1, 2].map((k) => c![k]! - a![k]!)
      const u = h.axis
      const t = Math.PI / 2
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      const dot = u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!
      const y = v[1]! * Math.cos(t) + cross[1]! * Math.sin(t) + u[1]! * dot * (1 - Math.cos(t))
      expect(y, h.node).toBeLessThan(v[1]! - 0.1)
    }
  })

  it('前脚の扉は閉じても見せる（開口に蓋をする）、主脚の扉は閉じたら隠す', () => {
    for (const d of DOORS) expect(d.hideWhenClosed, d.node).toBe(d.leg !== 'nose')
  })
}, 120_000)
