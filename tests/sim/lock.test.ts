import { describe, it, expect } from 'vitest'
import {
  Lock,
  SEEKER_ACQUIRE_ANGLE,
  SEEKER_ACQUIRE_TIME,
  SEEKER_MAX_RANGE,
  SEEKER_TRACK_ANGLE,
} from '@sim/weapons/lock'
import { Target } from '@sim/target'
import { Quat } from '@sim/quat'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { runScript } from '@sim/world'
import { SCRIPTS } from '@sim/scripts'

/**
 * ロックオン。
 *
 * **交戦距離の相手は肉眼では見つけられない。**追従カメラの垂直画角は速度
 * 250 m/s で 66.4 度あり、190 m の機体でも実測 28 x 10 画素にしかならない。
 * この仕組みがないと、どこを狙っているのか分からない。
 */

const DEG = Math.PI / 180
const SEC = 120
const ORIGIN = new Vec3(0, 3000, 0)

/** 自機の位置から (右, 上, 前) の位置に標的を置く。前は正で -Z 方向 */
function targetAt(right: number, up: number, ahead: number, speed = 245): Target {
  return new Target({ offset: new Vec3(right, up, -ahead), speed }, ORIGIN)
}

/** 機首を -Z へ向けた姿勢 */
function level(): Quat {
  return new Quat()
}

/** ロックが立つまで進める。立たなければ null */
function hold(
  lock: Lock,
  targets: readonly Target[],
  seconds: number,
  velocity = new Vec3(0, 0, -250),
): void {
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    lock.step(ORIGIN, velocity, level(), targets, FIXED_DT)
  }
}

describe('捕捉の段階', () => {
  it('視野の外なら探索のまま', () => {
    const lock = new Lock()
    // 機軸から 45 度。捕捉の視野 20 度の外
    hold(lock, [targetAt(1000, 0, 1000)], 2)
    expect(lock.state).toBe('none')
    expect(lock.index).toBe(-1)
  })

  it('視野に入れて 0.7 秒で ロック まで上がる', () => {
    const lock = new Lock()
    const targets = [targetAt(0, 0, 3000)]

    hold(lock, targets, 0.3)
    expect(lock.state).toBe('acquiring')
    expect(lock.progress).toBeGreaterThan(0.3)
    expect(lock.progress).toBeLessThan(0.6)

    hold(lock, targets, 0.5)
    expect(lock.state).toBe('locked')
    expect(lock.progress).toBe(1)
  })

  it('捕捉にかかる時間が 0.7 秒。通り過ぎただけではロックしない', () => {
    expect(SEEKER_ACQUIRE_TIME).toBe(0.7)
    const lock = new Lock()
    hold(lock, [targetAt(0, 0, 3000)], SEEKER_ACQUIRE_TIME - 0.05)
    expect(lock.state).toBe('acquiring')
  })

  it('最大距離の外は捉えない', () => {
    const lock = new Lock()
    hold(lock, [targetAt(0, 0, SEEKER_MAX_RANGE + 1000)], 2)
    expect(lock.state).toBe('none')
  })

  it('落ちている標的は捉えない', () => {
    const lock = new Lock()
    const target = targetAt(0, 0, 3000)
    target.damage(999)
    expect(target.alive).toBe(false)
    hold(lock, [target], 2)
    expect(lock.state).toBe('none')
  })
})

describe('追従の視野は捕捉の視野より広い', () => {
  it('定数の関係', () => {
    expect(SEEKER_TRACK_ANGLE).toBeGreaterThan(SEEKER_ACQUIRE_ANGLE)
    expect((SEEKER_ACQUIRE_ANGLE / DEG)).toBeCloseTo(20, 6)
    expect((SEEKER_TRACK_ANGLE / DEG)).toBeCloseTo(40, 6)
  })

  it('捕捉の視野の外にいる相手は掴めないが、掴んだあとは追える', () => {
    const lock = new Lock()
    // 機軸から 30 度。捕捉の 20 度の外、追従の 40 度の内側
    const far = new Vec3(Math.tan(30 * DEG) * 3000, 0, -3000)
    const outside = new Target({ offset: far, speed: 245 }, ORIGIN)
    hold(lock, [outside], 2)
    expect(lock.state, '30 度からは捕捉できない').toBe('none')

    // 正面で掴んでから、同じ 30 度の位置にいる相手なら追えることを見る
    const lock2 = new Lock()
    const ahead = targetAt(0, 0, 3000)
    hold(lock2, [ahead], 1)
    expect(lock2.state).toBe('locked')
    // 掴んだままの相手を 30 度の位置へ置き換える（同じ添字）
    hold(lock2, [outside], 0.1)
    expect(lock2.state, '掴んだあとは 30 度でも追える').toBe('locked')
  })

  it('追従の視野を超えたら落ちる', () => {
    const lock = new Lock()
    const ahead = targetAt(0, 0, 3000)
    hold(lock, [ahead], 1)
    expect(lock.state).toBe('locked')

    // 機軸から 60 度。追従の 40 度の外
    const behind = new Target(
      { offset: new Vec3(Math.tan(60 * DEG) * 3000, 0, -3000), speed: 245 },
      ORIGIN,
    )
    hold(lock, [behind], 0.1)
    expect(lock.state).toBe('none')
  })
})

