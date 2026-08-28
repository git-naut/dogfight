import { describe, it, expect } from 'vitest'
import {
  Countermeasures,
  FLARE_BURN_SECONDS,
  FLARE_CAPACITY,
  FLARE_INTENSITY,
  FLARE_INTERVAL,
  FLARE_PER_DEPLOY,
  FLARE_FLASH_SECONDS,
  Flare,
  flashIntensity,
} from '@sim/weapons/flare'
import { Missile } from '@sim/weapons/missile'
import { AIRCRAFT_INTENSITY } from '@sim/combatant'
import type { Combatant } from '@sim/combatant'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'

/**
 * フレアと、それが効く条件。
 *
 * **幾何だけでは囮が原理的に効かない。**着手時の設計はそれだったが、実測で
 * 崩れた。ミサイルが機体を正確に追っている限り機体への視線角は 0.00 度で、
 * 軸から外れるフレアは決して選ばれない。4.8 秒のあいだ一度も掴まなかった。
 *
 * 熱の強さと距離の逆二乗を入れて成立させた。**確率は使っていないので
 * 決定論は保たれる。**
 *
 * このファイルの主題は「どの位置関係でどう効くか」を数字で固定すること。
 * 強度や角度分解を動かすと表が変わるので、変えたことに気づける。
 */

class Plane implements Combatant {
  readonly position = new Vec3()
  readonly velocity = new Vec3()
  readonly orientation = new Quat()
  readonly intensity = AIRCRAFT_INTENSITY
  integrity = 60

