import { describe, it, expect } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { World, createWorldFromScript } from '@sim/world'
import { getScript } from '@sim/scripts'
import { Vec3 } from '@sim/vec3'
import { Quat } from '@sim/quat'
import { makeInput } from '@sim/input'
import {
  BELLY_DEPTH,
  TOUCHDOWN_LIMITS,
  WHEELS,
  carrierDeckSampler,
  lowestContact,
  pitchOf,
  rollOf,
} from '@sim/deckContact'
import { FORD_DECK_HEIGHT } from '@sim/fordDeck'

/**
 * 空母の甲板の当たり（Phase 9 の段 7）。
 *
 * 判定の値はユーザーと合意した（2026-10-14、ADR 0018）。墜落は F/A-18E/F の構造設計の範囲
 * （AIAA 2016-1770 PDF 13 頁 Figure 10）の外と、傾き ±22.1 度の外。17.67 ft/s（5.39 m/s）超えは
 * 硬い着地として記録だけ（同 Table 1 の通常の着艦の平均 + 2σ）
 */
const FT = 0.3048

const DEG = Math.PI / 180
const CARRIER = { x: 0, z: 0, heading: 0 } as const
/** 甲板の上の点（空母の座標）。着艦区域の中ほど */
const ON_DECK = { x: -20, z: 40 }

/** 機首を −Z へ向け、機首上げ `pitch`・右翼下げ `roll` の姿勢 */
function attitude(pitchDeg: number, rollDeg: number): Quat {
  const q = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), pitchDeg * DEG)
  // 機首方向（−Z）まわりに +a 回すと右翼 (1, 0, 0) は (cos a, −sin a, 0) へ写る（右翼が下がる）
  q.multiply(new Quat().setFromAxisAngle(new Vec3(0, 0, -1), rollDeg * DEG))
  return q
}

/** 甲板の少し上から、降下率 `sink` m/s で降りてくる自機 */
function approach(opts: {
  sink: number
  pitch?: number
  roll?: number
  gearDown?: boolean
  speed?: number
  x?: number
  z?: number
  height?: number
}): World {
  const pitch = opts.pitch ?? 4
  const roll = opts.roll ?? 0
  const orientation = attitude(pitch, roll)
  const position = new Vec3(opts.x ?? ON_DECK.x, 0, opts.z ?? ON_DECK.z)
  // いちばん低い接点が甲板の `height` 上に来るように置く
  const gearDown = opts.gearDown ?? true
  position.y = 0
  const lowest = lowestContact(position, orientation, gearDown)
  position.y = FORD_DECK_HEIGHT + (opts.height ?? 0.05) - lowest
  return new World({
    seed: 1,
    carrier: CARRIER,
    aircraft: {
      position,
      velocity: new Vec3(0, -opts.sink, -(opts.speed ?? 65)),
      orientation,
      throttle: 0.3,
      gearDown,
    },
  })
}

/** 触れるか墜落するまで回す（上限 120 ステップ） */
function untilContact(world: World, input = makeInput({ throttle: 0.3 })): number {
  for (let i = 0; i < 120; i++) {
    world.step(input)
    if (world.player.onDeck || world.player.crashed) return i
  }
  return -1
}

describe('姿勢の読み方', () => {
  it('作った姿勢から機首の角度と傾きが読み戻せる（符号の約束）', () => {
    expect(pitchOf(attitude(5, 0)) / DEG).toBeCloseTo(5, 6)
    expect(rollOf(attitude(0, 10)) / DEG).toBeCloseTo(10, 6)
    expect(rollOf(attitude(0, -12)) / DEG).toBeCloseTo(-12, 6)
    // 両方を掛けると、右翼の高さで読む傾きは機首上げの分だけ小さく出る（asin(sin 10° cos 5°)）
    expect(rollOf(attitude(5, 10)) / DEG).toBeCloseTo(9.96, 2)
  })
})

/**
 * **射出の姿勢の機首は射出の向きを向く**（2026-10-14）。以前は左右逆で、帯が 4.37 度傾く cat-3 では
 * 機首が 8.74 度ずれ、ユーザーが「cat-3 に対してまっすぐ配置されていない」と指摘した。甲板を走る
 * ときに姿勢をそろえる処理も同じ式を使う
 */
