import { describe, it, expect } from 'vitest'
import { MISSILE_SEEKER_ANGLE, Missile } from '@sim/weapons/missile'
import type { HeatSource, Combatant } from '@sim/combatant'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'

/**
 * シーカーが熱源を選ぶ規則。
 *
 * **視野の内側にあるもののうち、視線角がいちばん小さいものを追う。**実機の
 * 赤外線シーカーは熱の強さでも選ぶが、ここは幾何だけで決めた。そのほうが
 * 「どの位置関係なら囮が効くか」を位置から説明でき、角度の境界を実測で
 * 固定できる。確率だとシードの再現に頼ることになる。
 *
 * **掴む先と殴る先を分けたことがこのファイルの主題。**囮を掴んだミサイルは
 * 囮の近くで爆発し、本来の標的は無傷になる。混ぜると「フレアを出したのに
 * 落ちる」という壊れ方をする。
 */

/** 姿勢を持たない熱源。フレアの代わり */
class Ember implements HeatSource {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  alive = true

  constructor(position: Vec3, velocity = new Vec3()) {
    this.position.copy(position)
    this.velocity.copy(velocity)
  }

  step(dt: number): void {
    this.position.addScaledVector(this.velocity, dt)
  }
}

/** 姿勢を持つ標的。`Target` の実装は使わない */
class Plane implements Combatant {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()
  integrity = 60

  constructor(position: Vec3, velocity = new Vec3()) {
    this.position.copy(position)
    this.velocity.copy(velocity)
  }

  get speed(): number {
    return this.velocity.length()
  }

  get alive(): boolean {
    return this.integrity > 0
  }

  damage(amount: number): boolean {
    if (this.integrity <= 0) return false
    this.integrity -= amount
    return this.integrity <= 0
  }

  step(dt: number): void {
    this.position.addScaledVector(this.velocity, dt)
  }
}

/** 機首 −Z で速度 v の状態から 1 ステップだけ進めて、掴んだ先を返す */
function trackedAfterOneStep(
  missilePosition: Vec3,
  missileVelocity: Vec3,
  target: Combatant | null,
  decoys: readonly HeatSource[],
): HeatSource | null {
  const missile = new Missile()
  missile.launch(missilePosition, missileVelocity, new Quat(), 0)
  // 安全解除の前でも掴む先は決まる。信管だけが待つ
  missile.step(FIXED_DT, target, decoys)
  return missile.tracked
}

describe('視野の判定', () => {
  const origin = new Vec3(0, 3000, 0)
  // 機首 −Z 方向へマッハ 2 相当
  const velocity = new Vec3(0, 0, -600)

  it('正面の熱源を掴む', () => {
    const ember = new Ember(new Vec3(0, 3000, -1000))
    expect(trackedAfterOneStep(origin, velocity, null, [ember])).toBe(ember)
  })

  it('視野の外は掴まない。真後ろは見えない', () => {
    const ember = new Ember(new Vec3(0, 3000, 1000))
    expect(trackedAfterOneStep(origin, velocity, null, [ember])).toBeNull()
  })

  /**
   * 視野の半角は 60 度。境界のすぐ内と外で切り替わることを確かめる。
   *
   * 進行方向 −Z から角度 θ の位置に置く。距離 1,000 m で
   * (sin θ · 1000, 0, −cos θ · 1000)。
   */
  it.each([
    { deg: 55, inside: true },
    { deg: 59, inside: true },
    { deg: 61, inside: false },
    { deg: 70, inside: false },
  ])('$deg 度 → 視野の内側 $inside', ({ deg, inside }) => {
    const rad = (deg * Math.PI) / 180
    const ember = new Ember(
      new Vec3(Math.sin(rad) * 1000, 3000, -Math.cos(rad) * 1000),
    )
    const tracked = trackedAfterOneStep(origin, velocity, null, [ember])
    expect(tracked === ember).toBe(inside)
  })

  it('視野の半角は 60 度', () => {
    expect((MISSILE_SEEKER_ANGLE * 180) / Math.PI).toBeCloseTo(60, 6)
  })

  it('消えた熱源は掴まない', () => {
    const ember = new Ember(new Vec3(0, 3000, -1000))
    ember.alive = false
    expect(trackedAfterOneStep(origin, velocity, null, [ember])).toBeNull()
  })
})

