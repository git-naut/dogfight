import { describe, it, expect } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { World, createWorldFromScript } from '@sim/world'
import { getScript } from '@sim/scripts'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { makeInput } from '@sim/input'
import { FIXED_DT } from '@sim/loop'
import {
  ARRESTOR,
  Arrestor,
  HOOK_DOWN_ANGLE,
  HOOK_PIVOT,
  HOOK_POINT_STOWED,
  hookPointBody,
} from '@sim/arrestor'
import { WHEELS, crossWireLocal, lowestContact } from '@sim/deckContact'
import { FORD_DECK_HEIGHT, FORD_WIRES } from '@sim/fordDeck'

/**
 * 着艦フックと拘束索（Phase 9 の段 8）。
 *
 * 値はユーザーと合意した（2026-10-14、ADR 0018）。引き出し長 344 ft と索の高さ 5 1/2 in は
 * NAVEDTRA 14310 第 3 章（Mk 7）、最大速度 175 mph は DVIDS の NAVAIR の写真説明。中心からの
 * ずれは索の線分の長さが限界。範囲を外れたら掛からずにボルター（ユーザーの判断）
 */
const FT = 0.3048
const KT = 0.514444
const G = 9.80665
const DEG = Math.PI / 180
const CARRIER = { x: 0, z: 0, heading: 0 } as const

/** 機首を −Z へ向け、機首上げ `pitchDeg` の姿勢 */
function nosedUp(pitchDeg: number): Quat {
  return new Quat().setFromAxisAngle(new Vec3(1, 0, 0), pitchDeg * DEG)
}

/**
 * 空母の座標 (x, z) で、車輪を甲板に載せて −Z へ `speed` m/s で走っている自機。フックは
 * 下ろし切り（`hook` が false なら上げ切り）。空母は向き 0 で原点
 */
function rolling(opts: { x?: number; z: number; speed?: number; hook?: boolean; pitch?: number }): World {
  const orientation = nosedUp(opts.pitch ?? 0)
  const position = new Vec3(opts.x ?? -1.5, 0, opts.z)
  position.y = FORD_DECK_HEIGHT + 0.01 - lowestContact(position, orientation, true)
  const world = new World({
    seed: 1,
    carrier: CARRIER,
    aircraft: {
      position,
      velocity: new Vec3(0, -0.2, -(opts.speed ?? 65)),
      orientation,
      throttle: 0,
      gearDown: true,
    },
  })
  if (opts.hook !== false) {
    world.player.hookCommandDown = true
    world.player.hookPosition = 1
  }
  return world
}

/** `steps` ステップ回す。スロットルは `throttle` */
function run(world: World, steps: number, throttle = 0): void {
  for (let i = 0; i < steps; i++) world.step(makeInput({ throttle }))
}

describe('値と出典', () => {
  it('引き出し長 344 ft、索の上端 5 1/2 in、最大速度 175 mph（NAVEDTRA 14310・DVIDS）', () => {
    expect(ARRESTOR.runout).toBeCloseTo(104.8512, 4)
    expect(ARRESTOR.wireHeight).toBeCloseTo(0.1397, 4)
    expect(ARRESTOR.maxEngageSpeed / KT).toBeCloseTo(152.07, 2)
  })

  it('下ろし切ったフックの先端は、機首 0 度で主輪の下端より 0.1 m 以上下に出る', () => {
    const tip = hookPointBody(HOOK_DOWN_ANGLE, new Vec3())
    const mainWheel = Math.min(WHEELS[0]![1], WHEELS[1]![1])
    expect(tip.y).toBeLessThan(mainWheel - 0.1)
    // 収納の姿勢では胴体の下面（主輪の付け根より上）に収まっている
    expect(hookPointBody(0, new Vec3()).y).toBeGreaterThan(-0.4)
  })
})

describe('Arrestor（閉じた式）', () => {
  it('130 kt で掛かると 2.17 G で減速し、3.1 秒・104.85 m で止まる', () => {
    const v0 = 130 * KT
    const a = new Arrestor(0, 0, 0, -1, v0, FIXED_DT)
    expect(a.decel / G).toBeCloseTo(2.17, 2)
    expect(a.stopSteps * FIXED_DT).toBeCloseTo(3.1, 1)
    const p = new Vec3()
    const v = new Vec3()
    while (!a.stopped) a.advance(p, v)
    expect(-p.z).toBeCloseTo(ARRESTOR.runout, 6)
    expect(v.length()).toBe(0)
    // 止まったあとは進まない
    a.advance(p, v)
    expect(-p.z).toBeCloseTo(ARRESTOR.runout, 6)
  })

  it('速さに依らず引き出し長は同じ（Mk 7 の一定の引き出し長）', () => {
    for (const kt of [100, 130, 150]) {
      const a = new Arrestor(10, 20, 0.6, -0.8, kt * KT, FIXED_DT)
      const p = new Vec3()
      const v = new Vec3()
      while (!a.stopped) a.advance(p, v)
      expect(Math.hypot(p.x - 10, p.z - 20), `${kt} kt`).toBeCloseTo(ARRESTOR.runout, 6)
      expect(a.distance).toBeCloseTo(ARRESTOR.runout, 6)
    }
  })
})

