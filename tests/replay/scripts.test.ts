import { describe, it, expect } from 'vitest'
import { runScript, createWorldFromScript } from '@sim/world'
import { SCRIPTS, SCRIPT_NAMES, getScript, isScriptName } from '@sim/scripts'
import { spawnFromSpec, ReplayPlayer } from '@sim/replay'
import { airDensity } from '@sim/isa'
import { trimCondition } from '@sim/flightModel'

/**
 * 入力スクリプトによるリグレッション検証。
 *
 * 飛行モデルの係数をいじると、単体テストは通るのに手触りが壊れることがある。
 * 「この入力列でこう飛ぶ」を数値で固定しておけば、その退行を検出できる。
 */

const DEG = Math.PI / 180
const SEC = 120

describe('初期条件の展開', () => {
  it('トリムが解けていて開始直後に沈まない', () => {
    const spawn = spawnFromSpec({ altitude: 2000, speed: 250 })
    const { alpha, throttle } = trimCondition(250, airDensity(2000))

    expect(spawn.position.y).toBe(2000)
    expect(spawn.velocity.length()).toBeCloseTo(250, 9)
    expect(spawn.throttle).toBeCloseTo(throttle, 12)
    // 機首は迎角ぶん上を向いている
    expect(spawn.orientation.forward().y).toBeCloseTo(Math.sin(alpha), 9)
  })

  it('上昇角を指定すると速度ベクトルが傾く', () => {
    const spawn = spawnFromSpec({ altitude: 1000, speed: 200, climbAngle: 20 * DEG })
    expect(spawn.velocity.y).toBeCloseTo(200 * Math.sin(20 * DEG), 9)
    expect(spawn.velocity.length()).toBeCloseTo(200, 9)
  })

  it('バンクを指定すると機体が傾く', () => {
    const spawn = spawnFromSpec({ altitude: 1000, speed: 250, bank: 45 * DEG })
    // 右バンクなので機体右方向が下を向く
    expect(spawn.orientation.right().y).toBeLessThan(-0.6)
  })
})

describe('キーフレームの畳み込み', () => {
  it('指定のないキーは直前の値を引き継ぐ', () => {
    const player = new ReplayPlayer({
      name: 'test',
      seed: 1,
      spawn: { altitude: 1000, speed: 200 },
      keyframes: [
        { frame: 0, input: { pitch: 0.5 } },
        { frame: 10, input: { roll: -1 } },
      ],
    })

    expect(player.at(0).pitch).toBe(0.5)
    expect(player.at(5).roll).toBe(0)
    const at10 = player.at(10)
    expect(at10.roll).toBe(-1)
    expect(at10.pitch).toBe(0.5) // 引き継がれている
  })

  it('初期スロットルがトリム値になっている', () => {
    const spec = { altitude: 3000, speed: 280 }
    const player = new ReplayPlayer({ name: 't', seed: 1, spawn: spec, keyframes: [] })
    const expected = trimCondition(280, airDensity(3000)).throttle
    expect(player.at(0).throttle).toBeCloseTo(expected, 12)
  })
})

describe('スクリプトの登録', () => {
  it('27 本すべて引ける', () => {
    expect(SCRIPT_NAMES).toEqual([
      'level',
      'bank-left',
      'pull-up',
      'low-pass',
      'island-run',
      'zoom-climb',
      'turn-in',
      'target-ahead',
      'target-turn',
      'gun-pass',
      'missile-shot',
      'missile-miss',
      'missile-near',
      'head-on',
      'weapons-load',
      'enemy-ahead',
      'enemy-formation',
      'enemy-head-on',
      'enemy-pursue',
      'enemy-recover',
      'enemy-attack',
      'enemy-missile',
      'enemy-evade',
      'dogfight-1v1',
      'damage-smoke',
      'damage-smoke-near',
      'enemy-eight',
    ])
    for (const name of SCRIPT_NAMES) {
      expect(getScript(name).name).toBe(name)
    }
  })

  it('敵つきの台本だけが敵を持つ', () => {
    const withEnemies = SCRIPT_NAMES.filter((n) => getScript(n).enemies !== undefined)
    expect(withEnemies).toEqual([
      'enemy-ahead',
      'enemy-formation',
      'enemy-head-on',
      'enemy-pursue',
      'enemy-recover',
      'enemy-attack',
      'enemy-missile',
      'enemy-evade',
      'dogfight-1v1',
      'damage-smoke',
      'damage-smoke-near',
      'enemy-eight',
    ])
  })

  it('標的つきの台本だけが標的を持つ', () => {
    // SCRIPTS は as const なので、targets を持たない要素との union では
    // プロパティを引けない。ReplayScript として読む getScript を通す
    const withTargets = SCRIPT_NAMES.filter((n) => getScript(n).targets !== undefined)
    expect(withTargets).toEqual([
      'target-ahead',
      'target-turn',
      'gun-pass',
      'missile-shot',
      'missile-miss',
      'missile-near',
      'head-on',
      'weapons-load',
    ])
  })

  it('未知の名前は level に倒れる', () => {
    expect(isScriptName('nope')).toBe(false)
    expect(getScript('nope').name).toBe('level')
  })
})

