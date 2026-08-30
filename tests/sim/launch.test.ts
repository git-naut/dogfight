import { describe, it, expect } from 'vitest'
import {
  Catapult,
  LAUNCH_ACCEL,
  LAUNCH_DISTANCE,
  LAUNCH_END_SPEED,
  LAUNCH_SECONDS,
  GEAR_HEIGHT,
} from '@sim/launch'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { LAUNCH_THROTTLE } from '@sim/launch'
import { World, createWorldFromScript } from '@sim/world'
import { neutralInput } from '@sim/input'
import { getScript } from '@sim/scripts'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { parseAc3d, flatten, toWorld } from '../../tools/ac3d.mjs'
import { DEFAULT_GEAR_PATTERN } from '../../tools/aircraft-assets.mjs'

/**
 * カタパルト射出。
 *
 * **公表値から導いた定数が実際にその値を出すことを固定する。**式を書き
 * 換えたときに、終端速度や所要時間が静かにずれるのを防ぐ。
 */

function makeCatapult(): Catapult {
  return new Catapult(
    {
      from: new Vec3(14.71, 20, -11.64),
      // cat-1 の向き。−Z がほぼ機首方向で、4 度だけ左へ振れている
      direction: new Vec3(-0.0697, 0, -0.9976),
    },
    FIXED_DT,
  )
}

describe('射出の諸元', () => {
  /** C-13 カタパルトの公表値 150 kt */
  it('終端速度が 150 kt', () => {
    expect(LAUNCH_END_SPEED).toBeCloseTo(77.17, 1)
  })

  /** `a = v²/(2s)` = 77.17² / (2×94) */
  it('加速度が 3.2 G', () => {
    expect(LAUNCH_ACCEL).toBeCloseTo(31.67, 1)
    expect(LAUNCH_ACCEL / 9.80665).toBeCloseTo(3.23, 1)
  })

  it('所要時間が 2.44 秒', () => {
    expect(LAUNCH_SECONDS).toBeCloseTo(2.44, 2)
  })

  /**
   * **モデルの帯（115.0 m）より短い。**帯には前後の余裕が含まれる。
   * 実機の値を 2 つとも守ると帯の内側に収まる
   */
  it('行程がモデルのカタパルトの内側に収まる', () => {
    expect(LAUNCH_DISTANCE).toBeLessThan(115)
  })
})

