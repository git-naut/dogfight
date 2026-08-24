import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { Enemy } from '@sim/enemy'
import { Target } from '@sim/target'
import { World } from '@sim/world'
import { neutralInput } from '@sim/input'
import { defaultTerrain } from '@sim/terrain'
import { Rng } from '@sim/rng'
import {
  HARD_FLOOR,
  PULLOUT_MARGIN,
  RECOVER_SPEED,
  RESUME_AGL,
  RESUME_SPEED,
  pursueCommand,
  recoverFloor,
} from '@sim/ai/fighter'
import { climbAngleOf, pitchCap, pulloutAltitude } from '@sim/ai/steering'

/**
 * 敵 AI。
 *
 * **主題は「自滅しないこと」。**運動学の標的なら失速も墜落もしないが、
 * `Aircraft` は引きすぎれば失速し、低空で引けば地面に当たる。追尾できることの
 * 確認より、こちらのほうが壊れやすい。
 *
 * 追尾の確認は「当たった」を根拠にしない。距離が詰まることと、機軸の誤差が
 * 収束することで見る。Phase 5 でミサイルの誘導を「当たった」で判定していたら
 * 「N < 2 では当たらない」に外れた。
 */

const ORIGIN = new Vec3(0, 3000, 0)
const terrain = defaultTerrain()
/** 散布と回避の向きに使う。決定論のため固定シード */
const rng = new Rng(20260823)

interface Sample {
  range: number
  /** 視線の回転率 rad/s */
  losRate: number
  /** 機軸から相手までの角度 rad */
  angleOff: number
  speed: number
  agl: number
  bank: number
  state: string
}

/**
 * 敵 1 機と標的 1 機を回して、毎ステップの記録を返す。
 *
 * 標的は運動学の `Target`。相手の動きが決まっているほうが、AI の挙動だけを
 * 見られる。
 */
function engage(options: {
  offset: Vec3
  speed?: number
  heading?: number
  targetSpeed?: number
  turnRate?: number
  seconds: number
  withTerrain?: boolean
}): { enemy: Enemy; target: Target; history: Sample[] } {
  const enemy = new Enemy(
    {
      offset: options.offset,
      speed: options.speed ?? 250,
      ...(options.heading !== undefined ? { heading: options.heading } : {}),
    },
    ORIGIN,
    options.withTerrain === false ? {} : { terrain },
  )
  const target = new Target(
    {
      offset: new Vec3(),
      speed: options.targetSpeed ?? 240,
      ...(options.turnRate !== undefined ? { turnRate: options.turnRate } : {}),
    },
    ORIGIN,
  )

  const history: Sample[] = []
  const los = new Vec3()
  const relative = new Vec3()
  const omega = new Vec3()
  const nose = new Vec3()
  const steps = Math.round(options.seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    target.step(FIXED_DT)
    enemy.step(FIXED_DT, target, rng)

    los.subVectors(target.position, enemy.position)
    const range = los.length()
    relative.subVectors(target.velocity, enemy.velocity)
    // 視線の回転率 |r × v| / r²
    omega.crossVectors(los, relative).multiplyScalar(1 / Math.max(range * range, 1e-9))
    enemy.orientation.forward(nose)
    const cos = range > 1e-9 ? los.dot(nose) / range : 1
    history.push({
      range,
      losRate: omega.length(),
      angleOff: Math.acos(Math.max(-1, Math.min(1, cos))),
      speed: enemy.speed,
      agl: enemy.aircraft.agl,
      bank: enemy.aircraft.bank,
      state: enemy.aiState,
    })
    if (enemy.aircraft.crashed) break
  }
  return { enemy, target, history }
}