describe('level — 水平飛行の基準線', () => {
  it('10 秒間 高度と速度を保つ', () => {
    const world = runScript(SCRIPTS.level, SEC * 10)
    const p = world.player

    expect(p.crashed).toBe(false)
    expect(Math.abs(p.altitude - 2000)).toBeLessThan(50)
    expect(Math.abs(p.speed - 250)).toBeLessThan(10)
    expect(Math.abs(p.bank)).toBeLessThan(1 * DEG)
    expect(Math.abs(p.sideslip)).toBeLessThan(1 * DEG)
    expect(p.loadFactor).toBeCloseTo(1, 1)
  })

  it('60 秒でも高度が 200 m 以上ずれない', () => {
    const world = runScript(SCRIPTS.level, SEC * 60)
    expect(Math.abs(world.player.altitude - 2000)).toBeLessThan(200)
  })

  it('まっすぐ飛ぶ（横方向に流れない）', () => {
    const world = runScript(SCRIPTS.level, SEC * 20)
    // 20 秒で 5 km 進むうち、横ずれは 10 m 未満
    expect(Math.abs(world.player.position.x)).toBeLessThan(10)
    expect(-world.player.position.z).toBeGreaterThan(4500)
  })
})

describe('bank-left — 左旋回', () => {
  it('左にバンクして左へ回る', () => {
    const world = runScript(SCRIPTS['bank-left'], SEC * 6)
    const p = world.player

    expect(p.crashed).toBe(false)
    expect(p.bank).toBeLessThan(-30 * DEG)
    // 左旋回なので x は負側へ膨らむ
    expect(p.position.x).toBeLessThan(-100)
    expect(Math.abs(p.sideslip)).toBeLessThan(6 * DEG)
  })

  it('旋回で速度が落ちる', () => {
    const world = runScript(SCRIPTS['bank-left'], SEC * 6)
    expect(world.player.speed).toBeLessThan(260)
  })
})

describe('pull-up — 上昇', () => {
  it('高度が上がり機首が上を向く', () => {
    const world = runScript(SCRIPTS['pull-up'], SEC * 4)
    const p = world.player
    expect(p.altitude).toBeGreaterThan(1200)
    expect(p.orientation.forward().y).toBeGreaterThan(0.3)
    expect(p.crashed).toBe(false)
  })
})

describe('low-pass — 低空通過', () => {
  it('地面すれすれを保ったまま加速する', () => {
    const world = runScript(SCRIPTS['low-pass'], SEC * 5)
    const p = world.player
    expect(p.crashed).toBe(false)
    expect(p.altitude).toBeGreaterThan(100)
    expect(p.altitude).toBeLessThan(400)
    expect(p.speed).toBeGreaterThan(320)
  })
})

describe('target-ahead — 標的が前方を直進する', () => {
  it('標的が 1 機いて、自機の前方やや右上に湧く', () => {
    const world = runScript(SCRIPTS['target-ahead'], 1)
    expect(world.targets).toHaveLength(1)

    const t = world.targets[0]!
    // 自機は原点の高度 3000 m。offset は (35, 12, -190)
    expect(t.position.x).toBeCloseTo(35, 6)
    expect(t.position.y).toBeCloseTo(3012, 6)
    expect(t.bank).toBe(0)
  })

  it('自機のほうが速いので間合いが詰まる', () => {
    const near = runScript(SCRIPTS['target-ahead'], SEC * 1)
    const far = runScript(SCRIPTS['target-ahead'], SEC * 20)

    const gap = (w: typeof near): number =>
      w.player.position.distanceTo(w.targets[0]!.position)

    expect(gap(far)).toBeLessThan(gap(near))
    // 自機 250 m/s・標的 245 m/s。19 秒で 95 m 詰まる勘定
    expect(gap(near) - gap(far)).toBeGreaterThan(60)
  })

  it('撮る範囲では機体と分かる大きさにいる', () => {
    // 追従カメラの垂直画角は速度 250 m/s で 66.4 度。翼幅 11.6 m は 900 m で
    // 実測 10 x 7 画素にしかならず、絵でまったく判別できなかった。190 m まで
    // 寄せて 28 x 10 画素。**この距離は絵で測って決めた値**なので、
    // 台本をいじるときは `extent.mjs` で撮り直して確かめる
    for (const sec of [0, 5, 10]) {
      const w = runScript(SCRIPTS['target-ahead'], SEC * sec)
      const gap = w.player.position.distanceTo(w.targets[0]!.position)
      expect(gap, `${sec} 秒`).toBeGreaterThan(130)
      expect(gap, `${sec} 秒`).toBeLessThan(220)
    }
  })

  it('標的が高度を保つ', () => {
    const world = runScript(SCRIPTS['target-ahead'], SEC * 20)
    expect(world.targets[0]!.position.y).toBeCloseTo(3012, 6)
  })

  it('60 秒飛んでも自機が地形に当たらない', () => {
    // 地図の最高点は実測 2,224.5 m @ (800, -12600) で、この回廊上にある。
    // 高度 2,000 m だとここで止まる。**止まったあとの高度は地形の高さに
    // なるので、高度だけを見る検査では気づけない。**速度で見る
    const world = runScript(SCRIPTS['target-ahead'], SEC * 60)
    expect(world.player.crashed).toBe(false)
    expect(world.player.speed).toBeGreaterThan(200)
  })
})