describe('射出の姿勢の向き', () => {
  it.each([4.37, -4.03, 30, 90])('帯が %s 度傾いても、機首は帯の向きを向く', async (deg) => {
    const { Aircraft } = await import('@sim/aircraft')
    const a = new Aircraft({ position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, -50) })
    const r = deg * DEG
    const dir = new Vec3(Math.sin(r), 0, -Math.cos(r))
    a.syncFromLaunch(dir, 0)
    const nose = a.orientation.rotate(new Vec3(0, 0, -1))
    expect(nose.x).toBeCloseTo(dir.x, 9)
    expect(nose.z).toBeCloseTo(dir.z, 9)
  })
})

describe('甲板の形', () => {
  const deck = carrierDeckSampler(CARRIER)
  it('着艦区域の中ほどは甲板、艦首の先と舷側の外は甲板ではない', () => {
    expect(deck.deckHeightAt(ON_DECK.x, ON_DECK.z)).toBe(FORD_DECK_HEIGHT)
    expect(deck.deckHeightAt(0, -200)).toBeNull()
    expect(deck.deckHeightAt(80, 0)).toBeNull()
  })
  it('艦橋の箱は甲板の右舷の後ろ寄り、高さ 61.8 m まで', () => {
    expect(deck.insideIsland(30, 40, 90)).toBe(true)
    expect(deck.insideIsland(30, 70, 90)).toBe(false)
    expect(deck.insideIsland(-30, 40, 90)).toBe(false)
  })
  it('空母の向きを変えると甲板も一緒に回る（右回りが正）', () => {
    // 90 度右へ回すと、空母の座標の −Z（艦首）が世界の +X を向く
    const turned = carrierDeckSampler({ x: 0, z: 0, heading: Math.PI / 2 })
    expect(turned.deckHeightAt(150, 0)).toBe(FORD_DECK_HEIGHT)
    expect(turned.deckHeightAt(0, -150)).toBeNull()
  })
})