describe('射出', () => {
  it('始めるまでは甲板で止まっている', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3(50, 0, 0)
    expect(cat.phase).toBe('onDeck')
    cat.hold(p, v)
    expect(p.x).toBeCloseTo(14.71, 2)
    // **甲板面ではなく車輪の高さぶん上。**原点を甲板に置くとめり込む
    expect(p.y).toBeCloseTo(20 + GEAR_HEIGHT, 2)
    expect(v.length()).toBe(0)
  })

  it('始めると launching になる', () => {
    const cat = makeCatapult()
    cat.fire(0)
    expect(cat.phase).toBe('launching')
  })

  /** **二度目は無視する。**始めたフレームが動くと位置が飛ぶ */
  it('二度目の fire を無視する', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    cat.fire(0)
    for (let f = 1; f <= 60; f++) cat.update(f, p, v)
    const at60 = p.clone()

    cat.fire(60)
    cat.update(61, p, v)
    // 61 フレーム目の位置は 60 フレーム目より進んでいる（やり直していない）
    expect(p.distanceTo(at60)).toBeGreaterThan(0)
    expect(p.distanceTo(at60)).toBeLessThan(2)
  })

  it('終端で公表値の速度に達する', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    cat.fire(0)
    let frame = 0
    while (cat.update(++frame, p, v)) {
      if (frame > 1000) throw new Error('射出が終わらない')
    }
    expect(cat.phase).toBe('airborne')
    expect(v.length()).toBeCloseTo(LAUNCH_END_SPEED, 0)
  })

  it('終端で行程ぶん進んでいる', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    const from = new Vec3(14.71, 20, -11.64)
    cat.fire(0)
    let frame = 0
    while (cat.update(++frame, p, v)) {
      if (frame > 1000) throw new Error('射出が終わらない')
    }
    // 固定ステップの端数で少しだけ超える
    expect(p.distanceTo(from)).toBeGreaterThan(LAUNCH_DISTANCE * 0.99)
    expect(p.distanceTo(from)).toBeLessThan(LAUNCH_DISTANCE * 1.05)
  })

  it('所要時間が公表値と合う', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    cat.fire(0)
    let frame = 0
    while (cat.update(++frame, p, v)) {
      if (frame > 1000) throw new Error('射出が終わらない')
    }
    const seconds = frame * FIXED_DT
    expect(seconds).toBeCloseTo(LAUNCH_SECONDS, 1)
  })

  /** 甲板の高さを保つ。射出中に沈まない */
  it('射出中も甲板の高さを保つ', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    cat.fire(0)
    let frame = 0
    while (cat.update(++frame, p, v)) {
      expect(p.y).toBeCloseTo(20 + GEAR_HEIGHT, 3)
      if (frame > 1000) throw new Error('射出が終わらない')
    }
  })

  /** 速度が単調に増える。途中で緩まない */
  it('速度が単調に増える', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    cat.fire(0)
    let previous = 0
    let frame = 0
    while (cat.update(++frame, p, v)) {
      const speed = v.length()
      expect(speed).toBeGreaterThanOrEqual(previous)
      previous = speed
      if (frame > 1000) throw new Error('射出が終わらない')
    }
  })

  /**
   * **airborne になったら書き換えない。**通常の飛行モデルへ引き渡した
   * あとも位置を書くと、飛んでいる機体が甲板へ引き戻される
   */
  it('airborne では位置を書き換えない', () => {
    const cat = makeCatapult()
    const p = new Vec3()
    const v = new Vec3()
    cat.fire(0)
    let frame = 0
    while (cat.update(++frame, p, v)) {
      if (frame > 1000) throw new Error('射出が終わらない')
    }
    const after = p.clone()
    p.set(9999, 9999, 9999)
    expect(cat.update(frame + 1, p, v)).toBe(false)
    expect(p.x).toBe(9999)
    expect(after.x).not.toBe(9999)
  })

  it('決定論。同じフレームで同じ位置になる', () => {
    const a = makeCatapult()
    const b = makeCatapult()
    const pa = new Vec3()
    const va = new Vec3()
    const pb = new Vec3()
    const vb = new Vec3()
    a.fire(0)
    b.fire(0)
    for (let f = 1; f <= 200; f++) {
      a.update(f, pa, va)
      b.update(f, pb, vb)
      expect(pa.x).toBe(pb.x)
      expect(pa.z).toBe(pb.z)
      expect(va.length()).toBe(vb.length())
    }
  })
})

describe('view', () => {
  it('始める前は onDeck で 0 フレーム', () => {
    const cat = makeCatapult()
    expect(cat.view(100)).toEqual({ phase: 'onDeck', frames: 0 })
  })

  it('始めてからの経過を返す', () => {
    const cat = makeCatapult()
    cat.fire(50)
    expect(cat.view(80).frames).toBe(30)
    expect(cat.view(80).phase).toBe('launching')
  })
})

/**
 * `World` に組み込んだ状態。
 *
 * **射出中は `Aircraft.step()` を通らない。**位置と速度をカタパルトが
 * 直接書く。操縦入力は届かない。
 */