describe('索を越えたかの掃引（crossWireLocal）', () => {
  const mid = (i: number): [number, number] => {
    const w = FORD_WIRES[i]!
    return [(w.starboard[0] + w.port[0]) / 2, (w.starboard[1] + w.port[1]) / 2]
  }

  it('中点を越えれば、その索で、ずれ 0', () => {
    const [x, z] = mid(1)
    const c = crossWireLocal(x, z + 0.3, x, z - 0.3)
    expect(c?.index).toBe(1)
    expect(c!.offCenter).toBeCloseTo(0, 9)
    expect(c!.t).toBeCloseTo(0.5, 2)
  })

  it('右舷寄りを越えるとずれは正、左舷寄りは負', () => {
    const w = FORD_WIRES[0]!
    const sx = w.starboard[0] - 1
    const px = w.port[0] + 1
    expect(crossWireLocal(sx, w.starboard[1] + 1, sx, w.starboard[1] - 1)!.offCenter).toBeGreaterThan(11)
    expect(crossWireLocal(px, w.port[1] + 1, px, w.port[1] - 1)!.offCenter).toBeLessThan(-11)
  })

  it('索の端の外を通れば越えない', () => {
    const w = FORD_WIRES[0]!
    expect(crossWireLocal(w.starboard[0] + 0.5, w.starboard[1] + 1, w.starboard[0] + 0.5, w.starboard[1] - 1)).toBeNull()
    expect(crossWireLocal(w.port[0] - 0.5, w.port[1] + 1, w.port[0] - 0.5, w.port[1] - 1)).toBeNull()
  })

  it('1 ステップで 2 本を越えても、始点に近い索を返す（すり抜けない）', () => {
    const [x0, z0] = mid(0)
    const [, z2] = mid(2)
    expect(crossWireLocal(x0, z0 + 1, x0, z2 - 1)?.index).toBe(0)
  })
})

