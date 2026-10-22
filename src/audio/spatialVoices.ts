/**
 * 立体の音（Phase 10 の段 B11d、ADR 0040）。敵機のエンジン音・通過音・爆発・敵のミサイルの発射を、
 * 自機から見た向きと距離に置く（Web Audio の PannerNode）。
 *
 * 聞き手は原点・既定の向き（前 −Z、上 +Y）のまま動かさず、音源の位置を自機の座標へ直して置く
 * （`spatial.ts` の `toListenerLocal`）。
 *
 * - 敵機のエンジン音: 1.5 km 以内の近い 2 機に、取り込んだタービンのループを置き、ドップラーを掛ける
 *   （ユーザーの決定）。範囲から外れたら下げる
 * - 通過音: すれ違いの数（sim の `World.flybyCount`）が増えたら、その敵機の位置に置く。録音に
 *   ドップラーが入っているので、向きと距離だけ。すれ違いを判定できるのは最も近づいた直後なので、
 *   録音の山（6.8 秒の少しあと）から鳴らす
 * - 爆発と敵のミサイルの発射: 起きた位置に置いて 1 回鳴らす
 */
import { dopplerRate, toListenerLocal, type QuatLike, type Vec3Like } from './spatial'

/** 音の層が読む自機。sim の `Aircraft` がそのまま当てはまる */
export interface AudioListener {
  readonly position: Vec3Like
  readonly velocity: Vec3Like
  readonly orientation: QuatLike
}

/** 音の層が読む敵機。sim の `Enemy` がそのまま当てはまる */
export interface AudioEnemy {
  readonly aircraft: { readonly position: Vec3Like; readonly velocity: Vec3Like }
  readonly alive: boolean
  readonly missilesFired: number
}

/** 音の層が読む爆発。sim の `ExplosionSource` がそのまま当てはまる */
export interface AudioExplosions {
  explosionAt(index: number): { readonly position: Vec3Like }
}

/** 敵機のエンジン音を置く距離 m と数（推測） */
export const ENEMY_ENGINE_RANGE = 1500
export const ENEMY_ENGINE_VOICES = 2
const ENEMY_ENGINE_GAIN = 0.6
/** 通過音を鳴らし始める録音の位置 秒。録音の山は 7.5 秒（ADR 0037 の区間の 15 秒からの 22.5 秒） */
export const FLYBY_OFFSET = 6.8
const FLYBY_GAIN = 0.9
/** 距離の減り方。100 m で 1、それより遠いと距離に反比例して小さくなる */
const REF_DISTANCE = 100
const ROLLOFF = 1.2
/** 追従の時定数 秒 */
const FOLLOW = 0.05

export interface SpatialSamples {
  readonly turbine: AudioBuffer
  readonly flyby: AudioBuffer
}

export interface SpatialVoices {
  /** 毎フレーム呼ぶ。新しく鳴らす爆発の数と、すれ違いと敵のミサイルの数を渡す */
  update(input: {
    listener: AudioListener
    enemies: readonly AudioEnemy[]
    explosions: AudioExplosions | null
    newExplosions: number
    flybyCount: number
    lastFlybyEnemy: number
  }): void
  /** 立体の位置に置いた出口を作る。爆発や発射の音をここへつなぐ */
  placeAt(world: Vec3Like, listener: AudioListener): PannerNode
  /** 鳴らしている敵機のエンジン音の数（検査用） */
  readonly enemyEnginesPlaying: number
  /** 実録音を読めたら渡す。読めるまで敵機のエンジン音と通過音は鳴らさない */
  setSamples(samples: SpatialSamples): void
  dispose(): void
}

const rel = { x: 0, y: 0, z: 0 }
const relVel = { x: 0, y: 0, z: 0 }
const local = { x: 0, y: 0, z: 0 }