describe('引き起こしに要る高度', () => {
  it('上昇中は 0', () => {
    expect(pulloutAltitude(250, 0)).toBe(0)
    expect(pulloutAltitude(250, 0.3)).toBe(0)
  })

  it('速度が上がるほど深くなる', () => {
    const slow = pulloutAltitude(200, -0.5)
    const fast = pulloutAltitude(400, -0.5)
    expect(fast).toBeGreaterThan(slow * 2)
  })

  it('降下が急なほど深くなる', () => {
    expect(pulloutAltitude(300, -0.8)).toBeGreaterThan(pulloutAltitude(300, -0.2))
  })

  it('円弧とロール中の沈みの和になる', () => {
    const speed = 400
    const gamma = -0.84
    // 内訳。旋回半径 2,194.99 m、48.1 度の円弧で 729.92 m
    const radius = speed / pitchCap(speed)
    expect(radius).toBeCloseTo(2194.99, 1)
    const arc = radius * (1 - Math.cos(gamma))
    expect(arc).toBeCloseTo(729.92, 1)
    // バンク 0 でもロールの時定数 0.12 s ぶんは沈む
    const sink = speed * Math.sin(-gamma) * 0.12
    expect(sink).toBeCloseTo(35.74, 1)
    expect(pulloutAltitude(speed, gamma)).toBeCloseTo(arc + sink, 6)
    expect(pulloutAltitude(speed, gamma)).toBeCloseTo(765.66, 1)
  })

  it('バンクが残っていると深くなる', () => {
    const level = pulloutAltitude(300, -0.5, 0)
    const banked = pulloutAltitude(300, -0.5, 1.2)
    expect(banked).toBeGreaterThan(level)
    // 1.2 rad を 4 rad/s で戻すので 0.3 s ぶん余計に沈む
    expect(banked - level).toBeCloseTo(300 * Math.sin(0.5) * 0.3, 6)
  })

  it('水平飛行では下限そのもの', () => {
    expect(recoverFloor(250, 0)).toBe(HARD_FLOOR)
  })

  it('急降下では下限が 1,900 m 前後まで深くなる', () => {
    // 400 m/s で 48 度の降下
    const floor = recoverFloor(400, -0.84)
    expect(floor).toBeCloseTo(HARD_FLOOR + 765.66 * PULLOUT_MARGIN, 1)
    expect(floor).toBeGreaterThan(1900)
  })
})

describe('pursueCommand', () => {
  it('相手が前方なら視線の垂直成分へ向く', () => {
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    // 前方 2,000 m の右 500 m
    const target = new Target(
      { offset: new Vec3(500, 0, -2000), speed: 240 },
      ORIGIN,
    )
    const out = new Vec3()
    pursueCommand(enemy.aircraft, target, out)
    expect(out.x).toBeGreaterThan(0)
  })

  /**
   * 相手が 3/9 ラインの後ろなら水平の旋回。
   *
   * 視線の垂直成分をそのまま使うと垂直の反転になり、エネルギーを使い切る。
   * 実測で 250 m/s から 141 m/s まで落ち、相手を 6,000 m 先へ見失った。
   */
  it('相手が真後ろなら水平の指令を出す。垂直に引き起こさない', () => {
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    // 真後ろ 1,500 m
    const target = new Target({ offset: new Vec3(0, 0, 1500), speed: 240 }, ORIGIN)
    const out = new Vec3()
    pursueCommand(enemy.aircraft, target, out)
    // 縦成分が横成分よりずっと小さい
    expect(Math.abs(out.y)).toBeLessThan(Math.abs(out.x) * 0.1)
    // 誤差 180 度 / 0.7 s × 250 m/s = 1,122 m/s²。飽和する大きさ
    expect(Math.abs(out.x)).toBeGreaterThan(1000)
  })

  it('相手が後方の右にいれば右へ回る', () => {
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    const target = new Target({ offset: new Vec3(800, 0, 1500), speed: 240 }, ORIGIN)
    const out = new Vec3()
    pursueCommand(enemy.aircraft, target, out)
    expect(out.x).toBeGreaterThan(0)
  })

  it('相手が後方の左にいれば左へ回る', () => {
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    const target = new Target({ offset: new Vec3(-800, 0, 1500), speed: 240 }, ORIGIN)
    const out = new Vec3()
    pursueCommand(enemy.aircraft, target, out)
    expect(out.x).toBeLessThan(0)
  })
})