describe('拘束索に掛かる', () => {
  it.each([
    // フックの先端は原点より 6.9 m ほど艦尾側にある。先端が 1 つ前の索を越えたところから
    // 走らせる。横は、その索の位置での着艦区域の中心線（x = 0.1576 z − 17.21）
    [1, 125, 0.1],
    [2, 98, -1.9],
    [3, 84, -3.6],
  ])('%i 本目の手前（原点 z %i）から走ると、その索に掛かり 104.85 m 進んで止まる', (wire, z, x) => {
    const world = rolling({ z, x })
    let engaged: Vec3 | null = null
    for (let i = 0; i < 1200; i++) {
      world.step(makeInput({ throttle: 0 }))
      if (engaged === null && world.player.arrestor !== null) engaged = world.player.position.clone()
    }
    const p = world.player
    expect(p.crashed).toBe(false)
    expect(p.landing?.kind).toBe('trap')
    if (p.landing?.kind !== 'trap') return
    expect(p.landing.wire).toBe(wire)
    expect(Math.abs(p.landing.offCenter)).toBeLessThan(0.5)
    expect(p.arrestor!.stopped).toBe(true)
    expect(p.speed).toBeLessThan(1e-6)
    // 掛かった次のステップから測ると、1 ステップぶん（0.54 m）短い
    const moved = Math.hypot(p.position.x - engaged!.x, p.position.z - engaged!.z)
    expect(moved).toBeGreaterThan(ARRESTOR.runout - 0.6)
    expect(moved).toBeLessThanOrEqual(ARRESTOR.runout + 1e-6)
    expect(p.arrestor!.distance).toBeCloseTo(ARRESTOR.runout, 6)
  })

  it('止まったあとはスロットル全開でも動かない（その場で止めておく）', () => {
    const world = rolling({ z: 125 })
    run(world, 600)
    const stopped = world.player.position.clone()
    run(world, 600, 1)
    expect(world.player.position.x).toBeCloseTo(stopped.x, 9)
    expect(world.player.position.z).toBeCloseTo(stopped.z, 9)
    expect(world.player.crashed).toBe(false)
  })

  it('甲板に当たったフックは跳ね上がり、先端が甲板に載る角度になる', () => {
    const world = rolling({ z: 140 })
    run(world, 2)
    const p = world.player
    expect(p.hookAngle).toBeLessThan(HOOK_DOWN_ANGLE)
    expect(p.hookAngle).toBeGreaterThan(0)
    const tip = hookPointBody(p.hookAngle, new Vec3())
    p.orientation.rotate(tip, tip)
    expect(p.position.y + tip.y).toBeCloseTo(FORD_DECK_HEIGHT, 4)
  })

  /**
   * フックを途中まで下ろし、先端が甲板から `height` m 上を通るようにして索を越えさせる。
   * フックは上げる向きに 1 秒で動くので、越える 2 ステップ前から始める（動くのは 0.017）
   */
  function passAbove(height: number): World {
    const z = 125
    const world = rolling({ z, x: 0.1 })
    const p = world.player
    // 機首 0 度で走っているときの先端の高さが `height` になるフックの位置を二分法で探す
    const deckTop = FORD_DECK_HEIGHT - p.position.y
    let lo = 0
    let hi = 1
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (hookPointBody(mid * HOOK_DOWN_ANGLE, new Vec3()).y > deckTop + height) lo = mid
      else hi = mid
    }
    p.hookCommandDown = false
    p.hookPosition = lo
    // 先端が 1 本目の索の 0.9 m 手前に来るよう、原点を前へ置き直す
    const tip = hookPointBody(lo * HOOK_DOWN_ANGLE, new Vec3())
    const wire = FORD_WIRES[0]!
    const wireZ = wire.starboard[1] + ((wire.port[1] - wire.starboard[1]) * (wire.starboard[0] - 0.1)) / (wire.starboard[0] - wire.port[0])
    p.position.z = wireZ + 0.9 - tip.z
    run(world, 4)
    return world
  }

  it('先端が索の上端（5 1/2 in）より低く通れば掛かり、高く通れば掛からない', () => {
    expect(passAbove(0.1).player.arrestor, '甲板から 0.10 m').not.toBeNull()
    expect(passAbove(0.18).player.arrestor, '甲板から 0.18 m').toBeNull()
  })

  it('最大速度ちょうど手前（150 kt）でも掛かる', () => {
    const world = rolling({ z: 125, speed: 150 * KT })
    run(world, 300)
    expect(world.player.landing?.kind).toBe('trap')
  })
})

describe('ボルター（掛からずに走り抜ける）', () => {
  /** 走らせ、甲板を離れたら全開で上がる。結果を返す */
  function bolter(world: World): World {
    for (let i = 0; i < 1800 && !world.player.crashed; i++) {
      world.step(makeInput({ throttle: 1, pitch: world.player.onDeck ? 0.3 : 0.2 }))
    }
    return world
  }

  it('フックを上げたままなら hookUp', () => {
    const world = bolter(rolling({ z: 125, hook: false }))
    expect(world.player.landing).toMatchObject({ kind: 'bolter', reason: 'hookUp' })
    expect(world.player.arrestor).toBeNull()
  })

  it('最大速度（152 kt）を超えていれば掛からず tooFast', () => {
    const world = bolter(rolling({ z: 125, speed: 160 * KT }))
    expect(world.player.landing).toMatchObject({ kind: 'bolter', reason: 'tooFast' })
    expect(world.player.arrestor).toBeNull()
  })

  it.each([
    ['左舷', -17],
    ['右舷', 13.5],
  ])('%s寄りに索の端の外を通れば掛からず missed', (_side, x) => {
    const world = bolter(rolling({ z: 125, x }))
    expect(world.player.landing).toMatchObject({ kind: 'bolter', reason: 'missed' })
  })

  it('ボルターのあとは飛んでいて、墜落していない', () => {
    const world = bolter(rolling({ z: 125, hook: false }))
    expect(world.player.crashed).toBe(false)
    expect(world.player.position.y).toBeGreaterThan(FORD_DECK_HEIGHT + 20)
  })
})

describe('甲板で起きた墜落も結果に残す', () => {
  it('脚を上げたまま触れると crash（belly）', () => {
    const orientation = nosedUp(4)
    const world = new World({
      seed: 1,
      carrier: CARRIER,
      aircraft: {
        position: new Vec3(-1.5, FORD_DECK_HEIGHT + 1.2, 60),
        velocity: new Vec3(0, -2, -65),
        orientation,
        throttle: 0.3,
      },
    })
    run(world, 120, 0.3)
    expect(world.player.landing).toMatchObject({ kind: 'crash', cause: 'belly' })
  })
})

