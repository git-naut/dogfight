import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { FIXED_DT } from '@sim/loop'
import { Target } from '@sim/target'
import type { Combatant } from '@sim/combatant'
import { Lock, SEEKER_ACQUIRE_TIME } from '@sim/weapons/lock'
import { Missile } from '@sim/weapons/missile'

/**
 * 撃たれる側の口。
 *
 * 型が合っているだけでは足りない。**`Target` ではないものを武装の全経路に
 * 通して、実際に成立することを見る。**Phase 6 の敵機は `Aircraft` を保有する
 * 別の形になるので、ここで「Target のどの性質にも寄りかかっていない」ことを
 * 固定しておかないと、敵機を入れる段で初めて足りない項目が出る。
 */

const ORIGIN = new Vec3(0, 3000, 0)

/**
 * 最小限の `Combatant`。
 *
 * `Target` の実装を一切使わない。等速直線で飛ぶだけで、迎角もバンクも
 * 定常旋回も持たない。**姿勢は無回転。**これで当たり判定が通るなら、
 * カプセルの向きは `orientation` からだけ来ていることになる。
 */
class Drone implements Combatant {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()
  integrity: number
  /** `damage()` が呼ばれた回数。二重に数えていないかを見る */
  damageCalls = 0

  constructor(position: Vec3, velocity: Vec3, integrity = 60) {
    this.position.copy(position)
    this.velocity.copy(velocity)
    this.integrity = integrity
  }

  get speed(): number {
    return this.velocity.length()
  }

  get alive(): boolean {
    return this.integrity > 0
  }

  damage(amount: number): boolean {
    this.damageCalls++
    if (this.integrity <= 0) return false
    this.integrity -= amount
    return this.integrity <= 0
  }

  step(dt: number): void {
    if (!this.alive) return
    this.position.addScaledVector(this.velocity, dt)
  }
}

describe('Combatant', () => {
  it('Target が満たす', () => {
    const target: Combatant = new Target(
      { offset: new Vec3(0, 0, -2000), speed: 240 },
      ORIGIN,
    )
    expect(target.alive).toBe(true)
    expect(target.speed).toBe(240)
    expect(target.position.z).toBeCloseTo(-2000, 6)
  })

  it('落ちた瞬間だけ true を返す', () => {
    const drone = new Drone(new Vec3(), new Vec3(), 3)
    expect(drone.damage(1)).toBe(false)
    expect(drone.damage(1)).toBe(false)
    expect(drone.damage(1)).toBe(true)
    // 落ちたあとの弾では二重に数えない
    expect(drone.damage(1)).toBe(false)
    expect(drone.alive).toBe(false)
  })

  it('Target でなくてもシーカーが捕捉する', () => {
    const drone = new Drone(new Vec3(0, 3000, -4000), new Vec3(0, 0, -240))
    const lock = new Lock()
    const position = new Vec3(0, 3000, 0)
    const velocity = new Vec3(0, 0, -250)
    const orientation = new Quat()

    const steps = Math.ceil(SEEKER_ACQUIRE_TIME / FIXED_DT) + 1
    for (let i = 0; i < steps; i++) {
      drone.step(FIXED_DT)
      lock.step(position, velocity, orientation, [drone], FIXED_DT)
    }

    expect(lock.state).toBe('locked')
    expect(lock.index).toBe(0)
    // 同じ向きへ 250 で追い、相手は 240。差の 10 m/s だけ詰まる
    expect(lock.closingSpeed).toBeCloseTo(10, 6)
  })

  it('Target でなくてもミサイルが当たる', () => {
    // 正面 3 km を横切らせる。誘導が効かないと外れる構図
    const drone = new Drone(new Vec3(600, 3000, -3000), new Vec3(-240, 0, 0))
    const missile = new Missile()
    missile.launch(new Vec3(0, 3000, 0), new Vec3(0, 0, -250), new Quat(), 0)

    let hit = false
    for (let i = 0; i < 120 * 20 && !hit; i++) {
      drone.step(FIXED_DT)
      hit = missile.step(FIXED_DT, drone)
    }

    expect(hit).toBe(true)
    expect(missile.hitTarget).toBe(true)
  })
})