  constructor(position: Vec3, velocity: Vec3) {
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

type Outcome = '命中' | '囮' | '外れ'

/**
 * ミサイルを angle 度の方向から撃って、結果を返す。
 *
 * @param angleDeg 180 が真後ろ、0 が正面
 * @param deployAt フレアを出す秒。null なら出さない
 */
function engage(angleDeg: number, deployAt: number | null, range = 2500): Outcome {
  const plane = new Plane(new Vec3(0, 3000, 0), new Vec3(0, 0, -250))
  const cm = new Countermeasures()
  const missile = new Missile()

  const rad = (angleDeg * Math.PI) / 180
  // 機体の −Z が前方。真後ろは +Z
  const start = new Vec3(Math.sin(rad) * range, 3000, Math.cos(rad) * range)
  const dir = new Vec3().subVectors(plane.position, start)
  dir.multiplyScalar(1 / dir.length())
  missile.launch(start, dir.multiplyScalar(300), new Quat(), 0)

  // 寿命 60 秒ぶん回す。外れたミサイルが自滅するまで見る
  for (let i = 0; i < 70 * 120; i++) {
    const t = i * FIXED_DT
    // 1 フレームだけ押す。押しっぱなしで撒き続けない
    const deploy = deployAt !== null && t >= deployAt && t < deployAt + FIXED_DT * 2
    cm.step(FIXED_DT, deploy, plane.position, plane.velocity, plane.orientation)
    plane.step(FIXED_DT)
    missile.step(FIXED_DT, plane, cm.burning)
    if (missile.state !== 'flying') break
  }

  if (!missile.hitTarget) return '外れ'
  return missile.tracked === plane ? '命中' : '囮'
}

describe('フレアの物理', () => {
  it('自機の速度を引き継いで出る', () => {
    const flare = new Flare()
    flare.ignite(new Vec3(0, 3000, 0), new Vec3(0, 0, -250), new Vec3())
    expect(flare.velocity.z).toBeCloseTo(-250, 6)
    expect(flare.alive).toBe(true)
  })

  /**
   * **急に減速する。**これが囮として効く理由。機体は 250 m/s で飛び続けるので
   * 差が開く。実測で 1 秒後に 135 m/s、機体から 70 m 離れる。
   */
  it('抗力で減速する', () => {
    const flare = new Flare()
    flare.ignite(new Vec3(0, 3000, 0), new Vec3(0, 0, -250), new Vec3())
    for (let i = 0; i < 120; i++) flare.step(FIXED_DT)
    expect(flare.velocity.length()).toBeGreaterThan(120)
    expect(flare.velocity.length()).toBeLessThan(150)
  })

  it('落ちる。1 秒で 4 m 前後', () => {
    const flare = new Flare()
    flare.ignite(new Vec3(0, 3000, 0), new Vec3(0, 0, -250), new Vec3())
    for (let i = 0; i < 120; i++) flare.step(FIXED_DT)
    const drop = 3000 - flare.position.y
    expect(drop).toBeGreaterThan(3)
    expect(drop).toBeLessThan(6)
  })

  it('燃え尽きたら消える', () => {
    const flare = new Flare()
    flare.ignite(new Vec3(0, 3000, 0), new Vec3(0, 0, -250), new Vec3())
    for (let i = 0; i < Math.ceil(FLARE_BURN_SECONDS * 120) + 1; i++) flare.step(FIXED_DT)
    expect(flare.alive).toBe(false)
  })

  it('機体より熱い。この差が囮を成立させる', () => {
    expect(FLARE_INTENSITY).toBeGreaterThan(AIRCRAFT_INTENSITY)
  })
})

describe('投下', () => {
  function deploy(cm: Countermeasures, pressed: boolean, steps = 1): void {
    const position = new Vec3(0, 3000, 0)
    const velocity = new Vec3(0, 0, -250)
    const orientation = new Quat()
    for (let i = 0; i < steps; i++) {
      cm.step(FIXED_DT, pressed, position, velocity, orientation)
    }
  }

  it('1 回押すと決めた枚数だけ出る', () => {
    const cm = new Countermeasures()
    deploy(cm, true)
    expect(cm.aliveCount).toBe(FLARE_PER_DEPLOY)
    expect(cm.left).toBe(FLARE_CAPACITY - FLARE_PER_DEPLOY)
  })

  /** 押しっぱなしで撒き続けない。機銃とミサイルと同じ作法 */
  it('押しっぱなしでは 1 回しか出ない', () => {
    const cm = new Countermeasures()
    deploy(cm, true, 120)
    expect(cm.deployed).toBe(FLARE_PER_DEPLOY)
  })

  it('離して押し直せば出る。ただし間隔を空ける', () => {
    const cm = new Countermeasures()
    deploy(cm, true)
    deploy(cm, false, 10)
    deploy(cm, true)
    // 間隔が空いていないので出ない
    expect(cm.deployed).toBe(FLARE_PER_DEPLOY)

    deploy(cm, false, Math.ceil(FLARE_INTERVAL * 120))
    deploy(cm, true)
    expect(cm.deployed).toBe(FLARE_PER_DEPLOY * 2)
  })

  it('積んでいる数を撃ち切ったら出ない', () => {
    const cm = new Countermeasures()
    for (let i = 0; i < FLARE_CAPACITY; i++) {
      deploy(cm, true)
      deploy(cm, false, Math.ceil(FLARE_INTERVAL * 120))
    }
    expect(cm.left).toBe(0)
    const before = cm.deployed
    deploy(cm, true)
    expect(cm.deployed).toBe(before)
  })

  it('左右へ散らす。同じ場所に重ねても囮にならない', () => {
    const cm = new Countermeasures()
    deploy(cm, true)
    const alive = cm.flares.filter((f) => f.alive)
    expect(alive).toHaveLength(2)
    // 横方向の速度が逆向き
    expect(alive[0]!.velocity.x * alive[1]!.velocity.x).toBeLessThan(0)
  })

  it('リセットで元に戻る', () => {
    const cm = new Countermeasures()
    deploy(cm, true)
    cm.reset()
    expect(cm.left).toBe(FLARE_CAPACITY)
    expect(cm.aliveCount).toBe(0)
    expect(cm.deployed).toBe(0)
  })
})

/**
 * どの位置関係でどう効くか。
 *
 * **この表が強度 4 を選んだ根拠。**2, 4, 6, 8, 16, 32 を振って、6 以上は
 * 飽和してどの方向でも効くことを確かめた。4 なら真後ろだけが確実で、横からは
 * 効かない。**真後ろにつかれたらフレアで振り切れるが、横からは旋回で逃げる
 * しかない**という駆け引きになる。
 *
 * 「囮」はフレアを掴んで外れた状態、「外れ」は誘導を失って自滅した状態。
 * どちらも自機は無傷。
 */
describe('フレアが効く位置関係（強度 4 の実測）', () => {
  it('フレアを出さなければ、どの方向からでも当たる', () => {
    for (const deg of [180, 135, 90, 45, 0]) {
      expect(engage(deg, null), `${deg} 度`).toBe('命中')
    }
  })

  /** 真後ろは確実に効く。いつ出しても外れる */
  it.each([0.5, 1.0, 1.5, 2.0, 2.5, 3.0])('真後ろ・%s 秒で外せる', (t) => {
    expect(engage(180, t)).toBe('囮')
  })

  /**
   * **横からは 2 秒までは効かない。**フレアが機体の後方へ流れるので、横から
   * 来るミサイルの軸からは大きく外れる。角度で割り引かれて強度差 4 倍を
   * 超えられない。
   *
   * 2.5 秒以降は外れる。ただし「囮」ではなく「外れ」で、フレアを掴んだ
   * わけではない。終末の誘導が崩れた結果。
   */
  it.each([0.5, 1.0, 1.5, 2.0])('横 90 度・%s 秒では効かない', (t) => {
    expect(engage(90, t)).toBe('命中')
  })

  it('横 90 度でも着弾間際なら外れる。ただし囮ではない', () => {
    expect(engage(90, 2.5)).toBe('外れ')
    expect(engage(90, 3.0)).toBe('外れ')
  })

  /** 斜め後方は遅らせれば効く。早いと間に合わない */
  it('斜め後方 135 度は 1.5 秒以降で効く', () => {
    expect(engage(135, 0.5)).toBe('命中')
    expect(engage(135, 1.0)).toBe('命中')
    expect(engage(135, 1.5)).not.toBe('命中')
    expect(engage(135, 2.0)).not.toBe('命中')
  })

  /**
   * **正面から早めに出しても効かない。**フレアが機体の向こう側へ落ちるので、
   * 距離の逆二乗で不利になる。着弾直前なら効く。
   */
  it('正面は早いと効かない。着弾直前なら効く', () => {
    expect(engage(0, 0.5)).toBe('命中')
    expect(engage(0, 1.0)).toBe('命中')
    expect(engage(0, 1.5)).toBe('命中')
    expect(engage(0, 2.0)).toBe('囮')
  })
})

describe('決定論', () => {
  it('同じ入力からは同じ結果', () => {
    const a = engage(180, 1.0)
    const b = engage(180, 1.0)
    expect(a).toBe(b)
  })

  it('フレアの軌跡が一致する', () => {
    const positions: Vec3[][] = []
    for (let run = 0; run < 2; run++) {
      const cm = new Countermeasures()
      const position = new Vec3(0, 3000, 0)
      const velocity = new Vec3(0, 0, -250)
      const orientation = new Quat()
      cm.step(FIXED_DT, true, position, velocity, orientation)
      for (let i = 0; i < 120; i++) {
        cm.step(FIXED_DT, false, position, velocity, orientation)
      }
      positions.push(cm.flares.filter((f) => f.alive).map((f) => new Vec3().copy(f.position)))
    }
    expect(positions[0]).toHaveLength(FLARE_PER_DEPLOY)
    for (let i = 0; i < positions[0]!.length; i++) {
      expect(positions[0]![i]!.x).toBe(positions[1]![i]!.x)
      expect(positions[0]![i]!.y).toBe(positions[1]![i]!.y)
      expect(positions[0]![i]!.z).toBe(positions[1]![i]!.z)
    }
  })
})

describe('閃光', () => {
  it('点火の瞬間が最大で、閃光の終わりに 0 になる', () => {
    expect(flashIntensity(0)).toBe(1)
    expect(flashIntensity(FLARE_FLASH_SECONDS)).toBe(0)
    expect(flashIntensity(FLARE_BURN_SECONDS)).toBe(0)
  })

  it('単調に減る', () => {
    let previous = flashIntensity(0)
    for (let i = 1; i <= 40; i++) {
      const value = flashIntensity((FLARE_FLASH_SECONDS * i) / 40)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }
  })

  it('二乗で落ちるので前半で大半が消える', () => {
    // 立ち上がりを鋭く見せるための形。半分の時点で 1/4 まで落ちる
    expect(flashIntensity(FLARE_FLASH_SECONDS / 2)).toBeCloseTo(0.25, 6)
  })

  it('負の経過でも 1 を超えない', () => {
    expect(flashIntensity(-1)).toBe(1)
  })

  it('**囮の効き方には関わらない。**強度は燃焼のあいだ一定', () => {
    // 閃光は見た目だけ。シーカーが使う値は別（`FLARE_INTENSITY`）
    const flare = new Flare()
    flare.burn = FLARE_BURN_SECONDS
    expect(flare.intensity).toBe(FLARE_INTENSITY)
    flare.burn = 0.01
    expect(flare.intensity).toBe(FLARE_INTENSITY)
  })
})