describe('H キー（World）', () => {
  it('押した瞬間だけ切り替わり、押しっぱなしでは 1 回だけ。1 秒で下り切る', () => {
    const world = new World({ seed: 1 })
    world.step(makeInput({ hookToggle: true }))
    for (let i = 0; i < 60; i++) world.step(makeInput({ hookToggle: true }))
    expect(world.player.hookCommandDown).toBe(true)
    expect(world.player.hookPosition).toBeGreaterThan(0.4)
    expect(world.player.hookPosition).toBeLessThan(0.6)
    run(world, 60)
    expect(world.player.hookPosition).toBe(1)
    world.step(makeInput({ hookToggle: true }))
    expect(world.player.hookCommandDown).toBe(false)
  })

  it('射出中は受け付けない', () => {
    const { world } = createWorldFromScript(getScript('catapult-launch'))
    for (let i = 0; i < 200; i++) world.step(makeInput({ throttle: 1, hookToggle: i % 2 === 0 }))
    expect(world.catapult?.phase).not.toBe('airborne')
    expect(world.player.hookCommandDown).toBe(false)
  })
})

describe('台本 deck-landing', () => {
  it('f355 に軟着地し、f378 に 1 本目に掛かって、f761 に 104.85 m で止まる', () => {
    const { world, player } = createWorldFromScript(getScript('deck-landing'))
    const at: Record<string, number> = {}
    for (let i = 0; i < 900; i++) {
      world.step(player.at(i))
      const p = world.player
      if (at.touchdown === undefined && p.lastTouchdown !== null) at.touchdown = world.frame
      if (at.trap === undefined && p.arrestor !== null) at.trap = world.frame
      if (at.stop === undefined && p.arrestor?.stopped === true) at.stop = world.frame
    }
    expect(at).toEqual({ touchdown: 355, trap: 378, stop: 761 })
    const landing = world.player.landing
    expect(landing?.kind).toBe('trap')
    if (landing?.kind !== 'trap') return
    expect(landing.wire).toBe(1)
    expect(landing.engageSpeed / KT).toBeCloseTo(127.7, 1)
    expect(Math.abs(landing.offCenter)).toBeLessThan(0.05)
    expect(landing.touchdown!.sinkRate / FT).toBeCloseTo(2.14, 2)
    expect(world.player.crashed).toBe(false)
  })
})

/**
 * **フックの付け根と先端を原本と突き合わせる。**機体を差し替えたときに片方だけ古くなると、
 * 見えるフックと当たるフックがずれる
 */
describe('原本との突き合わせ', () => {
  it('付け根と、収納の姿勢の先端の下側の縁が原本と一致する', async () => {
    const { buildGearHinges } = await import('../../tools/f18e-hinges.mjs')
    const { identifyParts, SCALE } = await import('../../tools/f18e-parts.mjs')
    const { readGltfParts } = await import('../../tools/gltf-parts.mjs')
    const gltf = fileURLToPath(new URL('../../assets/upstream/f18e/scene.gltf', import.meta.url))
    const { hook } = buildGearHinges(gltf)
    // 原本の (x, y, z) → 機体座標 (−z, y, x)（`tools/f18e-to-glb.mjs` と同じ回転）
    const o = hook.origin as number[]
    expect(-o[2]!).toBeCloseTo(HOOK_PIVOT[0], 2)
    expect(o[1]!).toBeCloseTo(HOOK_PIVOT[1], 2)
    expect(o[0]!).toBeCloseTo(HOOK_PIVOT[2], 2)

    const names = new Set(identifyParts(gltf).hook.map((p) => p.raw.parent ?? p.name))
    const vertices = readGltfParts(gltf, { vertices: true })
      .parts.filter((p) => names.has(p.parent ?? p.name))
      .flatMap((p) => (p.vertices ?? []).map((v) => v.map((x) => x * SCALE)))
    // 後端（いちばん後ろの頂点から 5 cm）の、いちばん低い点
    const aft = Math.max(...vertices.map((v: number[]) => v[0]!))
    const end = vertices.filter((v: number[]) => v[0]! >= aft - 0.05)
    const low = Math.min(...end.map((v: number[]) => v[1]!))
    expect(low - o[1]!).toBeCloseTo(HOOK_POINT_STOWED[0], 2)
    expect(aft - o[0]!).toBeCloseTo(HOOK_POINT_STOWED[1], 2)
  })
})