describe('甲板に降りる', () => {
  it('軟着地: 降下率 3 m/s・機首 4 度で、車輪で走る', () => {
    const world = approach({ sink: 3 })
    expect(untilContact(world)).toBeGreaterThanOrEqual(0)
    const p = world.player
    expect(p.crashed).toBe(false)
    expect(p.onDeck).toBe(true)
    expect(p.lastTouchdown).not.toBeNull()
    expect(p.lastTouchdown!.hard).toBe(false)
    expect(p.lastTouchdown!.sinkRate).toBeGreaterThan(2.9)
    expect(p.lastTouchdown!.sinkRate).toBeLessThan(TOUCHDOWN_LIMITS.hardSinkRate)
    // 車輪が甲板の上に載っている
    expect(lowestContact(p.position, p.orientation, true)).toBeCloseTo(FORD_DECK_HEIGHT, 4)
    // 走っているあいだは傾き 0
    for (let i = 0; i < 30; i++) world.step(makeInput({ throttle: 0.3 }))
    expect(Math.abs(rollOf(p.orientation))).toBeLessThan(1e-9)
    expect(p.velocity.y).toBeGreaterThanOrEqual(0)
  })

  it('硬い着地: 降下率 20 ft/s は墜落しないが記録する（17.67 ft/s 超え）', () => {
    const world = approach({ sink: 20 * FT })
    untilContact(world)
    expect(world.player.crashed).toBe(false)
    expect(world.player.lastTouchdown!.hard).toBe(true)
  })

  it('通常の着艦の平均 13.65 ft/s は硬い着地に数えない', () => {
    const world = approach({ sink: 13.65 * FT })
    untilContact(world)
    expect(world.player.crashed).toBe(false)
    expect(world.player.lastTouchdown!.hard).toBe(false)
  })

  it('硬着地: 降下率 28 ft/s（構造設計の範囲の上端 26.4 ft/s 超え）は墜落', () => {
    const world = approach({ sink: 28 * FT })
    untilContact(world)
    expect(world.player.crashed).toBe(true)
    expect(world.player.crashCause).toBe('deckSink')
  })

  it.each([
    ['機首上げ 14 度（範囲の右端 12.8 度の外）', 14, 0],
    ['機首下げ −5 度（範囲の左端 −3.2 度の外）', -5, 0],
    ['右へ 25 度', 4, 25],
    ['左へ 25 度', 4, -25],
  ])('姿勢が範囲の外（%s）は墜落', (_, pitch, roll) => {
    const world = approach({ sink: 2, pitch, roll })
    untilContact(world)
    expect(world.player.crashed).toBe(true)
    expect(world.player.crashCause).toBe('deckAttitude')
  })

  it('姿勢が範囲の内側の端（機首 12 度・傾き 20 度）は墜落しない', () => {
    const world = approach({ sink: 2, pitch: 12, roll: 20 })
    untilContact(world)
    expect(world.player.crashed).toBe(false)
  })

  /**
   * **降下率と機首は組で見る。**構造設計の範囲は楕円なので、降下率が大きいほど許される機首の
   * 幅が狭い。22 ft/s では右端が約 11.3 度
   */
  it.each([
    ['22 ft/s・機首 5 度は内側', 5, false],
    ['22 ft/s・機首 12 度は外側', 12, true],
  ])('%s', (_, pitch, crashed) => {
    const world = approach({ sink: 22 * FT, pitch })
    untilContact(world)
    expect(world.player.crashed).toBe(crashed)
  })

  it('脚を上げたまま: 胴体が触れて墜落', () => {
    const world = approach({ sink: 2, gearDown: false })
    untilContact(world)
    expect(world.player.crashed).toBe(true)
    expect(world.player.crashCause).toBe('belly')
  })

  it('甲板を走っているあいだは G で脚が上がらない', () => {
    const world = approach({ sink: 2 })
    untilContact(world)
    expect(world.player.onDeck).toBe(true)
    world.step(makeInput({ throttle: 0.3, gearToggle: true }))
    world.step(makeInput({ throttle: 0.3 }))
    expect(world.player.gearCommandDown).toBe(true)
    expect(world.player.crashed).toBe(false)
  })
})

describe('艦橋と船体', () => {
  it('艦橋への衝突: 箱に入ったら墜落', () => {
    const world = new World({
      seed: 1,
      carrier: CARRIER,
      aircraft: { position: new Vec3(30, 40, 140), velocity: new Vec3(0, 0, -100), throttle: 0.8 },
    })
    for (let i = 0; i < 120 && !world.player.crashed; i++) world.step(makeInput({ throttle: 0.8 }))
    expect(world.player.crashCause).toBe('island')
  })

  it('甲板より低く艦尾から入ると、船体に入ったので墜落', () => {
    const world = new World({
      seed: 1,
      carrier: CARRIER,
      aircraft: { position: new Vec3(-10, 12, 220), velocity: new Vec3(0, 0, -100), throttle: 0.8 },
    })
    for (let i = 0; i < 240 && !world.player.crashed; i++) world.step(makeInput({ throttle: 0.8 }))
    expect(world.player.crashCause).toBe('hull')
  })
})

describe('甲板の外', () => {
  it('艦首からの降下: 甲板の外は今までどおり海面で墜落し、着艦の記録は付かない', () => {
    const world = new World({
      seed: 1,
      carrier: CARRIER,
      aircraft: {
        position: new Vec3(0, FORD_DECK_HEIGHT + 2, -200),
        velocity: new Vec3(0, -8, -60),
        throttle: 0,
        gearDown: true,
      },
    })
    for (let i = 0; i < 600 && !world.player.crashed; i++) world.step(makeInput({ throttle: 0 }))
    expect(world.player.crashCause).toBe('ground')
    expect(world.player.lastTouchdown).toBeNull()
  })

  it('タッチ・アンド・ゴー: 降りたあと全開で引けば、甲板を離れて飛ぶ', () => {
    const world = approach({ sink: 2, speed: 75, x: -10, z: 120 })
    untilContact(world)
    expect(world.player.onDeck).toBe(true)
    let left = -1
    for (let i = 0; i < 1200; i++) {
      world.step(makeInput({ throttle: 1, pitch: i > 30 ? 0.6 : 0 }))
      if (left < 0 && !world.player.onDeck) left = i
    }
    expect(left).toBeGreaterThanOrEqual(0)
    expect(world.player.crashed).toBe(false)
    expect(world.player.position.y).toBeGreaterThan(FORD_DECK_HEIGHT + 30)
  })
})

