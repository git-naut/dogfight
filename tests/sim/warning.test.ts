import { describe, it, expect } from 'vitest'
import {
  WARNING_CLOSING_SPEED,
  WARNING_RANGE,
  createMissileThreat,
  measureThreat,
} from '@sim/weapons/warning'
import { Missile } from '@sim/weapons/missile'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { World } from '@sim/world'
import { makeInput } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'

/**
 * ミサイル警告。
 *
 * **どちらへ逃げるかの判断材料を出す。**有無だけでは回避が成立しない。
 * 方位を自機の座標系で出して、HUD が矢印か時計方位に写す。
 *
 * このファイルの主題は方位が正しいことと、**外れたら消えること。**鳴り
 * 続けると「振り切った」が伝わらない。
 */

const DEG = Math.PI / 180

/** 指定の位置から自機へ向かって飛ぶミサイルを作る */
function incoming(from: Vec3, toward: Vec3, speed = 400): Missile {
  const missile = new Missile()
  const dir = new Vec3().subVectors(toward, from)
  dir.multiplyScalar(1 / dir.length())
  missile.launch(from, dir.multiplyScalar(speed), new Quat(), 0)
  return missile
}

describe('方位', () => {
  const origin = new Vec3(0, 3000, 0)
  const velocity = new Vec3(0, 0, -250)
  const orientation = new Quat()
  const out = createMissileThreat()

  /**
   * 機首は −Z、右は +X。0 が正面、+π/2 が右、±π が真後ろ。
   */
  it.each([
    { label: '正面', at: new Vec3(0, 3000, -2000), deg: 0 },
    { label: '右', at: new Vec3(2000, 3000, 0), deg: 90 },
    { label: '左', at: new Vec3(-2000, 3000, 0), deg: -90 },
    { label: '右前方', at: new Vec3(1414, 3000, -1414), deg: 45 },
    { label: '左後方', at: new Vec3(-1414, 3000, 1414), deg: -135 },
  ])('$label のミサイルは $deg 度', ({ at, deg }) => {
    const missile = incoming(at, origin)
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.active).toBe(true)
    expect(out.bearing / DEG).toBeCloseTo(deg, 1)
  })

  it('真後ろは ±π', () => {
    const missile = incoming(new Vec3(0, 3000, 2000), origin)
    measureThreat([missile], origin, velocity, orientation, out)
    expect(Math.abs(out.bearing / DEG)).toBeCloseTo(180, 1)
  })

  /**
   * **自機の姿勢に追随する。**機体が右を向いていれば、同じ位置のミサイルは
   * 左に見える。方位は世界座標ではなく機体座標で出す。
   */
  it('自機が向きを変えると方位も回る', () => {
    const missile = incoming(new Vec3(2000, 3000, 0), origin)
    // 右へ 90 度向く。右ヨーは +Y まわりの負回転
    const turned = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), -90 * DEG)

    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.bearing / DEG).toBeCloseTo(90, 1)

    measureThreat([missile], origin, velocity, turned, out)
    expect(out.bearing / DEG).toBeCloseTo(0, 1)
  })
})

describe('接近しているものだけ', () => {
  const origin = new Vec3(0, 3000, 0)
  const velocity = new Vec3(0, 0, -250)
  const orientation = new Quat()
  const out = createMissileThreat()

  it('向かってくるミサイルで出る', () => {
    const missile = incoming(new Vec3(0, 3000, 2000), origin)
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.active).toBe(true)
    expect(out.count).toBe(1)
  })

  /**
   * **離れていくミサイルでは出ない。**外れたあとも鳴り続けると意味が薄れる。
   * フレアで逸らしたミサイルは離れていくので、そこで消える。
   */
  it('離れていくミサイルでは出ない', () => {
    // 自機の後方から、さらに後方へ飛んでいく
    const missile = incoming(new Vec3(0, 3000, 2000), new Vec3(0, 3000, 4000))
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.active).toBe(false)
  })

  it('飛んでいないミサイルは数えない', () => {
    const missile = new Missile()
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.active).toBe(false)
    expect(out.count).toBe(0)
  })

  it('遠すぎるミサイルは無視する', () => {
    const far = new Vec3(0, 3000, WARNING_RANGE + 1000)
    const missile = incoming(far, origin)
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.active).toBe(false)
  })

  /** 並走しているだけのミサイルでは出ない */
  it('接近速度が閾値以下では出ない', () => {
    const missile = new Missile()
    // 自機と同じ向き・同じ速さで、後方 2,000 m
    missile.launch(new Vec3(0, 3000, 2000), new Vec3(0, 0, -250), new Quat(), 0)
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.active).toBe(false)
    expect(WARNING_CLOSING_SPEED).toBeGreaterThan(0)
  })
})

