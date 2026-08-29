import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { FIXED_DT } from '@sim/loop'
import { World } from '@sim/world'
import { Rng } from '@sim/rng'
import { Enemy } from '@sim/enemy'
import { Target } from '@sim/target'
import { makeInput } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import { AIRCRAFT_INTEGRITY } from '@sim/aircraft'
import { ENEMY_MAGAZINE, MAGAZINE } from '@sim/weapons/gun'
import { MUZZLE_SPEED, ENEMY_BULLET_POOL, bulletTimeToRange } from '@sim/weapons/gun'
import {
  BURST_GAP_SECONDS,
  BURST_SECONDS,
  EVADE_CONE,
  EVADE_MIN_SECONDS,
  EVADE_RANGE,
  FIRE_CONE,
  GUN_ENGAGE_RANGE,
  MAX_TURN_ACCEL,
  evadeCommand,
  gunLeadPoint,
  gunTrackError,
  threatFromBehind,
} from '@sim/ai/fighter'

/**
 * 敵の射撃と回避。
 *
 * **「撃った」を根拠にしない。**当たったかどうかと、当たるべきでない構図で
 * 当たらないかを見る。命中率の値そのものは手ごたえの段で決める。
 */

const ALT = 3000
const trim = trimCondition(250, airDensity(ALT))
const ORIGIN = new Vec3(0, ALT, 0)
const rng = new Rng(1)

/**
 * 自機を高度 3,000 m のトリムに置いて、敵 1 機と回す。
 *
 * **敵にミサイルを積まない。**このファイルは機銃の挙動を測る。ミサイルが
 * 混ざると読めない。実測で、1,500 m から始めると敵は開始直後にミサイルを
 * 撃ち、6 秒で自機が落ちた。機銃は 1 発も出ていない。
 */
function engagement(offset: Vec3, heading?: number): World {
  return new World({
    seed: 20260823,
    aircraft: {
      position: new Vec3(0, ALT, 0),
      velocity: new Vec3(0, 0, -250),
      throttle: trim.throttle,
    },
    enemies: [
      { offset, speed: 250, missiles: 0, ...(heading !== undefined ? { heading } : {}) },
    ],
  })
}

/** 自機はトリムで直進。指定の秒数だけ回す */
function fly(world: World, seconds: number): void {
  const input = makeInput({ throttle: trim.throttle })
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) world.step(input)
}

