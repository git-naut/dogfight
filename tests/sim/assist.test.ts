import { describe, expect, it } from 'vitest'
import {
  applyAssist,
  isControlMode,
  type AssistView,
  type ControlMode,
} from '@sim/assist'
import { makeInput } from '@sim/input'
import { recoverFloor } from '@sim/ai/fighter'
import { World } from '@sim/world'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import { climbAngleOf } from '@sim/ai/steering'

/**
 * 操作補助。
 *
 * **飛行モデルには触らない。**`InputState` を作り替えるだけなので、`Aircraft`
 * を組まずに検査できる。AI が `InputState` を作るのと同じ位置づけ。
 */

/** 高いところを水平に飛んでいる状態 */
function view(partial: Partial<AssistView> = {}): AssistView {
  return { bank: 0, agl: 3000, speed: 250, climbAngle: 0, ...partial }
}

describe('操作の型', () => {
  it('名前を判別する', () => {
    expect(isControlMode('expert')).toBe(true)
    expect(isControlMode('standard')).toBe(true)
    expect(isControlMode('arcade')).toBe(false)
    expect(isControlMode('')).toBe(false)
  })
})

describe('エキスパート', () => {
  /**
   * **素通しであることがいちばん大事。**ここが崩れると既存の操作感が
   * 変わる。Phase 6.5 までの手ごたえは全部この挙動で測ってある。
   */
  it('入力を 1 つも変えない', () => {
    const input = makeInput({ pitch: 0.5, roll: -0.8, yaw: 0.2, throttle: 0.7 })
    const out = applyAssist(input, 'expert', view())
    expect(out.pitch).toBe(0.5)
    expect(out.roll).toBe(-0.8)
    expect(out.yaw).toBe(0.2)
    expect(out.throttle).toBe(0.7)
  })

  it('地面が近くても変えない', () => {
    const input = makeInput({ pitch: -1, roll: 0 })
    const out = applyAssist(input, 'expert', view({ agl: 50, bank: 1.4 }))
    expect(out.pitch).toBe(-1)
    expect(out.roll).toBe(0)
  })
})

describe('スタンダード', () => {
  describe('ロールの抑制', () => {
    it('指令に係数を掛ける', () => {
      const out = applyAssist(makeInput({ roll: 1 }), 'standard', view())
      expect(out.roll).toBeGreaterThan(0)
      expect(out.roll).toBeLessThan(1)
    })

    it('向きは変えない', () => {
      const out = applyAssist(makeInput({ roll: -1 }), 'standard', view())
      expect(out.roll).toBeLessThan(0)
    })
  })

  describe('自動水平化', () => {
    it('入力が無ければバンクを戻す指令が出る', () => {
      // 右へ 30 度傾いている。戻すので指令は負（左ロール）
      const out = applyAssist(makeInput({ roll: 0 }), 'standard', view({ bank: 0.52 }))
      expect(out.roll).toBeLessThan(0)
    })

    it('左へ傾いていれば右へ戻す', () => {
      const out = applyAssist(makeInput({ roll: 0 }), 'standard', view({ bank: -0.52 }))
      expect(out.roll).toBeGreaterThan(0)
    })

    /**
     * **入力中は効かせない。**意図した旋回を押し戻すと戦えない。
     */
    it('ロール入力があるときは働かない', () => {
      const banked = view({ bank: 1.0 })
      const out = applyAssist(makeInput({ roll: 1 }), 'standard', banked)
      // 押している向き（右）のまま。水平化なら負になるはず
      expect(out.roll).toBeGreaterThan(0)
    })

    it('ほぼ水平なら放っておく', () => {
      const out = applyAssist(makeInput({ roll: 0 }), 'standard', view({ bank: 0.01 }))
      expect(out.roll).toBe(0)
    })

    it('指令は ±1 に収まる', () => {
      // 背面（180 度）でも指令が飽和しない
      const out = applyAssist(makeInput({ roll: 0 }), 'standard', view({ bank: Math.PI }))
      expect(out.roll).toBeGreaterThanOrEqual(-1)
      expect(out.roll).toBeLessThanOrEqual(1)
    })
  })

  describe('地面の回避', () => {
    /** `recoverFloor` は AI と同じものを使う。式を書き写さない */
    it('AI の立て直し高度より早く効く', () => {
      const floor = recoverFloor(250, 0, 0)
      // 立て直し高度のちょうど上では、まだ余裕の内側なので効く
      const out = applyAssist(
        makeInput({ pitch: -1, roll: 0 }),
        'standard',
        view({ agl: floor * 1.1 }),
      )
      expect(out.pitch).toBe(1)
    })

    it('十分高ければ働かない', () => {
      const out = applyAssist(
        makeInput({ pitch: -1 }),
        'standard',
        view({ agl: 5000 }),
      )
      expect(out.pitch).toBe(-1)
    })

    /**
     * **水平へ戻すのが先。**傾いたまま引くと揚力が横を向いて旋回になり、
     * 降下が止まらない。実測で、バンク 82 度のまま `pitch: 1` を入れて
     * 降下率 −172 m/s のまま海面へ突っ込んだ。
     */
    it('深く傾いていたら強く引かない', () => {
      const out = applyAssist(
        makeInput({ pitch: 0, roll: 0 }),
        'standard',
        view({ agl: 100, bank: 1.4 }),
      )
      expect(out.pitch).toBeLessThan(1)
      // 水平へ戻す指令は出ている
      expect(out.roll).toBeLessThan(0)
    })

    it('水平に近ければ目一杯引く', () => {
      const out = applyAssist(
        makeInput({ pitch: 0, roll: 0 }),
        'standard',
        view({ agl: 100, bank: 0.1 }),
      )
      expect(out.pitch).toBe(1)
    })

    it('機首下げの入力より優先する', () => {
      const out = applyAssist(
        makeInput({ pitch: -1, roll: 0 }),
        'standard',
        view({ agl: 100, bank: 0 }),
      )
      expect(out.pitch).toBe(1)
    })

    /** 速いほど、降下が急なほど早く効き始める（`recoverFloor` の性質） */
    it('速度と降下角で閾値が動く', () => {
      const slow = recoverFloor(250, 0, 0)
      const fast = recoverFloor(400, -0.8, 0)
      expect(fast).toBeGreaterThan(slow)
    })
  })

  it('スロットルとヨーには触らない', () => {
    const out = applyAssist(
      makeInput({ throttle: 0.3, yaw: 0.6 }),
      'standard',
      view({ agl: 50, bank: 1.0 }),
    )
    expect(out.throttle).toBe(0.3)
    expect(out.yaw).toBe(0.6)
  })
})