describe('追尾', () => {
  /**
   * 真後ろから直進する相手を追う。
   *
   * 実測で 3,000 m から 42.1 秒で 0 m まで詰まる。距離が単調に減ることを
   * 最接近の手前まで見る。
   */
  it('直進する相手との距離が最接近まで単調に減る', () => {
    const { history } = engage({ offset: new Vec3(0, 0, 3000), seconds: 41 })
    let worst = 0
    for (let i = 1; i < history.length; i++) {
      const rise = history[i]!.range - history[i - 1]!.range
      if (rise > worst) worst = rise
    }
    // 数値誤差ぶんだけ許す。1 ステップ 1/120 秒で 1 mm 以上は増えない
    expect(worst).toBeLessThan(0.001)
    expect(history[history.length - 1]!.range).toBeLessThan(200)
  })

  it('旋回する相手にも追随して詰める', () => {
    const { history } = engage({
      offset: new Vec3(0, 0, 3000),
      turnRate: 0.06,
      seconds: 36,
    })
    expect(history[0]!.range).toBeCloseTo(3000, 0)
    expect(history[history.length - 1]!.range).toBeLessThan(200)
    // 追随のあいだ 50 度以上バンクする。相手の旋回率 0.06 rad/s に付いていく
    // には自分も回らないといけない
    let peak = 0
    for (const row of history) peak = Math.max(peak, Math.abs(row.bank))
    expect(peak).toBeGreaterThan(0.8)
  })

  /**
   * 機軸の誤差が収束する。
   *
   * **視線の回転率では見ない。**計画では「視線回転率が終末で 0 へ収束する」
   * ことを追尾の指標にする予定だったが、実測で収束しない。旋回率 0.04 rad/s の
   * 相手を後方 3 km から追う構図で、視線の回転率は 0.0006 から 0.05 rad/s へ
   * 単調に増える。距離が詰まるほど同じ横方向の速度差が大きな角速度になるので、
   * 幾何としてそうなる。ミサイルは 30 G 出せるので押さえ込めるが、機体は
   * 7.5 G しかない。
   *
   * 機体で見るべきは機軸の誤差のほう。**機銃を撃つには機首が相手に乗って
   * いないといけない。**実測で 11.5 度から 6.5 度へ収束する。
   */
  it('機軸の誤差が収束する', () => {
    const { history } = engage({
      offset: new Vec3(600, 0, 3000),
      turnRate: 0.04,
      seconds: 30,
    })
    // 開始時は 11.5 度ずれている
    expect(history[0]!.angleOff).toBeGreaterThan(0.15)
    // 1 秒で機首に乗る
    expect(history[120]!.angleOff).toBeLessThan(0.06)
    // 距離が詰まるほど幾何が厳しくなるが、11 度以内に収まる（実測 10.2 度）
    let peak = 0
    for (const row of history.slice(120)) peak = Math.max(peak, row.angleOff)
    expect(peak).toBeLessThan((11 * Math.PI) / 180)
  })

  it('同速で真横にいる相手にも向き直る', () => {
    // 比例航法だけでは相対速度がほぼ 0 で指令が出ない構図
    const { history } = engage({ offset: new Vec3(2000, 0, 0), seconds: 30 })
    const near = history.find((r) => r.range < 500)
    expect(near, '500 m まで詰められていない').toBeDefined()
    expect(near!.angleOff).toBeLessThan((20 * Math.PI) / 180)
  })

  /**
   * 相手が正面にいるあいだバンクが振れない。
   *
   * **目標のバンク角を「指令の向きの角度」にすると振れる。**機体座標での
   * `atan2(b.x, b.y)` は指令が小さいと向きが定まらない。実測で、機軸の誤差が
   * 0.5〜0.9 度しかない状態のままバンクが ±47 度を 1 秒ごとに往復した。
   * 定常旋回のつり合い `atan2(a_h, g + a_v)` を参照にすると 0.0 度になる。
   */
  it('相手が正面にいるあいだバンクが振れない', () => {
    // 真後ろから直進する相手。横への要求はほとんど無い
    const { history } = engage({ offset: new Vec3(0, 0, 3000), seconds: 25 })
    let peak = 0
    for (const row of history) peak = Math.max(peak, Math.abs(row.bank))
    // 実測で 0.0 度。0.05 rad（2.9 度）を上限にしておく
    expect(peak).toBeLessThan(0.05)
  })

  /**
   * 真後ろの相手へ水平で向き直る。
   *
   * 実測で、水平の旋回に変える前は高度 3,000 m から 4,215 m へ昇って
   * 速度が 141 m/s まで落ちた。いまは 215 m/s までしか落ちない。
   */
  it('真後ろの相手へ向き直っても速度を失わない', () => {
    const { history } = engage({ offset: new Vec3(0, 0, -1500), seconds: 25 })
    let minSpeed = Infinity
    let maxAlt = -Infinity
    for (const row of history) {
      minSpeed = Math.min(minSpeed, row.speed)
      maxAlt = Math.max(maxAlt, row.agl)
    }
    expect(minSpeed).toBeGreaterThan(RECOVER_SPEED)
    // 高度を 800 m 以上積み上げない（垂直の反転をしていない証拠）
    expect(maxAlt - 3000).toBeLessThan(800)
  })
})

