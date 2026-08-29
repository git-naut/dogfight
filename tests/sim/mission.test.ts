import { describe, expect, it } from 'vitest'
import { Vec3 } from '@sim/vec3'
import { FIXED_DT } from '@sim/loop'
import { World } from '@sim/world'
import { makeInput, type InputState } from '@sim/input'
import { trimCondition } from '@sim/flightModel'
import { airDensity } from '@sim/isa'
import { getScript } from '@sim/scripts'
import { createWorldFromScript } from '@sim/world'

/**
 * ミッション 01（敵 5 機）の下地。
 *
 * **測定用の自動操縦は「人間の下限の腕」として成立しなかった。**8 機戦を
 * 300 秒回して撃墜 0、機銃 62 発で命中 0、45 秒で海面へ突っ込む。敵の
 * ミサイルを全部外しても同じ。**弾薬が足りるかを測る前に自滅する。**
 *
 * `dogfight.test.ts` の `autoPilot` も同じ性質で、あちらのコメントにも
 * 「自機は 2 条件で墜落した。自動操縦が地形を見ていないため」と残っている。
 * **どちらも敵の検証のための道具で、自機の腕を測る道具ではない。**
 *
 * したがって弾薬とミサイルの数は 1 対 1 の実測からの外挿で置き、実機で
 * 人が遊んで直す（`docs/decisions/0009-mission.md`）。ここに残すのは、
 * 8 機戦がクラッシュせず完走することと、途中で見つけた 3 つの落とし穴。
 */

/**
 * ミッションを相手にする自動操縦。
 *
 * **勝てる操縦ではない。**最後まで走ることを確かめるための器で、
 * 腕の目安には使えない（上の注記）。`autoPilot` とは別に書いてある。同じ
 * 実装を使い回すと、あちらの「敵が落ちない」検証とこちらの計測が同じ癖を
 * 共有してしまう。**AI とも別物にする**という既存の方針も同じ。
 */
function missionPilot(world: World, frame: number): InputState {
  const player = world.player
  const threat = world.combat.threat

  // 最も近い生存敵。落ちた敵を追い続けないため毎ステップ選び直す
  let target: { position: Vec3 } | null = null
  let best = Infinity
  for (const enemy of world.enemies) {
    if (!enemy.alive) continue
    const d = new Vec3().subVectors(enemy.position, player.position).length()
    if (d < best) {
      best = d
      target = enemy
    }
  }
  if (target === null) return makeInput({ throttle: 1 })

  const los = new Vec3().subVectors(target.position, player.position)
  const range = los.length()
  los.multiplyScalar(1 / Math.max(range, 1e-9))
  const body = new Vec3()
  player.orientation.rotateInverse(los, body)

  const lowAltitude = player.agl < 600

  // **引き起こす前に水平へ戻す。**`roll: 0` は「ロール指令なし」であって
  // バンクは戻らない。実測で、バンク 82 度のまま `pitch: 1` を入れて
  // 降下率 −172 m/s が止まらず海面へ突っ込んだ（agl 599 m から 3.8 秒）。
  // 傾いた機体では揚力が水平を向くので、引いても高度にならない
  const levelRoll = Math.max(-1, Math.min(1, -player.bank * 1.5))

  // **距離で判断する。**`timeToImpact` は閾値の判定に使えない。発射直後は
  // ミサイルが加速中で接近速度が小さく、実測で 3,299 m のときに 164.1 秒と
  // 出た（実際は 6 秒後に着弾）。`range / closing` は式としては正しく、
  // HUD の表示なら時間とともに縮んで合っていく
  const evading = threat.active && threat.range < 2500

  // **押しっぱなしでは 1 連射しか出ない**（`FLARE_INTERVAL` 0.5 秒）。
  // 8 機戦では同時に 4 発飛んでくるので、1 連射 3 発では足りない
  const flarePulse = evading && frame % 60 < 30

  const aimed = body.z < -0.99
  return makeInput({
    roll: lowAltitude ? levelRoll : Math.max(-1, Math.min(1, Math.atan2(body.x, body.y) * 0.8)),
    // 水平に近づいてから引く。傾いたまま引くと旋回になって沈む
    pitch: lowAltitude
      ? Math.abs(player.bank) < 0.5
        ? 1
        : 0.2
      : Math.max(-0.3, Math.min(1, body.y * 2)),
    throttle: 1,
    fireGun: !lowAltitude && range < 800 && aimed,
    fireMissile:
      !lowAltitude && world.combat.lock.state === 'locked' && range > 1200 && range < 8000,
    deployFlare: flarePulse,
  })
}