describe('視線角の小さい方を選ぶ', () => {
  const origin = new Vec3(0, 3000, 0)
  const velocity = new Vec3(0, 0, -600)

  it('標的より軸に近い囮を掴む', () => {
    // 標的は 20 度、囮は 5 度
    const plane = new Plane(new Vec3(342, 3000, -940))
    const ember = new Ember(new Vec3(87, 3000, -996))
    expect(trackedAfterOneStep(origin, velocity, plane, [ember])).toBe(ember)
  })

  it('囮が軸から遠ければ標的を掴んだまま', () => {
    // 標的は 5 度、囮は 40 度
    const plane = new Plane(new Vec3(87, 3000, -996))
    const ember = new Ember(new Vec3(643, 3000, -766))
    expect(trackedAfterOneStep(origin, velocity, plane, [ember])).toBe(plane)
  })

  /**
   * **距離では選ばない。**近くても軸から外れていれば掴まない。
   *
   * 実機の赤外線シーカーは強さ（距離の逆二乗）でも選ぶが、ここは幾何だけ。
   * 距離を混ぜると「囮を出した瞬間は必ず効く」ことになり、正面から撃たれた
   * ときも効いてしまう。
   */
  it('近くても軸から遠ければ選ばない', () => {
    // 標的は 3 度で 2,000 m 先、囮は 30 度で 100 m 先
    const plane = new Plane(new Vec3(105, 3000, -1997))
    const ember = new Ember(new Vec3(50, 3000, -87))
    expect(trackedAfterOneStep(origin, velocity, plane, [ember])).toBe(plane)
  })

  /**
   * **同点なら標的が残る。**`cos > bestCos` の狭義比較なので、先に評価した
   * 標的が勝つ。囮を機体と完全に同じ軸線上に置いても効かないということで、
   * これは意図した挙動。囮は軸から外れた位置へ落ちて初めて効く。
   */
  it('視線角が同じなら標的を掴んだまま', () => {
    const plane = new Plane(new Vec3(0, 3000, -1200))
    const ember = new Ember(new Vec3(0, 3000, -1100))
    expect(trackedAfterOneStep(origin, velocity, plane, [ember])).toBe(plane)
  })

  it('囮が複数あればいちばん軸に近いものを掴む', () => {
    const plane = new Plane(new Vec3(342, 3000, -940))
    const far = new Ember(new Vec3(259, 3000, -966))
    const near = new Ember(new Vec3(87, 3000, -996))
    expect(trackedAfterOneStep(origin, velocity, plane, [far, near])).toBe(near)
    // 順序を変えても同じものを選ぶ
    expect(trackedAfterOneStep(origin, velocity, plane, [near, far])).toBe(near)
  })
})