describe('測っている値', () => {
  it('距離が視線の長さ', () => {
    const lock = new Lock()
    hold(lock, [targetAt(0, 0, 4000)], 1)
    expect(lock.range).toBeCloseTo(4000, 6)
  })

  it('機軸からの角度', () => {
    const lock = new Lock()
    const ahead = 3000
    const right = Math.tan(15 * DEG) * ahead
    hold(lock, [targetAt(right, 0, ahead)], 1)
    expect(lock.angleOffBoresight / DEG).toBeCloseTo(15, 4)
  })

  it('接近速度は正が接近', () => {
    const lock = new Lock()
    // 自機 250 m/s、標的 200 m/s。同じ向きなので 50 m/s で詰まる
    hold(lock, [targetAt(0, 0, 3000, 200)], 1)
    expect(lock.closingSpeed).toBeCloseTo(50, 4)
  })

  it('離れていく相手は負', () => {
    const lock = new Lock()
    // 標的 320 m/s のほうが速い
    hold(lock, [targetAt(0, 0, 3000, 320)], 1)
    expect(lock.closingSpeed).toBeCloseTo(-70, 4)
  })
})

describe('乗り換えない', () => {
  it('機首の前を別の相手が横切っても掴んだままにする', () => {
    const lock = new Lock()
    // 少し外れた相手を掴む
    const held = targetAt(Math.tan(15 * DEG) * 3000, 0, 3000)
    hold(lock, [held], 1)
    expect(lock.state).toBe('locked')
    expect(lock.index).toBe(0)

    // 正面に別の相手が現れる
    const crossing = targetAt(0, 0, 2000)
    hold(lock, [held, crossing], 0.5)
    expect(lock.index, '乗り換えていない').toBe(0)
    expect(lock.state).toBe('locked')
  })

  it('機軸にいちばん近いものから捕捉する', () => {
    const lock = new Lock()
    const far = targetAt(Math.tan(18 * DEG) * 3000, 0, 3000)
    const near = targetAt(Math.tan(5 * DEG) * 3000, 0, 3000)
    hold(lock, [far, near], 1)
    expect(lock.index).toBe(1)
  })
})

describe('台本越し', () => {
  it('target-ahead はロックできる', () => {
    const w = runScript(SCRIPTS['target-ahead'], SEC * 2)
    expect(w.combat.lock.state).toBe('locked')
    expect(w.combat.lockedTarget).not.toBeNull()
    expect(w.combat.lock.range).toBeGreaterThan(100)
    expect(w.combat.lock.range).toBeLessThan(250)
  })

  it('gun-pass はロックが立ってから落ちる。耐久 60 で順序が入れ替わった', () => {
    // **耐久 20 のころは機銃のほうが速く、ロックが立つ前に落ちていた。**
    // 60 へ上げて撃墜が 0.50 → 0.95 秒になり、捕捉 0.70 秒を追い越した。
    // ロックボックスが出てから落ちるまでの間ができる
    const acquiring = runScript(SCRIPTS['gun-pass'], SEC * 0.5)
    expect(acquiring.combat.lock.state).toBe('acquiring')
    expect(acquiring.combat.lock.progress).toBeCloseTo(0.71, 2)
    expect(acquiring.targets[0]!.integrity).toBe(41)

    const locked = runScript(SCRIPTS['gun-pass'], SEC * 0.7)
    expect(locked.combat.lock.state).toBe('locked')
    expect(locked.combat.kills).toBe(0)

    const killed = runScript(SCRIPTS['gun-pass'], SEC * 1)
    expect(killed.combat.kills).toBe(1)
    // 落ちた相手は掴めないので解除される
    expect(killed.combat.lock.state).toBe('none')
    expect(killed.combat.lock.progress).toBe(0)
  })

  it('target-turn は標的が抜けていくとロックが落ちる', () => {
    const held = runScript(SCRIPTS['target-turn'], SEC * 2)
    expect(held.combat.lock.state).toBe('locked')
    // 右へ抜けていくと追従の視野を超える
    const lost = runScript(SCRIPTS['target-turn'], SEC * 12)
    expect(lost.combat.lock.state).toBe('none')
  })

  it('標的のいない台本ではロックが立たない', () => {
    const w = runScript(SCRIPTS.level, SEC * 3)
    expect(w.combat.lock.state).toBe('none')
    expect(w.combat.lockedTarget).toBeNull()
  })

  it('2 回再生してもロックの段階が一致する', () => {
    const a = runScript(SCRIPTS['target-turn'], SEC * 5)
    const b = runScript(SCRIPTS['target-turn'], SEC * 5)
    expect(a.combat.lock.state).toBe(b.combat.lock.state)
    expect(a.combat.lock.range).toBe(b.combat.lock.range)
    expect(a.combat.lock.closingSpeed).toBe(b.combat.lock.closingSpeed)
  })
})

describe('解除', () => {
  it('release で全部戻る', () => {
    const lock = new Lock()
    hold(lock, [targetAt(0, 0, 3000)], 1)
    expect(lock.state).toBe('locked')
    lock.release()
    expect(lock.state).toBe('none')
    expect(lock.index).toBe(-1)
    expect(lock.range).toBe(0)
    expect(lock.progress).toBe(0)
  })
})