export function createSpatialVoices(
  ctx: BaseAudioContext,
  destination: AudioNode,
  hooks: {
    /** 爆発を鳴らす（合成音）。`out` へつなぐ */
    playExplosion(out: AudioNode, when: number): void
    /** 敵のミサイルの発射を鳴らす。`out` へつなぐ */
    playLaunch(out: AudioNode, when: number): void
  },
): SpatialVoices {
  let samples: SpatialSamples | null = null

  function panner(): PannerNode {
    const p = ctx.createPanner()
    p.panningModel = 'equalpower'
    p.distanceModel = 'inverse'
    p.refDistance = REF_DISTANCE
    p.rolloffFactor = ROLLOFF
    p.maxDistance = 20000
    p.connect(destination)
    return p
  }

  function setLocal(p: PannerNode, world: Vec3Like, listener: AudioListener, smooth: boolean): void {
    rel.x = world.x - listener.position.x
    rel.y = world.y - listener.position.y
    rel.z = world.z - listener.position.z
    toListenerLocal(rel, listener.orientation, local)
    const now = ctx.currentTime
    if (smooth) {
      p.positionX.setTargetAtTime(local.x, now, FOLLOW)
      p.positionY.setTargetAtTime(local.y, now, FOLLOW)
      p.positionZ.setTargetAtTime(local.z, now, FOLLOW)
    } else {
      p.positionX.setValueAtTime(local.x, now)
      p.positionY.setValueAtTime(local.y, now)
      p.positionZ.setValueAtTime(local.z, now)
    }
  }

  interface EngineVoice {
    src: AudioBufferSourceNode
    gain: GainNode
    panner: PannerNode
    /** 受け持っている敵機の添字。−1 は空き */
    enemy: number
  }
  let engines: EngineVoice[] = []

  interface Flyby {
    panner: PannerNode
    enemy: number
    endAt: number
  }
  const flybys: Flyby[] = []

  let previousFlyby = -1
  let previousFired: number[] = []
  let playing = 0

  return {
    get enemyEnginesPlaying() {
      return playing
    },

    setSamples(next) {
      samples = next
      engines = Array.from({ length: ENEMY_ENGINE_VOICES }, () => {
        const src = ctx.createBufferSource()
        src.buffer = next.turbine
        src.loop = true
        const gain = ctx.createGain()
        gain.gain.value = 0
        const p = panner()
        src.connect(gain).connect(p)
        src.start()
        return { src, gain, panner: p, enemy: -1 }
      })
    },

    placeAt(world, listener) {
      const p = panner()
      setLocal(p, world, listener, false)
      return p
    },

    update({ listener, enemies, explosions, newExplosions, flybyCount, lastFlybyEnemy }) {
      const now = ctx.currentTime

      // 爆発。新しい順に置く
      if (explosions !== null) {
        for (let i = 0; i < newExplosions; i++) {
          const out = panner()
          setLocal(out, explosions.explosionAt(i).position, listener, false)
          // 同じ時刻に重ねない（位相が揃うと振幅が単純に足し合わさる）
          hooks.playExplosion(out, now + i * 0.04)
        }
      }

      // 敵のミサイルの発射。撃った敵機の位置に置く
      if (previousFired.length !== enemies.length) previousFired = enemies.map((e) => e.missilesFired)
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i]!
        if (e.missilesFired > previousFired[i]!) {
          const out = panner()
          setLocal(out, e.aircraft.position, listener, false)
          hooks.playLaunch(out, now)
        }
        previousFired[i] = e.missilesFired
      }

      // 通過音。すれ違いの数が増えたら
      if (previousFlyby < 0) previousFlyby = flybyCount
      if (flybyCount > previousFlyby && samples !== null && lastFlybyEnemy >= 0) {
        const p = panner()
        const enemy = enemies[lastFlybyEnemy]
        if (enemy !== undefined) setLocal(p, enemy.aircraft.position, listener, false)
        const src = ctx.createBufferSource()
        src.buffer = samples.flyby
        const gain = ctx.createGain()
        gain.gain.value = FLYBY_GAIN
        src.connect(gain).connect(p)
        src.start(now, FLYBY_OFFSET)
        flybys.push({ panner: p, enemy: lastFlybyEnemy, endAt: now + samples.flyby.duration - FLYBY_OFFSET })
      }
      previousFlyby = flybyCount
      for (let i = flybys.length - 1; i >= 0; i--) {
        const f = flybys[i]!
        if (now > f.endAt) {
          flybys.splice(i, 1)
          continue
        }
        const enemy = enemies[f.enemy]
        if (enemy !== undefined && enemy.alive) setLocal(f.panner, enemy.aircraft.position, listener, true)
      }

      // 敵機のエンジン音。範囲の内の近い順に、空いている声へ割り当てる
      playing = 0
      if (engines.length === 0) return
      const near: { index: number; distance: number }[] = []
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i]!
        if (!e.alive) continue
        const p = e.aircraft.position
        const d = Math.hypot(p.x - listener.position.x, p.y - listener.position.y, p.z - listener.position.z)
        if (d <= ENEMY_ENGINE_RANGE) near.push({ index: i, distance: d })
      }
      near.sort((a, b) => a.distance - b.distance)
      const chosen = new Set(near.slice(0, engines.length).map((n) => n.index))
      // 受け持ちが外れた声は下げて空ける
      for (const v of engines) {
        if (v.enemy >= 0 && !chosen.has(v.enemy)) {
          v.enemy = -1
          v.gain.gain.setTargetAtTime(0, now, 0.1)
        }
      }
      for (const index of chosen) {
        let v = engines.find((x) => x.enemy === index)
        if (v === undefined) {
          v = engines.find((x) => x.enemy < 0)
          if (v === undefined) continue
          v.enemy = index
          v.gain.gain.setTargetAtTime(ENEMY_ENGINE_GAIN, now, 0.1)
        }
        const e = enemies[index]!
        setLocal(v.panner, e.aircraft.position, listener, true)
        rel.x = e.aircraft.position.x - listener.position.x
        rel.y = e.aircraft.position.y - listener.position.y
        rel.z = e.aircraft.position.z - listener.position.z
        relVel.x = e.aircraft.velocity.x - listener.velocity.x
        relVel.y = e.aircraft.velocity.y - listener.velocity.y
        relVel.z = e.aircraft.velocity.z - listener.velocity.z
        v.src.playbackRate.setTargetAtTime(dopplerRate(rel, relVel), now, FOLLOW)
        playing++
      }
    },

    dispose() {
      for (const v of engines) {
        try {
          v.src.stop()
        } catch {
          // すでに止まっている
        }
      }
    },
  }
}