describe('World の射出', () => {
  const SPEC = {
    from: new Vec3(14.71, 20, -11.64),
    direction: new Vec3(-0.0697, 0, -0.9976),
  }

  function makeWorld(): World {
    return new World({ seed: 1, launch: SPEC })
  }

  it('始まりは甲板の上', () => {
    const world = makeWorld()
    expect(world.catapult?.phase).toBe('onDeck')
    world.step({ ...neutralInput(), throttle: 0.5 })
    expect(world.player.position.y).toBeCloseTo(20 + GEAR_HEIGHT, 2)
    expect(world.player.speed).toBe(0)
  })

  /**
   * **甲板で操縦を受け付けない。**押しても動かないのが正しく、
   * `fireGun` が通ると甲板の上で撃ってしまう
   */
  it('甲板では操縦が効かない', () => {
    const world = makeWorld()
    const before = world.player.position.clone()
    for (let i = 0; i < 60; i++) {
      world.step({ ...neutralInput(), pitch: 1, roll: 1, throttle: 0.5 })
    }
    expect(world.player.position.distanceTo(before)).toBe(0)
    expect(world.player.bank).toBeCloseTo(0, 3)
  })

  /** スロットルを開けたら始まる。**専用のキーを増やさない** */
  it('スロットルを開けると射出が始まる', () => {
    const world = makeWorld()
    world.step({ ...neutralInput(), throttle: 0.5 })
    expect(world.catapult?.phase).toBe('onDeck')
    world.step({ ...neutralInput(), throttle: LAUNCH_THROTTLE + 0.05 })
    expect(world.catapult?.phase).toBe('launching')
  })

  it('射出が終わると通常の飛行モデルへ渡る', () => {
    const world = makeWorld()
    for (let i = 0; i < 600; i++) {
      world.step({ ...neutralInput(), throttle: 1 })
      if (world.catapult?.phase === 'airborne') break
    }
    expect(world.catapult?.phase).toBe('airborne')
    expect(world.player.speed).toBeGreaterThan(LAUNCH_END_SPEED * 0.95)

    // 引き渡したあとは飛行モデルが動かす。高度が変わる
    const y = world.player.position.y
    for (let i = 0; i < 120; i++) world.step({ ...neutralInput(), throttle: 1 })
    expect(world.player.position.y).not.toBe(y)
  })

  /** **射出中も敵は動く。**世界が止まると不自然 */
  it('射出中も敵が動く', () => {
    const world = new World({
      seed: 1,
      launch: SPEC,
      enemies: [{ offset: new Vec3(0, 500, -2000), speed: 250 }],
    })
    const enemy = world.enemies[0]!
    const before = enemy.position.clone()
    for (let i = 0; i < 60; i++) {
      world.step({ ...neutralInput(), throttle: 1 })
    }
    expect(enemy.position.distanceTo(before)).toBeGreaterThan(50)
  })

  /** 射出を要求しない台本では空中から始まる */
  it('launch を渡さなければ catapult は null', () => {
    const world = new World({ seed: 1 })
    expect(world.catapult).toBeNull()
  })

  it('決定論。同じ入力から同じ位置になる', () => {
    const a = makeWorld()
    const b = makeWorld()
    for (let i = 0; i < 400; i++) {
      const input = { ...neutralInput(), throttle: 1 }
      a.step(input)
      b.step({ ...neutralInput(), throttle: 1 })
    }
    expect(a.player.position.x).toBe(b.player.position.x)
    expect(a.player.position.y).toBe(b.player.position.y)
    expect(a.player.position.z).toBe(b.player.position.z)
  })
})

/**
 * 速度 0 の spawn。
 *
 * **実際に踏んだ。**射出の台本は `spawn: { altitude: 20, speed: 0 }` と
 * 書く（甲板で止まっているので）。`spawnFromSpec` はそこからトリムを
 * 求めるが、速度 0 では動圧が 0 になって `cl = 重量 / 0` が Infinity、
 * `drag = 0 × Infinity` が NaN になる。
 *
 * それが `throttle` として機体へ入り、射出中は `Aircraft.step()` を
 * 通らないので気づかない。**`airborne` へ移った瞬間に位置と速度がまとめて
 * NaN になった。**実測で frame 354。
 */
describe('速度 0 の spawn', () => {
  it('トリムが NaN を返さない', () => {
    const trim = trimCondition(0, airDensity(20))
    expect(Number.isFinite(trim.alpha), '迎角が NaN').toBe(true)
    expect(Number.isFinite(trim.throttle), 'スロットルが NaN').toBe(true)
    expect(trim.throttle).toBeGreaterThanOrEqual(0)
    expect(trim.throttle).toBeLessThanOrEqual(1)
  })

  it('負の速度でも NaN を返さない', () => {
    const trim = trimCondition(-50, airDensity(1000))
    expect(Number.isFinite(trim.alpha)).toBe(true)
    expect(Number.isFinite(trim.throttle)).toBe(true)
  })

  /**
   * **射出の台本を最後まで回して NaN が出ないこと。**単体の防御だけでは
   * 足りない。実際の経路で確かめる
   */
  it('射出の台本を回しても NaN が出ない', () => {
    const { world, player } = createWorldFromScript(getScript('catapult-launch'))
    for (let i = 0; i < 600; i++) {
      world.step(player.at(i))
      expect(Number.isFinite(world.player.position.y), `frame ${i} の高度`).toBe(true)
      expect(Number.isFinite(world.player.speed), `frame ${i} の速度`).toBe(true)
      expect(Number.isFinite(world.player.throttle), `frame ${i} のスロットル`).toBe(true)
    }
    // 射出は終わって飛んでいる
    expect(world.catapult?.phase).toBe('airborne')
    expect(world.player.speed).toBeGreaterThan(50)
  })

  /** 甲板で待つあいだスロットルは 0 */
  it('甲板ではスロットルが 0', () => {
    const { world } = createWorldFromScript(getScript('catapult-launch'))
    expect(world.player.throttle).toBe(0)
  })
})

