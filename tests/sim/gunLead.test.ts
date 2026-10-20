import { describe, it, expect } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { Rng } from '@sim/rng'
import { FIXED_DT } from '@sim/loop'
import { Gun, MUZZLE_SPEED, bulletTimeToRange } from '@sim/weapons/gun'
import { GUN_ASSIST_ANGLE, GUN_SNAP_RANGE, createGunLead, solveGunLead } from '@sim/weapons/gunLead'
import { createWorldFromScript } from '@sim/world'

/**
 * 機銃の未来位置（Phase 10 の段 D4、ADR 0032）。録画の照準は敵が近いと敵に重なる。弾が届くときに相手が
 * いる位置と、そこへ弾を届ける向きを出す
 */

/** `aim` の向きに 1 発撃ち、相手が等速で動くとして、いちばん近づいた距離 m を返す（散布なし） */
function missDistance(muzzle: Vec3, own: Vec3, target: Vec3, tv: Vec3, aim: Vec3): number {
  const gun = new Gun(4, Infinity)
  const up = new Vec3(0, 1, 0)
  const right = new Vec3().crossVectors(aim, up).normalize()
  const u = new Vec3().crossVectors(right, aim)
  // 散布を消すため、乱数が 0.5 と 0.5 を返す代わりの器を渡す（spread = (0.5 + 0.5 − 1)·σ = 0）
  const rng = { next: () => 0.5 } as unknown as Rng
  gun.fire(1, true, muzzle, aim, right, u, own, rng)
  // 1 ステップのあいだは弾も相手も直線とみて、相手から見た弾の線分といちばん近い距離を取る
  // （当たり判定も弾の線分で見る。ステップの端だけでは 1,000 m/s を超える相対の速さで数 m 外れて見える）
  let best = Infinity
  const b = gun.bulletAt(0)
  const prev = new Vec3()
  const cur = new Vec3()
  const seg = new Vec3()
  const p = new Vec3()
  prev.subVectors(b.position, target)
  for (let i = 0; i < 2.5 / FIXED_DT; i++) {
    gun.advance(FIXED_DT, -1e9)
    if (b.life <= 0) break
    const t = (i + 1) * FIXED_DT
    cur.copy(b.position).sub(p.copy(target).addScaledVector(tv, t))
    seg.subVectors(cur, prev)
    const k = Math.min(1, Math.max(0, -prev.dot(seg) / seg.lengthSq()))
    best = Math.min(best, p.copy(prev).addScaledVector(seg, k).length())
    prev.copy(cur)
  }
  return best
}

describe('solveGunLead', () => {
  it('同じ速さで真っすぐ前を飛ぶ相手には、ほぼ機首の向きで、重力のぶんだけ上を向く', () => {
    const own = new Vec3(0, 0, -250)
    const lead = solveGunLead(new Vec3(0, 3000, 0), own, new Vec3(0, 3000, -500), own, createGunLead())
    // 抗力は機体の速さのぶんも効くので、式（`bulletTimeToRange`）より少し長い
    expect(Math.abs(lead.time - bulletTimeToRange(500, MUZZLE_SPEED))).toBeLessThan(0.05)
    expect(lead.aim.y).toBeGreaterThan(0)
    expect(lead.aim.z).toBeLessThan(-0.999)
  })

  it('横切る相手の未来位置は、弾が届く時間ぶん相手の進む先', () => {
    const own = new Vec3(0, 0, -250)
    const tv = new Vec3(150, 0, -250)
    const target = new Vec3(0, 3000, -600)
    const lead = solveGunLead(new Vec3(0, 3000, 0), own, target, tv, createGunLead())
    expect(lead.future.x).toBeCloseTo(target.x + tv.x * lead.time, 6)
    expect(lead.future.x).toBeGreaterThan(50)
  })

  it.each([
    ['真っすぐ前 500 m', new Vec3(0, 3000, -500), new Vec3(0, 0, -250)],
    ['横切る 600 m', new Vec3(0, 3000, -600), new Vec3(150, 0, -250)],
    ['上へ逃げる 700 m', new Vec3(50, 3020, -700), new Vec3(0, 60, -230)],
    ['向かってくる 800 m', new Vec3(30, 3000, -800), new Vec3(0, 0, 250)],
  ])('%s: 解いた向きに撃った弾が、相手から 0.5 m 以内を通る（抗力と重力の近似の確かめ）', (_, target, tv) => {
    const muzzle = new Vec3(0, 3000, 0)
    const own = new Vec3(0, 0, -250)
    const lead = solveGunLead(muzzle, own, target, tv, createGunLead())
    expect(missDistance(muzzle, own, target, tv, lead.aim)).toBeLessThan(0.5)
  })

  it('吸い付く距離は 800 m、弾を寄せる角は 5 度（ユーザーの決定）', () => {
    expect(GUN_SNAP_RANGE).toBe(800)
    expect(GUN_ASSIST_ANGLE).toBeCloseTo((5 * Math.PI) / 180, 12)
  })
})

describe('照準の吸い付き（Combat）', () => {
  function snappedAt(offset: Vec3): boolean {
    const script = {
      name: 'gun-snap',
      seed: 1,
      spawn: { altitude: 3000, speed: 250 },
      targets: [{ offset, speed: 250 }],
      keyframes: [],
    }
    const { world, player } = createWorldFromScript(script as never)
    world.step(player.at(0, world.player))
    return world.combat.gunSnapped
  }

  it('600 m 前の相手には吸い付く', () => {
    expect(snappedAt(new Vec3(0, 0, -600))).toBe(true)
  })

  it('900 m 前の相手には吸い付かない（800 m より遠い）', () => {
    expect(snappedAt(new Vec3(0, 0, -900))).toBe(false)
  })

  it('機首から 45 度の相手には吸い付かない（30 度より外）', () => {
    expect(snappedAt(new Vec3(500, 0, -500))).toBe(false)
  })
})
