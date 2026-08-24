import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { World } from '@sim/world'
import { makeInput, type InputState } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'

/**
 * 1 対 1 を長く回す。
 *
 * **主題は「敵が自滅しないこと」。**単体の追尾や射撃が成立していても、
 * 撃ち合いを長く続けると状態の行き来で予期しないところへ落ちる。
 *
 * 自機は素朴な自動操縦で回す。相手を機首に乗せようとするだけで、地形も
 * エネルギーも見ない。**AI とは別物にしてある。**同じ実装を両側に使うと、
 * その実装の癖が打ち消し合って検証にならない。
 */

/** 相手を機首へ乗せようとするだけの自動操縦 */
function autoPilot(world: World): InputState {
  const player = world.player
  const enemy = world.enemies[0]!
  const los = new Vec3().subVectors(enemy.position, player.position)
  const range = los.length()
  los.multiplyScalar(1 / Math.max(range, 1e-9))
  const body = new Vec3()
  player.orientation.rotateInverse(los, body)
  return makeInput({
    roll: Math.max(-1, Math.min(1, Math.atan2(body.x, body.y) * 0.8)),
    pitch: Math.max(-0.3, Math.min(1, body.y * 2)),
    throttle: 1,
    fireGun: range < 800 && body.z < -0.99,
  })
}

interface Outcome {
  enemyAlive: boolean
  enemyCrashed: boolean
  minEnemyAgl: number
  states: Set<string>
  taken: number
  hits: number
}

function dogfight(
  altitude: number,
  offset: Vec3,
  heading: number,
  seconds: number,
): Outcome {
  const trim = trimCondition(250, airDensity(altitude))
  const world = new World({
    seed: 20260823,
    aircraft: {
      position: new Vec3(0, altitude, 0),
      velocity: new Vec3(0, 0, -250),
      throttle: trim.throttle,
    },
    enemies: [{ offset, speed: 250, ...(heading !== 0 ? { heading } : {}) }],
  })
  const enemy = world.enemies[0]!
  const states = new Set<string>()
  let minEnemyAgl = Infinity

  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    world.step(autoPilot(world))
    states.add(enemy.aiState)
    if (enemy.alive) minEnemyAgl = Math.min(minEnemyAgl, enemy.aircraft.agl)
  }

  return {
    enemyAlive: enemy.alive,
    enemyCrashed: enemy.aircraft.crashed,
    minEnemyAgl,
    states,
    taken: world.combat.taken,
    hits: world.combat.hits,
  }
}

/**
 * 実測。12 条件（高度 3 通り × 初期配置 4 通り）を 90 秒回した結果。
 *
 * **敵は 12 条件すべてで生存。**最低対地高度は 794 m。全条件で 4 つの状態
 * （pursue / attack / evade / recover）が出た。
 *
 * 自機は 2 条件で墜落した。**自動操縦が地形を見ていないため。**AI 側の
 * 欠陥ではない。自機の最低対地高度は 1 m まで落ちた。
 *
 * ここに残すのは代表の 6 条件を 60 秒。全条件は重いので走らせない。
 */
describe('1 対 1', () => {
  const cases = [
    { label: '1500 m / 正対 2500 m', alt: 1500, offset: new Vec3(0, 0, -2500), heading: Math.PI },
    { label: '1500 m / 真横 2000 m', alt: 1500, offset: new Vec3(2000, 0, 0), heading: 0 },
    { label: '3000 m / 正対 2500 m', alt: 3000, offset: new Vec3(0, 0, -2500), heading: Math.PI },
    { label: '3000 m / 後方 1500 m', alt: 3000, offset: new Vec3(0, 0, 1500), heading: 0 },
    { label: '3000 m / 正対 上方 1200 m', alt: 3000, offset: new Vec3(0, 400, -1200), heading: Math.PI },
    { label: '6000 m / 真横 2000 m', alt: 6000, offset: new Vec3(2000, 0, 0), heading: 0 },
  ] as const

  it.each(cases)('$label で 60 秒回しても敵が自滅しない', (item) => {
    const out = dogfight(item.alt, item.offset, item.heading, 60)
    expect(
      out.enemyCrashed,
      `最低対地 ${out.minEnemyAgl.toFixed(0)} m`,
    ).toBe(false)
    expect(out.enemyAlive).toBe(true)
    expect(out.minEnemyAgl, `最低対地 ${out.minEnemyAgl.toFixed(0)} m`).toBeGreaterThan(
      300,
    )
  })

  it('撃ち合いのあいだに 4 つの状態が全部出る', () => {
    const out = dogfight(3000, new Vec3(0, 0, -2500), Math.PI, 60)
    expect([...out.states].sort()).toEqual(['attack', 'evade', 'pursue', 'recover'])
  })

  /**
   * どちらかが当てる。
   *
   * **60 秒では当たらない構図がある。**自動操縦も AI もよく機動するので、
   * 機首が乗る瞬間が来るまでに時間がかかる。90 秒の実測では正対 2,500 m で
   * 自機が 12 発当てた。
   */
  it('90 秒回せばどちらかが当てる', () => {
    const out = dogfight(3000, new Vec3(0, 0, -2500), Math.PI, 90)
    expect(out.taken + out.hits).toBeGreaterThan(0)
  })
})