describe('掴む先と殴る先を分ける', () => {
  /**
   * 囮を掴んだミサイルは囮の近くで爆発し、標的は無傷。
   *
   * **この分離が壊れると「フレアを出したのに落ちる」。**囮を標的と同じ位置に
   * 置いても、爆発するのは囮に対してで、標的の耐久は減らない。
   */
  it('囮に当たっても標的の耐久は減らない', () => {
    const missile = new Missile()
    // **安全解除より遠くに置く。**ARM_TIME 0.5 秒 x 速度 600 m/s = 300 m
    // 進むので、300 m に置くと解除の瞬間には通り過ぎている。
    // **標的を軸から 2 度ずらす。**同じ軸上に置くと両方 0 度で同点になり、
    // 先に評価する標的が残る（`cos > bestCos` の狭義比較）
    const plane = new Plane(new Vec3(41.9, 3000, -1199.3))
    // 囮は軸上。標的より視線角が小さい
    const ember = new Ember(new Vec3(0, 3000, -1200))

    missile.launch(new Vec3(0, 3000, 0), new Vec3(0, 0, -600), new Quat(), 0)
    let detonated = false
    for (let i = 0; i < 240 && !detonated; i++) {
      detonated = missile.step(FIXED_DT, plane, [ember])
    }

    expect(missile.state).toBe('detonated')
    expect(missile.tracked).toBe(ember)
    // Combat が damage() を呼ぶかは tracked で決める。ここでは掴んだ先を見る
    expect(plane.integrity).toBe(60)
  })

  it('囮が無ければ標的を掴んで当たる', () => {
    const missile = new Missile()
    const plane = new Plane(new Vec3(0, 3000, -1200))

    missile.launch(new Vec3(0, 3000, 0), new Vec3(0, 0, -600), new Quat(), 0)
    let detonated = false
    for (let i = 0; i < 240 && !detonated; i++) {
      detonated = missile.step(FIXED_DT, plane, [])
    }

    expect(missile.state).toBe('detonated')
    expect(missile.tracked).toBe(plane)
  })

  /**
   * 囮が燃え尽きたら標的へ戻る。
   *
   * **視野に残っていることが条件。**戻る先が視野の外なら自律飛行のまま。
   */
  it('囮が消えたら標的へ戻る', () => {
    const missile = new Missile()
    const plane = new Plane(new Vec3(342, 3000, -940))
    const ember = new Ember(new Vec3(87, 3000, -996))

    missile.launch(new Vec3(0, 3000, 0), new Vec3(0, 0, -600), new Quat(), 0)
    missile.step(FIXED_DT, plane, [ember])
    expect(missile.tracked).toBe(ember)

    ember.alive = false
    missile.step(FIXED_DT, plane, [ember])
    expect(missile.tracked).toBe(plane)
  })
})

describe('姿勢のない熱源への信管', () => {
  /**
   * カプセルではなく球で判定する。
   *
   * **無回転の姿勢を渡すと機体の形のカプセルで判定してしまう。**フレアには
   * 向きがないので、殺傷半径だけの球で見る。
   */
  it('殺傷半径の内側で爆発する', () => {
    const missile = new Missile()
    // 囮を軸上、標的を 2 度ずらす。囮を掴ませる
    const ember = new Ember(new Vec3(0, 3000, -1200))
    const plane = new Plane(new Vec3(41.9, 3000, -1199.3))

    missile.launch(new Vec3(0, 3000, 0), new Vec3(0, 0, -600), new Quat(), 0)
    let detonated = false
    for (let i = 0; i < 240 && !detonated; i++) {
      detonated = missile.step(FIXED_DT, plane, [ember])
    }
    expect(missile.state).toBe('detonated')
    // 起爆の位置が囮の近く
    expect(missile.detonation.distanceTo(ember.position)).toBeLessThan(10)
  })

  /**
   * **1 ステップの移動が殺傷半径より長い。**マッハ 2 なら 1/120 秒で 5 m 進む。
   * 距離が閾値を割った瞬間だけを見ると跨いで通過する。線分との距離で見る。
   */
  it('高速ですれ違っても跨がない', () => {
    const missile = new Missile()
    // 正面から向かい合う。接近速度が大きい
    const ember = new Ember(new Vec3(0, 3000, -600), new Vec3(0, 0, 300))
    const plane = new Plane(new Vec3(0, 3000, -600), new Vec3(0, 0, 300))

    missile.launch(new Vec3(0, 3000, 0), new Vec3(0, 0, -600), new Quat(), 0)
    let detonated = false
    for (let i = 0; i < 240 && !detonated; i++) {
      ember.step(FIXED_DT)
      plane.step(FIXED_DT)
      detonated = missile.step(FIXED_DT, plane, [ember])
    }
    expect(missile.state).toBe('detonated')
  })
})