/** `mission-01` の構図で回す */
function mission(seconds: number): World {
  const script = getScript('mission-01')
  const altitude = script.spawn.altitude
  const trim = trimCondition(script.spawn.speed, airDensity(altitude))
  const world = new World({
    seed: script.seed,
    aircraft: {
      position: new Vec3(0, altitude, 0),
      velocity: new Vec3(0, 0, -script.spawn.speed),
      throttle: trim.throttle,
    },
    enemies: script.enemies ?? [],
  })

  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) world.step(missionPilot(world, i))
  return world
}

describe('ミッション 01 の下地', () => {
  it('300 秒回しても壊れない', () => {
    const world = mission(300)

    // 器が持つこと。**撃墜数は主張しない**（自動操縦が勝てないため）
    expect(world.enemiesAlive).toBeGreaterThanOrEqual(0)
    expect(world.enemiesAlive).toBeLessThanOrEqual(5)
    expect(world.frame).toBe(Math.round(300 / FIXED_DT))
    expect(Number.isFinite(world.player.position.y)).toBe(true)
  })

  it('敵 5 機が器の上限の内側', () => {
    // `MAX_TARGETS` が 8 で、描画側の器（敵機ビュー・ダメージ煙・フレア）が
    // それを基準に確保されている。台本がそれを超えると描画側が足りない
    const script = getScript('mission-01')
    expect(script.enemies).toHaveLength(5)
  })

  it('台本の制限時間が World へ届く', () => {
    // **秒からフレームへ直る経路を見る。**`missionSeconds` は人が読む秒で
    // 書き、判定側はフレームで持つ（浮動小数の境界が揺れるため）
    const script = getScript('mission-01')
    expect(script.missionSeconds).toBe(300)

    const { world } = createWorldFromScript(script)
    expect(world.mission).not.toBeNull()
    expect(world.mission!.spec.limitFrames).toBe(Math.round(300 / FIXED_DT))
    expect(world.mission!.outcome).toBe('running')
  })

  it('**基準画像の台本にはミッションを付けない。**制限時間で絵が変わる', () => {
    // 台本が制限時間で打ち切られると、長いフレームを撮る基準画像が壊れる
    for (const name of ['level', 'gun-pass', 'enemy-eight', 'island-run']) {
      const { world } = createWorldFromScript(getScript(name))
      expect(world.mission, name).toBeNull()
    }
  })

  it('ミッションは World を進めると判定される', () => {
    // 配線の検査。`step()` の末尾で `update` が呼ばれていなければ
    // いつまでも running のまま
    const script = getScript('mission-01')
    const { world, player } = createWorldFromScript(script)
    const limit = world.mission!.spec.limitFrames
    for (let i = 0; i < limit + 10; i++) world.step(player.at(i))
    // 300 秒のあいだに決着しているはず（時間切れか、その前の失敗か）
    expect(world.mission!.outcome).not.toBe('running')
    expect(world.mission!.endedFrame).toBeGreaterThan(0)
  })

  it('ミサイルを持つのは 2 機だけ', () => {
    // **8 機全部が持つ構図では成立しなかった。**開始 15 秒に 4 発が同時に
    // 飛来し、フレア 1 連射 3 発では捌けずに 27.9 秒で落ちた
    const script = getScript('mission-01')
    const armed = (script.enemies ?? []).filter((e) => e.missiles !== 0)
    expect(armed).toHaveLength(2)
  })
})