/**
 * 実際に飛ばして比べる。
 *
 * **入力なしで放置する。**操縦しないとどうなるかが補助の値打ち。
 */
function fly(
  mode: ControlMode,
  seconds: number,
  setup: { altitude: number; diveDeg: number; speed: number; rollSeconds?: number },
) {
  const rad = (setup.diveDeg * Math.PI) / 180
  const trim = trimCondition(setup.speed, airDensity(setup.altitude))
  const world = new World({
    seed: 20260830,
    aircraft: {
      position: new Vec3(0, setup.altitude, 0),
      velocity: new Vec3(
        0,
        -setup.speed * Math.sin(rad),
        -setup.speed * Math.cos(rad),
      ),
      throttle: trim.throttle,
    },
  })
  const player = world.player
  let minAgl = Infinity
  const steps = Math.round(seconds / FIXED_DT)
  const rollSteps = Math.round((setup.rollSeconds ?? 0) / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    if (player.crashed) break
    const input = applyAssist(
      makeInput({ roll: i < rollSteps ? 1 : 0, throttle: 0.6 }),
      mode,
      {
        bank: player.bank,
        agl: player.agl,
        speed: player.speed,
        climbAngle: climbAngleOf(player.velocity),
      },
    )
    world.step(input)
    if (!player.crashed) minAgl = Math.min(minAgl, player.agl)
  }
  return {
    crashed: player.crashed,
    minAgl: minAgl === Infinity ? 0 : minAgl,
    bankDeg: (player.bank * 180) / Math.PI,
    altitude: player.position.y,
  }
}

describe('飛ばして比べる（実測）', () => {
  /**
   * **自動水平化がいちばん効く。**1 秒ロールを入れて放置すると、
   * エキスパートは背面近くまで転がって沈む。
   *
   * | | バンク | 高度 |
   * | expert | −133° | 2,047 m |
   * | standard | −1° | 2,666 m |
   */
  it('ロール後に放置すると水平へ戻る', () => {
    const setup = { altitude: 3000, diveDeg: 0, speed: 250, rollSeconds: 1 }
    const expert = fly('expert', 20, setup)
    const standard = fly('standard', 20, setup)

    expect(Math.abs(standard.bankDeg)).toBeLessThan(10)
    expect(Math.abs(expert.bankDeg)).toBeGreaterThan(90)
    // 傾いたままだと揚力が横を向くので沈む
    expect(standard.altitude).toBeGreaterThan(expert.altitude + 300)
  })

  /**
   * **地面の回避も効く。**高度 1,500 m から 45 度・300 m/s で降りると、
   * エキスパートは墜落し、スタンダードは最低 79 m で生還する。
   */
  it('急降下から放置しても助かる', () => {
    const setup = { altitude: 1500, diveDeg: 45, speed: 300 }
    expect(fly('expert', 30, setup).crashed).toBe(true)
    expect(fly('standard', 30, setup).crashed).toBe(false)
  })

  /**
   * **限界はある。**立て直しに要る高度を初期高度が下回っていれば、
   * 入った時点で助からない。高度 1,200 m から 60 度・350 m/s は
   * `recoverFloor` が 2,153 m を要求する。
   */
  it('入った時点で助からない条件では落ちる', () => {
    const setup = { altitude: 1200, diveDeg: 60, speed: 350 }
    expect(recoverFloor(350, -(60 * Math.PI) / 180, 0)).toBeGreaterThan(setup.altitude)
    expect(fly('standard', 30, setup).crashed).toBe(true)
  })
})