/**
 * 自滅しないこと。
 *
 * 開発中は高度 4 通り × 速度 3 通り × 相対方位 3 通りの 36 条件を 60 秒
 * 回して確かめた。3 段で直した。
 *
 * **固定の下限 800 m では 2 条件が地面に当たった。**高度 8,000 m から
 * 400 m/s で降りると、立て直しに入ってから衝突までが 2.6 秒しかない。
 * 引き起こしに要る高度を速度と降下角から出す形にして 0 になった。
 *
 * **円弧だけでは最低対地が 124 m まで落ちた。**旋回中に降下へ入ると、翼を
 * 水平に戻すあいだ引いても機首が上がらない。ロール時間ぶんの沈みを足した。
 *
 * **真下を見るだけでは斜面に当たる。**対地 927 m を 20 度で上昇していた敵機が
 * 3.5 秒後に地面へ当たった。そのあいだに地形が 28 m から 1,332 m へ立ち
 * 上がっていた。傾斜 44 度に対して上昇率 137 m/s では逃げられない。前方
 * 6 秒ぶんの余裕を見て、詰まっているほど上昇角を立てる形にした。**36 条件の
 * 最低対地高度が 600 m になった**（低空の条件の開始高度そのまま）。
 *
 * ここに残すのは代表の 8 条件。全条件は重いので走らせない。
 */
describe('自滅しない', () => {
  const cases = [
    { label: '低空 600 m / 250 m/s / 同方向', alt: 600, speed: 250, heading: 0 },
    { label: '低空 600 m / 400 m/s / 同方向', alt: 600, speed: 400, heading: 0 },
    { label: '3000 m / 120 m/s / 同方向', alt: 3000, speed: 120, heading: 0 },
    { label: '3000 m / 250 m/s / 正対', alt: 3000, speed: 250, heading: Math.PI },
    { label: '3000 m / 400 m/s / 直交', alt: 3000, speed: 400, heading: Math.PI / 2 },
    { label: '高空 8000 m / 400 m/s / 同方向', alt: 8000, speed: 400, heading: 0 },
    { label: '高空 8000 m / 400 m/s / 直交', alt: 8000, speed: 400, heading: Math.PI / 2 },
    { label: '高空 8000 m / 120 m/s / 直交', alt: 8000, speed: 120, heading: Math.PI / 2 },
  ] as const

  it.each(cases)('$label で 60 秒回しても墜落しない', (item) => {
    const { enemy, history } = engage({
      offset: new Vec3(500, item.alt - 3000, 1500),
      speed: item.speed,
      heading: item.heading,
      turnRate: 0.06,
      seconds: 60,
    })
    const minAgl = Math.min(...history.map((r) => r.agl))
    expect(enemy.aircraft.crashed, `最低対地 ${minAgl.toFixed(0)} m`).toBe(false)
    // 失速したまま落ちていない
    expect(enemy.speed).toBeGreaterThan(RECOVER_SPEED * 0.7)
    // 対地高度の下限をひどく割っていない
    expect(minAgl, `最低対地 ${minAgl.toFixed(0)} m`).toBeGreaterThan(300)
  })
})