/**
 * 車輪の高さ。
 *
 * **原本と突き合わせる。**機体を差し替えたときに片方だけ古くなると、
 * 甲板に浮くか、めり込む。
 */
describe('車輪の高さ', () => {
  it('原本の降着装置と一致する', () => {
    const { root } = parseAc3d(
      readFileSync(
        fileURLToPath(new URL('../../assets/upstream/f18/f18.ac', import.meta.url)),
        'latin1',
      ),
    )
    let lowest = Infinity
    for (const part of flatten(root)) {
      if (!DEFAULT_GEAR_PATTERN.test(part.name)) continue
      for (const v of part.vertices) {
        const y = toWorld(v)[1]
        if (y < lowest) lowest = y
      }
    }
    expect(lowest).toBeLessThan(0)
    expect(GEAR_HEIGHT).toBeCloseTo(-lowest, 2)
  })
})

/**
 * ミッションの時計。
 *
 * **甲板で待っている時間と射出の 2.4 秒を数えない。**制限時間は空へ出て
 * からのもの。
 */
describe('射出とミッションの時計', () => {
  const SPEC = {
    from: new Vec3(14.71, 20, -11.64),
    direction: new Vec3(-0.0697, 0, -0.9976),
  }
  const LIMIT = 3600

  it('甲板で待つあいだは減らない', () => {
    const world = new World({
      seed: 1,
      launch: SPEC,
      mission: { limitFrames: LIMIT },
      enemies: [{ offset: new Vec3(0, 500, -2000), speed: 250 }],
    })
    // スロットルを開けずに 300 フレーム待つ
    for (let i = 0; i < 300; i++) world.step({ ...neutralInput(), throttle: 0.5 })
    expect(world.catapult?.phase).toBe('onDeck')
    expect(world.mission?.started, '甲板で時計が動いている').toBe(false)
    expect(world.mission?.remainingFrames(world.frame)).toBe(LIMIT)
  })

  it('射出中も減らない', () => {
    const world = new World({
      seed: 1,
      launch: SPEC,
      mission: { limitFrames: LIMIT },
      enemies: [{ offset: new Vec3(0, 500, -2000), speed: 250 }],
    })
    let launching = 0
    for (let i = 0; i < 600; i++) {
      world.step({ ...neutralInput(), throttle: 1 })
      if (world.catapult?.phase === 'launching') {
        launching++
        expect(world.mission?.started, '射出中に時計が動いている').toBe(false)
      }
      if (world.catapult?.phase === 'airborne') break
    }
    expect(launching, '射出の途中を通っていない').toBeGreaterThan(100)
  })

  /** 空へ出たら数え始める */
  it('airborne になってから減る', () => {
    const world = new World({
      seed: 1,
      launch: SPEC,
      mission: { limitFrames: LIMIT },
      enemies: [{ offset: new Vec3(0, 500, -2000), speed: 250 }],
    })
    for (let i = 0; i < 600; i++) {
      world.step({ ...neutralInput(), throttle: 1 })
      if (world.catapult?.phase === 'airborne') break
    }
    expect(world.mission?.started).toBe(true)
    const atStart = world.mission!.remainingFrames(world.frame)
    // 始まった直後なのでほぼ満タン
    expect(atStart).toBeGreaterThan(LIMIT - 5)

    for (let i = 0; i < 240; i++) world.step({ ...neutralInput(), throttle: 1 })
    expect(world.mission!.remainingFrames(world.frame)).toBeLessThan(atStart - 235)
  })

  /**
   * **射出のない台本はフレーム 0 が起点。**`step()` は `_frame++` の
   * あとに `mission.update()` を呼ぶので、自動開始に任せると 1 フレーム
   * ずれる。実測で基準画像 `hud-mission` が 156 画素動いた
   */
  it('射出のない台本はフレーム 0 が起点', () => {
    const world = new World({
      seed: 1,
      mission: { limitFrames: LIMIT },
      enemies: [{ offset: new Vec3(0, 500, -2000), speed: 250 }],
    })
    world.step(neutralInput())
    expect(world.mission?.started).toBe(true)
    expect(world.mission?.elapsedFrames(world.frame)).toBe(1)
    expect(world.mission?.remainingFrames(world.frame)).toBe(LIMIT - 1)
  })
})
