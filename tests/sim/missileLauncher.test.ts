import { describe, expect, it } from 'vitest'
import { createWorldFromScript } from '@sim/world'
import { MISSILE_COUNT, MISSILE_RELOAD, PYLON_OFFSETS } from '@sim/combat'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'

/**
 * 左右の発射機（段 C3、ADR 0030）。録画（lesson 5）は左右を交互に撃ち、撃った側は印が下から満ちる
 * まで撃てない（コマ 20022 で撃って 20152 で満ちた、4.3 秒）。続けて撃てるのは 2 発まで
 */
const HZ = 120

/** 8 km 先の的にロックして、`presses` 秒に引き金を引く（押した次のフレームで離す） */
function fly(presses: number[], seconds: number) {
  const keyframes = presses.flatMap((t) => [
    { frame: Math.round(t * HZ), input: { fireMissile: true } },
    { frame: Math.round(t * HZ) + 1, input: { fireMissile: false } },
  ])
  const script = {
    name: 'launcher',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 0, -8000), speed: 240 }],
    keyframes,
  }
  const { world, player } = createWorldFromScript(script as never)
  const fired: number[] = []
  let last = 0
  for (let f = 0; f < seconds * HZ; f++) {
    world.step(player.at(f, world.player))
    if (world.combat.missilesFired > last) {
      last = world.combat.missilesFired
      fired.push(f / HZ)
    }
  }
  return { world, fired }
}

describe('左右の発射機', () => {
  it('満ちるのは 4.3 秒（録画 130 コマ）', () => {
    expect(MISSILE_RELOAD).toBe(4.3)
  })

  it('続けて撃てるのは 2 発。3 発目は左が満ちるまで出ない', () => {
    const first = 2
    const { fired } = fly([first, first + 0.2, first + 0.4, first + MISSILE_RELOAD - 0.1, first + MISSILE_RELOAD + 0.1], 8)
    expect(fired.length).toBe(3)
    expect(fired[1]! - fired[0]!).toBeLessThan(0.3)
    // 3 発目は 1 発目から 4.3 秒より後
    expect(fired[2]! - fired[0]!).toBeGreaterThanOrEqual(MISSILE_RELOAD)
  })

  it('撃った側は 0 から満ち直し、左右を交互に使う', () => {
    const { world } = fly([2], 2 + MISSILE_RELOAD / 2)
    const [left, right] = world.combat.launchers
    expect(left.progress).toBeGreaterThan(0.45)
    expect(left.progress).toBeLessThan(0.55)
    expect(right.progress).toBe(1)
  })

  it('残りが尽きたら両方とも空になる', () => {
    const presses = Array.from({ length: MISSILE_COUNT + 2 }, (_, i) => 2 + i * (MISSILE_RELOAD / 2 + 0.05))
    const { world } = fly(presses, 2 + (MISSILE_COUNT + 2) * (MISSILE_RELOAD / 2 + 0.05) + 1)
    expect(world.combat.missilesLeft).toBe(0)
    expect(world.combat.launchers.every((l) => l.empty)).toBe(true)
  })

  /**
   * 段 B9。撃つ側の吊るし（内側のパイロンの下）から放つ。発射したステップの位置を機体の座標に戻して、
   * 左は −x、右は +x にあることを見る
   */
  it('左は左の吊るしから、右は右の吊るしから出る', () => {
    const presses = [2, 2.2]
    const keyframes = presses.flatMap((t) => [
      { frame: Math.round(t * HZ), input: { fireMissile: true } },
      { frame: Math.round(t * HZ) + 1, input: { fireMissile: false } },
    ])
    const script = {
      name: 'launcher-side',
      seed: 20260816,
      spawn: { altitude: 3000, speed: 250 },
      targets: [{ offset: new Vec3(0, 0, -8000), speed: 240 }],
      keyframes,
    }
    const { world, player } = createWorldFromScript(script as never)
    const local: Vec3[] = []
    let last = 0
    for (let f = 0; f < 3 * HZ; f++) {
      world.step(player.at(f, world.player))
      if (world.combat.missilesFired > last) {
        last = world.combat.missilesFired
        // 撃つ処理はステップの最後（機体を進めたあと）なので、発射したステップのミサイルの位置が放った点
        const missile = world.combat.missiles.filter((m) => m.state === 'flying').at(-1)!
        const offset = new Vec3().subVectors(missile.position, world.player.position)
        local.push(new Quat().copy(world.player.orientation).invert().rotate(offset))
      }
    }
    expect(local.length).toBe(2)
    for (const [i, side] of [-1, 1].entries()) {
      const p = local[i]!
      expect(Math.sign(p.x)).toBe(side)
      expect(Math.abs(p.x)).toBeCloseTo(PYLON_OFFSETS[1].x, 0)
      expect(p.y).toBeCloseTo(PYLON_OFFSETS[1].y, 0)
    }
  })

  it('残り 1 発になったら、撃った側は満ち直さない', () => {
    const presses = Array.from({ length: MISSILE_COUNT - 1 }, (_, i) => 2 + i * (MISSILE_RELOAD / 2 + 0.05))
    const { world } = fly(presses, 2 + (MISSILE_COUNT - 1) * (MISSILE_RELOAD / 2 + 0.05) + 1)
    expect(world.combat.missilesLeft).toBe(1)
    expect(world.combat.launchers.filter((l) => l.empty).length).toBe(1)
  })
})