describe('状態の遷移', () => {
  it('高度も速度も足りていれば追尾のまま', () => {
    const { enemy } = engage({ offset: new Vec3(0, 0, 3000), seconds: 5 })
    expect(enemy.aiState).toBe('pursue')
  })

  it('速度が足りなければ立て直しへ入る', () => {
    // 立て直しの下限を下回る速度で置く
    const enemy = new Enemy(
      { offset: new Vec3(0, 0, 2000), speed: RECOVER_SPEED - 20 },
      ORIGIN,
      { terrain },
    )
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    enemy.step(FIXED_DT, target, rng)
    expect(enemy.aiState).toBe('recover')
  })

  it('立て直しは高度と速度がそろうまで抜けない', () => {
    const enemy = new Enemy(
      { offset: new Vec3(0, 0, 2000), speed: RECOVER_SPEED - 20 },
      ORIGIN,
      { terrain },
    )
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    let left = -1
    for (let i = 0; i < 60 * 120; i++) {
      enemy.step(FIXED_DT, target, rng)
      if (enemy.aiState !== 'recover') {
        left = i
        break
      }
    }
    expect(left).toBeGreaterThan(0)
    expect(enemy.aircraft.agl).toBeGreaterThan(RESUME_AGL)
    expect(enemy.speed).toBeGreaterThan(RESUME_SPEED)
  })

  it('立て直しは低空なら機首を上げ、速度不足なら下げる', () => {
    // 低空・低速。高度が先
    const low = new Enemy(
      { offset: new Vec3(0, -2900, 2000), speed: RECOVER_SPEED - 20 },
      ORIGIN,
      { terrain },
    )
    const target = new Target({ offset: new Vec3(), speed: 240 }, ORIGIN)
    for (let i = 0; i < 3 * 120; i++) low.step(FIXED_DT, target, rng)
    expect(low.aiState).toBe('recover')
    expect(climbAngleOf(low.velocity)).toBeGreaterThan(0)

    // 高空・低速。速度が先なので機首を下げる
    const high = new Enemy(
      { offset: new Vec3(0, 3000, 2000), speed: RECOVER_SPEED - 20 },
      ORIGIN,
      { terrain },
    )
    for (let i = 0; i < 3 * 120; i++) high.step(FIXED_DT, target, rng)
    expect(high.aiState).toBe('recover')
    expect(climbAngleOf(high.velocity)).toBeLessThan(0)
  })

  it('遠ければ追尾、機銃の射程まで詰めたら射撃', () => {
    const { history } = engage({
      offset: new Vec3(0, 0, 3000),
      turnRate: 0.06,
      seconds: 36,
    })
    // 3,000 m では追尾
    expect(history[0]!.state).toBe('pursue')
    // 1,200 m を切ったところから射撃
    const entered = history.findIndex((r) => r.state === 'attack')
    expect(entered).toBeGreaterThan(0)
    expect(history[entered]!.range).toBeLessThan(1200)
    // この構図では回避も立て直しも出てこない
    const seen = new Set(history.map((r) => r.state))
    expect([...seen].sort()).toEqual(['attack', 'pursue'])
  })
})

describe('決定論', () => {
  it('同じシードと同じ台本から同じ判断列になる', () => {
    const build = (): World =>
      new World({
        seed: 20260823,
        enemies: [{ offset: new Vec3(400, 60, 2200), speed: 245, heading: 0.3 }],
      })
    const a = build()
    const b = build()
    const statesA: string[] = []
    const statesB: string[] = []
    for (let i = 0; i < 1800; i++) {
      a.step(neutralInput())
      b.step(neutralInput())
      statesA.push(a.enemies[0]!.aiState)
      statesB.push(b.enemies[0]!.aiState)
    }
    expect(statesA).toEqual(statesB)
    expect(a.enemies[0]!.position.x).toBe(b.enemies[0]!.position.x)
    expect(a.enemies[0]!.position.y).toBe(b.enemies[0]!.position.y)
    expect(a.enemies[0]!.position.z).toBe(b.enemies[0]!.position.z)
  })
})