describe('いちばん近いものを出す', () => {
  const origin = new Vec3(0, 3000, 0)
  const velocity = new Vec3(0, 0, -250)
  const orientation = new Quat()
  const out = createMissileThreat()

  /**
   * **複数を同時に出しても、どちらへ逃げるか決められない。**数だけ伝える。
   */
  it('近いほうの方位を出し、数は両方を数える', () => {
    const near = incoming(new Vec3(1000, 3000, 0), origin)
    const far = incoming(new Vec3(0, 3000, 3000), origin)
    measureThreat([far, near], origin, velocity, orientation, out)
    expect(out.count).toBe(2)
    expect(out.range).toBeCloseTo(1000, 0)
    expect(out.bearing / DEG).toBeCloseTo(90, 1)
  })

  it('着弾までの秒を出す', () => {
    // 後方 2,000 m から 400 m/s。自機は 250 m/s で逃げるので接近 150 m/s
    const missile = incoming(new Vec3(0, 3000, 2000), origin)
    measureThreat([missile], origin, velocity, orientation, out)
    expect(out.timeToImpact).toBeCloseTo(2000 / 150, 0)
  })
})

/**
 * 実際の交戦で出る。
 *
 * **`Combat` が毎ステップ測る。**ミサイルを進めたあとに測るので、逸れた
 * 瞬間に消える。
 */
describe('交戦のなかで', () => {
  const ALT = 3000
  const trim = trimCondition(250, airDensity(ALT))

  function engagement(): World {
    return new World({
      seed: 20260823,
      aircraft: {
        position: new Vec3(0, ALT, 0),
        velocity: new Vec3(0, 0, -250),
        throttle: trim.throttle,
      },
      enemies: [{ offset: new Vec3(0, 0, 2500), speed: 250 }],
    })
  }

  it('撃たれると警告が出る', () => {
    const w = engagement()
    let seen = false
    for (let i = 0; i < 5 * 120; i++) {
      w.step(makeInput({ throttle: trim.throttle }))
      if (w.combat.threat.active) {
        seen = true
        break
      }
    }
    expect(seen).toBe(true)
  })

  it('真後ろから来るので方位は ±π に近い', () => {
    const w = engagement()
    for (let i = 0; i < 3 * 120; i++) w.step(makeInput({ throttle: trim.throttle }))
    expect(w.combat.threat.active).toBe(true)
    expect(Math.abs(w.combat.threat.bearing / DEG)).toBeGreaterThan(150)
  })

  /**
   * **フレアで逸らすと消える。**これが「振り切った」の手応えになる。
   *
   * 実測で 1 発目の着弾は 7.1 秒。その 1 秒前に出す。
   *
   * **2 発目が来ることに注意。**敵は 2 発積んでいて、間隔 6 秒で撃つ。
   * 実測で 6 秒に 2 発目が出て 13 秒に命中する。だから 1 発目が逸れた
   * 直後だけを見る。フレアを 1 回しか出していないのだから当然で、
   * これを見落として「消えない」と読み違えた。
   */
  it('フレアで逸らすと 1 発目の警告が消える', () => {
    const w = engagement()
    // 1 発目が逸れる直前まで
    for (let i = 0; i < 7 * 120; i++) {
      const t = i / 120
      const deploy = t >= 6.1 && t < 6.1 + 2 / 120
      w.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
    }
    const before = w.combat.threat.count
    // 逸れたあと 1 秒
    for (let i = 0; i < 120; i++) w.step(makeInput({ throttle: trim.throttle }))
    // 数が減る。2 発目は飛び続けているので 0 にはならない
    expect(w.combat.threat.count).toBeLessThan(before)
    expect(w.player.integrity).toBeGreaterThan(0)
  })

  /**
   * 積んでいる 2 発を両方フレアで逸らせば生き残る。
   *
   * 実測で 1 発目は 7.1 秒、2 発目は 13 秒に着弾する。
   */
  it('2 発とも逸らせば生き残る', () => {
    const w = engagement()
    for (let i = 0; i < 20 * 120; i++) {
      const t = i / 120
      const deploy = (t >= 6.1 && t < 6.1 + 2 / 120) || (t >= 12.0 && t < 12.0 + 2 / 120)
      w.step(makeInput({ throttle: trim.throttle, deployFlare: deploy }))
    }
    expect(w.player.integrity).toBeGreaterThan(0)
    expect(w.combat.threat.active).toBe(false)
  })

  it('撃たれていなければ出ない', () => {
    const w = new World({
      seed: 20260823,
      aircraft: {
        position: new Vec3(0, ALT, 0),
        velocity: new Vec3(0, 0, -250),
        throttle: trim.throttle,
      },
      enemies: [{ offset: new Vec3(0, 0, 2500), speed: 250, missiles: 0 }],
    })
    for (let i = 0; i < 10 * 120; i++) w.step(makeInput({ throttle: trim.throttle }))
    expect(w.combat.threat.active).toBe(false)
  })
})