/**
 * 真横の敵を追う。**旋回が要る構図。**
 *
 * 自動水平化が旋回を押し戻せば戦えない。**そこを測る。**
 */
function chase(mode: ControlMode, seconds: number) {
  const altitude = 3000
  const trim = trimCondition(250, airDensity(altitude))
  const world = new World({
    seed: 20260830,
    aircraft: {
      position: new Vec3(0, altitude, 0),
      velocity: new Vec3(0, 0, -250),
      throttle: trim.throttle,
    },
    // 真横 2,000 m。追うには 90 度の旋回が要る
    enemies: [{ offset: new Vec3(2000, 0, 0), speed: 250, missiles: 0 }],
  })
  const player = world.player
  const enemy = world.enemies[0]!
  const steps = Math.round(seconds / FIXED_DT)
  let maxBank = 0
  let bestAngle = Math.PI
  const los = new Vec3()
  const body = new Vec3()
  for (let i = 0; i < steps; i++) {
    if (player.crashed) break
    los.subVectors(enemy.position, player.position)
    const range = los.length()
    los.multiplyScalar(1 / Math.max(range, 1e-9))
    player.orientation.rotateInverse(los, body)
    // 機軸と視線の角度。小さいほど機首に乗っている
    bestAngle = Math.min(bestAngle, Math.acos(Math.max(-1, Math.min(1, -body.z))))
    const raw = makeInput({
      roll: Math.max(-1, Math.min(1, Math.atan2(body.x, body.y) * 0.8)),
      pitch: Math.max(-0.3, Math.min(1, body.y * 2)),
      throttle: 1,
    })
    world.step(
      applyAssist(raw, mode, {
        bank: player.bank,
        agl: player.agl,
        speed: player.speed,
        climbAngle: climbAngleOf(player.velocity),
      }),
    )
    maxBank = Math.max(maxBank, Math.abs(player.bank))
  }
  return {
    maxBankDeg: (maxBank * 180) / Math.PI,
    bestAngleDeg: (bestAngle * 180) / Math.PI,
    crashed: player.crashed,
  }
}

describe('補助は旋回を妨げない', () => {
  /**
   * **自動水平化が旋回を押し戻せば戦えない。**測ったら妨げていなかった。
   *
   * | | 最大バンク | 機軸との最小角 | 結果 |
   * | expert | 180° | 10.2° | 墜落 |
   * | standard | 180° | 1.0° | 生存 |
   *
   * どちらも 180 度まで傾く。**入力があるときは水平化が働かない**ので、
   * 意図した旋回はそのまま通る。スタンダードのほうが狙いが精確なのは、
   * 地面の回避が効いて姿勢を保つため。
   */
  it('真横の敵を追える。入力中は水平化が邪魔しない', () => {
    const expert = chase('expert', 60)
    const standard = chase('standard', 60)

    // どちらも深く傾ける。補助が旋回を止めていない
    expect(expert.maxBankDeg).toBeGreaterThan(90)
    expect(standard.maxBankDeg).toBeGreaterThan(90)

    // 補助があるほうが機首に乗せられる
    expect(standard.bestAngleDeg).toBeLessThan(expert.bestAngleDeg)
    expect(standard.crashed).toBe(false)
  })
})

/**
 * Stryker が見つけた穴（Phase 8 段 4）。
 *
 * 3 ファイルに 240 の変異を注入したところ 37 件が生き残った。うち
 * `assist.ts` の 5 件は、**符号と向きしか見ていない**ことを突いていた。
 * 掛け算を割り算に変えても、境界を `<` から `<=` に変えても落ちなかった。
 */
describe('補助の大きさと境界', () => {
  it('自動水平化のゲインの大きさが効く', () => {
    const input = makeInput({ roll: 0 })
    applyAssist(input, 'standard', view({ bank: 0.5 }))
    // clamp(-0.5 * 1.2, -1, 1) = -0.6。**割り算に変えると -0.4167 になるが、
    // 符号も向きも変わらないので、大きさを見ないと気づけない**
    expect(input.roll).toBeCloseTo(-0.6, 9)
  })

  it('地面の回避でも同じゲインで水平へ戻す', () => {
    const input = makeInput({ roll: 0 })
    applyAssist(input, 'standard', view({ bank: 0.5, agl: 1 }))
    expect(input.roll).toBeCloseTo(-0.6, 9)
  })

  it('引く強さの境界はバンク 0.5 rad ちょうどで弱いほう', () => {
    const input = makeInput({ roll: 0 })
    applyAssist(input, 'standard', view({ bank: 0.5, agl: 1 }))
    // `Math.abs(bank) < 0.5` なので 0.5 ちょうどは「深く傾いている」側。
    // **`<=` に変えると 1 になる**
    expect(input.pitch).toBeCloseTo(0.2, 9)
  })

  it('境界のすぐ内側では目一杯引く', () => {
    const input = makeInput({ roll: 0 })
    applyAssist(input, 'standard', view({ bank: 0.4999, agl: 1 }))
    expect(input.pitch).toBeCloseTo(1, 9)
  })
})