/**
 * **射出の終点から甲板の縁まで、着艦とも墜落とも判定しない。**射出が終わった瞬間は甲板を
 * 走っている状態で渡す（`releaseOnDeck`）。縁を越えて普通に飛ぶ
 */
describe('射出との兼ね合い', () => {
  it.each(['catapult-launch', 'mission-01'])('%s は射出のあと着艦の記録が付かず、甲板の縁を越えて飛ぶ', (name) => {
    const { world, player } = createWorldFromScript(getScript(name))
    let rolled = 0
    let leftAt = -1
    for (let i = 0; i < 1200; i++) {
      world.step(player.at(i))
      if (world.catapult?.phase === 'airborne') {
        if (world.player.onDeck) rolled++
        else if (leftAt < 0) leftAt = world.frame
      }
    }
    expect(world.player.lastTouchdown).toBeNull()
    expect(world.player.crashCause).not.toBe('deckSink')
    expect(world.player.crashCause).not.toBe('hull')
    // 実測: f346 に射出が終わり、フラップの揚力ですぐ浮いて f348 に離れる（フラップを足す前は f370）
    expect(rolled).toBeGreaterThan(0)
    expect(leftAt).toBeGreaterThan(346)
    expect(leftAt).toBeLessThan(400)
  })

  it('射出の台本は f3000 まで落ちずに上がる', () => {
    const { world, player } = createWorldFromScript(getScript('catapult-launch'))
    let min = Infinity
    for (let i = 0; i < 3000; i++) {
      world.step(player.at(i))
      if (world.catapult?.phase === 'airborne') min = Math.min(min, world.player.position.y)
    }
    expect(world.player.crashed).toBe(false)
    // 実測: 最低 20.63 m（射出の終点）、f3000 で 424.8 m（フラップを足す前は 18.59 m・360.6 m）
    expect(min).toBeGreaterThan(17)
    expect(world.player.position.y).toBeGreaterThan(300)
  })
})

/**
 * **車輪と機体の最下点の位置を原本と突き合わせる。**機体を差し替えたときに片方だけ古くなると、
 * 甲板に浮くか、めり込む（`launch.test.ts` の車輪の高さと同じ作法）
 */
describe('原本との突き合わせ', () => {
  it('車輪 3 つと、脚を上げたときの最下点が原本と一致する', async () => {
    const { identifyParts, SCALE } = await import('../../tools/f18e-parts.mjs')
    const id = identifyParts(
      fileURLToPath(new URL('../../assets/upstream/f18e/scene.gltf', import.meta.url)),
    )
    const wheels = id.gear.filter((p) => p.raw.min[1]! * SCALE < -1.55)
    expect(wheels.length).toBe(3)
    // 原本の (x, y, z) → 機体座標 (−z, y, x)（`tools/f18e-to-glb.mjs` と同じ回転）
    const measured = wheels
      .map((p) => {
        const cx = ((p.raw.min[0]! + p.raw.max[0]!) / 2) * SCALE
        const cz = ((p.raw.min[2]! + p.raw.max[2]!) / 2) * SCALE
        return [-cz, p.raw.min[1]! * SCALE, cx] as const
      })
      .sort((a, b) => a[0] - b[0])
    const expected = [...WHEELS].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 3; k++) expect(expected[i]![k]).toBeCloseTo(measured[i]![k]!, 2)
    }
    const gear = new Set(id.gear.map((p) => p.name))
    const hook = new Set((id.hook ?? []).map((p) => p.name))
    const belly = Math.min(
      ...id.parts.filter((p) => !gear.has(p.name) && !hook.has(p.name)).map((p) => p.raw.min[1]! * SCALE),
    )
    expect(BELLY_DEPTH).toBeCloseTo(-belly, 2)
  }, 120_000)
})