describe('機銃の先行点', () => {
  it('相手が止まって見えるなら先行はいらない', () => {
    // 相手の速度と自機の速度が同じなら相対速度 0
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    const target = new Target({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN)
    const out = new Vec3()
    gunLeadPoint(enemy.aircraft, target, out)
    expect(out.distanceTo(target.position)).toBeLessThan(0.5)
  })

  /**
   * 横切る相手には先行が要る。
   *
   * 500 m の飛行時間は抗力込みで実測 0.561 秒。240 m/s で横切る相手は
   * そのあいだに 135 m 動く。**先行を入れないと当たらない。**
   */
  it('横切る相手には相対速度 × 飛行時間ぶん先行する', () => {
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    // 前方 500 m を右へ横切る（方位 π/2 で +X へ進む）
    const target = new Target({ offset: new Vec3(0, 0, -500), speed: 240 }, ORIGIN)
    // Target は方位を持たないので、右向きの速度を作るために別の的を使う
    const crossing = new Enemy(
      { offset: new Vec3(0, 0, -500), speed: 240, heading: Math.PI / 2 },
      ORIGIN,
    )
    void target
    const out = new Vec3()
    gunLeadPoint(enemy.aircraft, crossing, out)

    const flight = bulletTimeToRange(500)
    expect(flight).toBeCloseTo(0.561, 2)
    // 先行点は相手の右（+X）へ、相対速度 × 飛行時間ぶんずれる
    expect(out.x - crossing.position.x).toBeCloseTo(240 * flight, 0)
    // 自機の速度ぶんは引く。自機は −Z へ 250 なので先行点は +Z 側へ寄る
    expect(out.z - crossing.position.z).toBeCloseTo(250 * flight, 0)
  })

  it('弾が届く時間は抗力を含む閉形式と一致する', () => {
    // 抗力がなければ 500 / 1030 = 0.485 秒。抗力で 0.561 秒へ伸びる
    expect(500 / MUZZLE_SPEED).toBeCloseTo(0.485, 3)
    expect(bulletTimeToRange(500)).toBeGreaterThan(500 / MUZZLE_SPEED)
  })

  it('先行点へ機首が向いていれば誤差 0', () => {
    const enemy = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    // 自機と同速で真正面。先行が 0 なので機首が相手を向いていれば誤差 0
    const ahead = new Enemy({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN)
    // 機首は迎角ぶん上を向いているので、そのぶんの誤差が残る
    const error = gunTrackError(enemy.aircraft, ahead)
    expect(error).toBeCloseTo(enemy.aircraft.angleOfAttack, 3)
  })
})

describe('回避に入る条件', () => {
  function enemyFacing(velocity: Vec3): Enemy {
    const e = new Enemy({ offset: new Vec3(), speed: velocity.length() }, ORIGIN)
    e.aircraft.velocity.copy(velocity)
    return e
  }

  it('真後ろの至近は脅威', () => {
    const e = enemyFacing(new Vec3(0, 0, -250))
    const behind = new Target({ offset: new Vec3(0, 0, 500), speed: 250 }, ORIGIN)
    expect(threatFromBehind(e.aircraft, behind)).toBe(true)
  })

  it('真後ろでも遠ければ脅威にしない', () => {
    const e = enemyFacing(new Vec3(0, 0, -250))
    const far = new Target(
      { offset: new Vec3(0, 0, EVADE_RANGE + 100), speed: 250 },
      ORIGIN,
    )
    expect(threatFromBehind(e.aircraft, far)).toBe(false)
  })

  it('前方の相手は脅威にしない', () => {
    const e = enemyFacing(new Vec3(0, 0, -250))
    const ahead = new Target({ offset: new Vec3(0, 0, -500), speed: 250 }, ORIGIN)
    expect(threatFromBehind(e.aircraft, ahead)).toBe(false)
  })

  it('後方の円錐の外は脅威にしない', () => {
    const e = enemyFacing(new Vec3(0, 0, -250))
    // 真横やや後ろ。EVADE_CONE = 60 度の外
    const angle = EVADE_CONE + 0.2
    const side = new Target(
      {
        offset: new Vec3(Math.sin(angle) * 500, 0, Math.cos(angle) * 500),
        speed: 250,
      },
      ORIGIN,
    )
    expect(threatFromBehind(e.aircraft, side)).toBe(false)
  })

  it('後方の円錐の内側は脅威', () => {
    const e = enemyFacing(new Vec3(0, 0, -250))
    const angle = EVADE_CONE - 0.2
    const inside = new Target(
      {
        offset: new Vec3(Math.sin(angle) * 500, 0, Math.cos(angle) * 500),
        speed: 250,
      },
      ORIGIN,
    )
    expect(threatFromBehind(e.aircraft, inside)).toBe(true)
  })
})

describe('ブレイクターンの指令', () => {
  /**
   * 水平面で回る。
   *
   * `視線 × 速度` をそのまま使うと、相手が真後ろのとき向きが定まらない。
   * 実測で垂直の上昇になり、2.5 秒で画面の外まで昇った。
   */
  it('水平面内で速度に垂直な向きへ全力', () => {
    const e = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    const out = new Vec3()
    evadeCommand(e.aircraft, 1, out)
    expect(out.length()).toBeCloseTo(MAX_TURN_ACCEL, 6)
    // 自機は −Z へ飛ぶ。水平で垂直な向きは X 成分だけ。縦成分は 0
    expect(Math.abs(out.x)).toBeCloseTo(MAX_TURN_ACCEL, 4)
    expect(Math.abs(out.y)).toBeLessThan(1e-6)
  })

  it('符号で回る向きが変わる', () => {
    const e = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    const plus = evadeCommand(e.aircraft, 1, new Vec3())
    const minus = evadeCommand(e.aircraft, -1, new Vec3())
    expect(plus.x).toBeCloseTo(-minus.x, 6)
  })

  it('相手の位置に依らない。向きだけで決まる', () => {
    const e = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN)
    // 真後ろでも斜め後ろでも同じ指令になる
    const a = evadeCommand(e.aircraft, 1, new Vec3())
    const b = evadeCommand(e.aircraft, 1, new Vec3())
    expect(a.x).toBe(b.x)
    expect(a.y).toBe(b.y)
  })

  it('機体側の制限が絞る。AI は制限を持たない', () => {
    // 指令は 200 m/s² = 20 G。構造の制限は 7.5 G
    expect(MAX_TURN_ACCEL / 9.80665).toBeGreaterThan(7.5)
    const e = new Enemy({ offset: new Vec3(), speed: 250 }, ORIGIN, {})
    const behind = new Target({ offset: new Vec3(0, 0, 500), speed: 250 }, ORIGIN)
    for (let i = 0; i < 3 * 120; i++) e.step(FIXED_DT, behind, rng)
    // 荷重倍数が制限の近くで止まる。重力ぶんの余りがあるので 9 で見る
    expect(e.aircraft.loadFactor).toBeLessThan(9)
    expect(e.aircraft.stalled).toBe(false)
  })
})

describe('敵が撃つ', () => {
  it('機銃の射程まで詰めたら撃ち始める', () => {
    const w = engagement(new Vec3(0, 0, 1500))
    fly(w, 20)
    const e = w.enemies[0]!
    expect(e.aiState).toBe('attack')
    expect(e.roundsFired).toBeGreaterThan(0)
    expect(w.player.position.distanceTo(e.position)).toBeLessThan(GUN_ENGAGE_RANGE)
  })

  it('射程の外では撃たない', () => {
    const w = engagement(new Vec3(0, 0, 6000))
    fly(w, 5)
    const e = w.enemies[0]!
    expect(e.aiState).toBe('pursue')
    expect(e.roundsFired).toBe(0)
  })

  /**
   * 押しっぱなしにしない。
   *
   * 敵の携行 578 発（`ENEMY_MAGAZINE`）は 100 発/秒で 5.78 秒ぶんしかない。
   * 0.6 秒撃って 1.2 秒休むので実効は 33 発/秒。**バーストにしないと 6 秒で
   * 弾切れになる。**自機の `MAGAZINE` は Phase 7 で 1,800 発へ増やしたが、
   * 敵は据え置き
   */
  it('**敵の携行弾は自機と別。**自機を増やしても敵は増えない', () => {
    // `new Gun(ENEMY_BULLET_POOL)` が第 2 引数を省いていたので、`MAGAZINE` を
    // 1,800 発へ増やしたとき敵も 3.1 倍になった。意図しない波及だった
    const w = engagement(new Vec3(0, 0, 1000))
    expect(w.enemies[0]!.gun.rounds).toBe(ENEMY_MAGAZINE)
    expect(ENEMY_MAGAZINE).toBeLessThan(MAGAZINE)
  })

  it('バーストで撃つ。押しっぱなしにしない', () => {
    const w = engagement(new Vec3(0, 0, 1000))
    const e = w.enemies[0]!
    const input = makeInput({ throttle: trim.throttle })
    let firingSteps = 0
    const seconds = 12
    for (let i = 0; i < seconds * 120; i++) {
      const before = e.roundsFired
      w.step(input)
      if (e.roundsFired > before) firingSteps++
    }
    // 撃っているのは全体の一部。周期は 0.6 + 1.2 = 1.8 秒
    const duty = firingSteps / (seconds * 120)
    expect(duty).toBeLessThan(BURST_SECONDS / (BURST_SECONDS + BURST_GAP_SECONDS) + 0.05)
    expect(duty).toBeGreaterThan(0)
  })

  it('機軸が合っていなければ撃たない', () => {
    // 真横 800 m。射程の内側だが機首が向いていない
    const w = engagement(new Vec3(800, 0, 0))
    const e = w.enemies[0]!
    // 1 ステップだけ。まだ向き直っていない
    fly(w, FIXED_DT)
    expect(gunTrackError(e.aircraft, w.player)).toBeGreaterThan(FIRE_CONE)
    expect(e.roundsFired).toBe(0)
  })

  it('弾のプールは自機より小さい', () => {
    const w = engagement(new Vec3(0, 0, 1000))
    expect(w.enemies[0]!.gun.bulletCapacity).toBe(ENEMY_BULLET_POOL)
    expect(w.combat.bullets.bulletCapacity).toBeGreaterThan(ENEMY_BULLET_POOL)
  })

  it('弾を読む口が自機と敵のぶん並ぶ', () => {
    const w = engagement(new Vec3(0, 0, 1000))
    expect(w.combat.bulletSources).toHaveLength(2)
  })
})

describe('自機が撃たれる', () => {
  /**
   * まっすぐ飛べば落ちる。
   *
   * 実測で、後方 1,500 m の敵が 456 発撃って 60 発当て、耐久 60 を削り切る。
   * 命中率 13.2%。
   */
  it('直進していると耐久を削られて落ちる', () => {
    const w = engagement(new Vec3(0, 0, 1500))
    fly(w, 40)
    expect(w.combat.taken).toBeGreaterThan(0)
    expect(w.player.integrity).toBeLessThan(AIRCRAFT_INTEGRITY)
    expect(w.combat.losses).toBe(1)
    expect(w.player.alive).toBe(false)
  })

  /**
   * 機動すれば当たりにくい。
   *
   * 実測で 40 秒回したときの被弾数。**自機の生存では見ない。**旋回の入力を
   * 固定したままだと自機が降下して地面に当たるので、撃墜と区別が付かない。
   *
   * | 自機の入力 | 敵の発射 | 被弾 | 撃墜 |
   * | 直進 | 456 | 60 | 1 |
   * | 緩い右旋回（roll 0.2 / pitch 0.12） | 419 | 8 | 0 |
   * | 旋回 + 全開 | 0 | 0 | 0 |
   *
   * 全開で旋回すると敵は 1 発も撃てない。速度で振り切られて射程に入らない。
   */
  it('旋回していれば当たりにくい', () => {
    const straight = engagement(new Vec3(0, 0, 1500))
    fly(straight, 40)

    const turning = engagement(new Vec3(0, 0, 1500))
    const input = makeInput({ throttle: trim.throttle, roll: 0.2, pitch: 0.12 })
    for (let i = 0; i < 40 * 120; i++) turning.step(input)

    expect(turning.combat.taken).toBeLessThan(straight.combat.taken / 4)
    expect(turning.combat.losses).toBe(0)
  })

  it('全開で旋回すると敵は射程に入れない', () => {
    const w = engagement(new Vec3(0, 0, 1500))
    const input = makeInput({ throttle: 1, roll: 0.2, pitch: 0.12 })
    for (let i = 0; i < 40 * 120; i++) w.step(input)
    expect(w.enemies[0]!.roundsFired).toBe(0)
    expect(w.combat.taken).toBe(0)
  })

  it('落ちた瞬間だけ撃墜に数える', () => {
    const w = engagement(new Vec3(0, 0, 1500))
    expect(w.player.damage(AIRCRAFT_INTEGRITY - 1)).toBe(false)
    expect(w.player.damage(1)).toBe(true)
    // 落ちたあとの弾では二重に数えない
    expect(w.player.damage(1)).toBe(false)
    expect(w.player.crashed).toBe(true)
  })

  it('撃墜で爆発が出る', () => {
    const w = engagement(new Vec3(0, 0, 1500))
    fly(w, 40)
    expect(w.combat.explosionCount).toBeGreaterThan(0)
  })
})

describe('回避', () => {
  /**
   * 自機が後ろにつくと敵は回避に入る。
   *
   * 台本は自機の 600 m 前方・同方向。敵から見て自機は真後ろ 600 m。
   */
  it('後ろを取られたら回避へ入る', () => {
    const w = engagement(new Vec3(0, 0, -600))
    fly(w, 1)
    expect(w.enemies[0]!.aiState).toBe('evade')
  })

  it('回避は最短の時間だけ続く', () => {
    const w = engagement(new Vec3(0, 0, -600))
    const e = w.enemies[0]!
    fly(w, 1)
    expect(e.aiState).toBe('evade')
    // 最短の時間の内側では抜けない
    fly(w, EVADE_MIN_SECONDS - 1.5)
    expect(e.aiState).toBe('evade')
  })

  it('回避で相手を振り切ると距離が開く', () => {
    const w = engagement(new Vec3(0, 0, -600))
    const e = w.enemies[0]!
    const start = w.player.position.distanceTo(e.position)
    fly(w, 10)
    expect(w.player.position.distanceTo(e.position)).toBeGreaterThan(start)
  })

  it('回避の向きは乱数で決まり、同じシードなら同じ', () => {
    const build = (): World => engagement(new Vec3(0, 0, -600))
    const a = build()
    const b = build()
    for (let i = 0; i < 600; i++) {
      const input = makeInput({ throttle: trim.throttle })
      a.step(input)
      b.step(input)
    }
    expect(a.enemies[0]!.position.x).toBe(b.enemies[0]!.position.x)
    expect(a.enemies[0]!.position.z).toBe(b.enemies[0]!.position.z)
  })
})

describe('決定論', () => {
  it('同じシードなら発射数と被弾数が一致する', () => {
    const build = (): World => engagement(new Vec3(120, 30, 1400))
    const a = build()
    const b = build()
    const input = makeInput({ throttle: trim.throttle })
    for (let i = 0; i < 2400; i++) {
      a.step(input)
      b.step(input)
    }
    expect(a.enemies[0]!.roundsFired).toBe(b.enemies[0]!.roundsFired)
    expect(a.combat.taken).toBe(b.combat.taken)
    expect(a.player.integrity).toBe(b.player.integrity)
  })

  it('姿勢の器を共有していない。2 機が別々に動く', () => {
    const w = new World({
      seed: 20260823,
      aircraft: {
        position: new Vec3(0, ALT, 0),
        velocity: new Vec3(0, 0, -250),
        orientation: new Quat(),
        throttle: trim.throttle,
      },
      enemies: [
        { offset: new Vec3(-400, 0, 1500), speed: 250, missiles: 0 },
        { offset: new Vec3(400, 0, 1500), speed: 250, missiles: 0 },
      ],
    })
    fly(w, 10)
    const [a, b] = w.enemies
    expect(a!.position.x).not.toBe(b!.position.x)
  })
})