describe('target-turn — 標的が定常旋回する', () => {
  it('右へバンクして右へ回る', () => {
    const world = runScript(SCRIPTS['target-turn'], SEC * 10)
    const t = world.targets[0]!

    // 55.8 度。絵では 220 m で 19 x 27 画素になり、倒れているのが読める
    expect(t.bank).toBeGreaterThan(50 * DEG)
    // 右は +X。半径 4,000 m を 0.6 rad 回ると 700 m 右へ膨らむ
    expect(t.position.x).toBeGreaterThan(500)
  })

  it('視線の回転率が 0 でない。比例航法を検証できる構図', () => {
    // 自機から見た標的の方位が動いていることを、2 時点の視線の角度差で見る
    const angleAt = (frames: number): number => {
      const w = runScript(SCRIPTS['target-turn'], frames)
      const los = w.targets[0]!.position.clone().sub(w.player.position).normalize()
      return Math.atan2(los.x, -los.z)
    }
    const drift = Math.abs(angleAt(SEC * 8) - angleAt(SEC * 2))
    // 直進する的なら 1 度も動かない。旋回していれば大きく振れる
    expect(drift).toBeGreaterThan(10 * DEG)
  })
})

describe('再生の決定論', () => {
  it.each(SCRIPT_NAMES)('%s は 2 回再生しても同じ結果になる', (name) => {
    const a = runScript(SCRIPTS[name], SEC * 5)
    const b = runScript(SCRIPTS[name], SEC * 5)

    expect(a.frame).toBe(b.frame)
    expect(a.player.position.toArray()).toEqual(b.player.position.toArray())
    expect(a.player.velocity.toArray()).toEqual(b.player.velocity.toArray())
    expect(a.player.orientation.toArray()).toEqual(b.player.orientation.toArray())

    expect(a.targets).toHaveLength(b.targets.length)
    for (let i = 0; i < a.targets.length; i++) {
      expect(a.targets[i]!.position.toArray()).toEqual(b.targets[i]!.position.toArray())
      expect(a.targets[i]!.orientation.toArray()).toEqual(
        b.targets[i]!.orientation.toArray(),
      )
    }
  })

  it('途中経過も一致する（部分再生と通し再生が同じ）', () => {
    const full = runScript(SCRIPTS['bank-left'], SEC * 3)

    const { world, player } = createWorldFromScript(SCRIPTS['bank-left'])
    for (let i = 0; i < SEC * 3; i++) world.step(player.at(i))

    expect(world.player.position.toArray()).toEqual(full.player.position.toArray())
  })
})

describe('island-run — 島を越える', () => {
  it('海上から主峰の稜線を越え、45 秒間墜落しない', () => {
    // F/A-18C は F-16 級より加速が鈍いので、島を抜けるまで 42 秒かかる
    const world = runScript(SCRIPTS['island-run'], SEC * 45)
    const p = world.player

    expect(p.crashed).toBe(false)
    // 主峰の稜線（約 1,500 m）より上にいる
    expect(p.position.y).toBeGreaterThan(1_500)
    // 島を越えて向こう側の海に出ている
    expect(p.groundHeight).toBe(0)
  })

  it('稜線の上で対地高度が海抜より小さくなる', () => {
    const world = runScript(SCRIPTS['island-run'], SEC * 30)
    const p = world.player

    expect(p.groundHeight).toBeGreaterThan(1_000)
    expect(p.agl).toBeLessThan(p.altitude - 1_000)
    // 地面には当たらない
    expect(p.agl).toBeGreaterThan(300)
  })
})
