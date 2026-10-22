/**
 * 実録音の効果音を読み込んで鳴らす（Phase 10 の段 B11b・B11c、ADR 0038・0039）。
 *
 * 音のファイルは `tools/audio-import.mjs` が `public/audio/` に書き出した Opus（ADR 0037）。
 * **読み込みに失敗しても止めない。**null を返し、呼ぶ側は合成音のまま鳴らす。音は無くても遊べる
 */
import { engineLayerGains, shouldLightBurner, turbineRate } from './engineMix'

/** エンジンの 3 層と点火の音 */
export const ENGINE_SAMPLES = ['engine-idle', 'engine-turbine', 'engine-burner', 'burner-light'] as const
export type EngineSampleName = (typeof ENGINE_SAMPLES)[number]
export type EngineSamples = Record<EngineSampleName, AudioBuffer>

/** 機銃のループと余韻、ミサイルの発射（段 B11c） */
export const WEAPON_SAMPLES = ['gun-loop', 'gun-tail', 'missile-launch'] as const
export type WeaponSampleName = (typeof WEAPON_SAMPLES)[number]
export type WeaponSamples = Record<WeaponSampleName, AudioBuffer>

/** `baseUrl`（`import.meta.env.BASE_URL`）の `audio/` から `names` を読み、デコードする。1 本でも失敗したら null */
export async function loadSamples<N extends string>(
  ctx: BaseAudioContext,
  baseUrl: string,
  names: readonly N[],
): Promise<Record<N, AudioBuffer> | null> {
  try {
    const buffers = await Promise.all(
      names.map(async (name) => {
        const response = await fetch(`${baseUrl}audio/${name}.ogg`)
        if (!response.ok) throw new Error(`${name}: ${response.status}`)
        return ctx.decodeAudioData(await response.arrayBuffer())
      }),
    )
    return Object.fromEntries(names.map((name, i) => [name, buffers[i]!])) as Record<N, AudioBuffer>
  } catch {
    return null
  }
}

/** エンジンの 4 本を読む */
export function loadEngineSamples(ctx: BaseAudioContext, baseUrl: string): Promise<EngineSamples | null> {
  return loadSamples(ctx, baseUrl, ENGINE_SAMPLES)
}

/** 武器の 3 本を読む */
export function loadWeaponSamples(ctx: BaseAudioContext, baseUrl: string): Promise<WeaponSamples | null> {
  return loadSamples(ctx, baseUrl, WEAPON_SAMPLES)
}

/** 実録音のエンジン。合成音の `EngineVoice` と同じ口に、全体の大きさを足した */
export interface RecordedEngineVoice {
  /** スロットル 0..1 を反映する。0.85 を下から越えたら点火の音を鳴らす */
  setThrottle(throttle: number): void
  /** 全体の大きさ 0..1。合成音から切り替えるときに寄せる */
  setLevel(level: number, seconds: number): void
  dispose(): void
}

/** 3 層の全体の大きさ。合成音のエンジン（0.12〜0.34）と耳で並ぶ程度にした（推測） */
const ENGINE_LEVEL = 0.9
/** 点火の音の大きさ */
const BURNER_LIGHT_GAIN = 0.5
/** 大きさと速さの追従の時定数 秒。スロットルは 2.5 秒で 0 から 1 まで動く（合成音と同じ 0.15） */
const FOLLOW = 0.15

export function createRecordedEngineVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  samples: EngineSamples,
  initialLevel = 1,
): RecordedEngineVoice {
  const bus = ctx.createGain()
  bus.gain.value = initialLevel * ENGINE_LEVEL
  bus.connect(destination)

  function loop(buffer: AudioBuffer): { src: AudioBufferSourceNode; gain: GainNode } {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(gain).connect(bus)
    src.start()
    return { src, gain }
  }
  const idle = loop(samples['engine-idle'])
  const turbine = loop(samples['engine-turbine'])
  const burner = loop(samples['engine-burner'])

  const gains = engineLayerGains(0)
  let previous = 0
  let lastLitAt = -Infinity
  let first = true

  return {
    setThrottle(throttle: number): void {
      const now = ctx.currentTime
      engineLayerGains(throttle, gains)
      if (first) {
        // 最初の 1 回は寄せずに置く。0 から寄せると鳴り始めに膨らむ
        idle.gain.gain.setValueAtTime(gains.idle, now)
        turbine.gain.gain.setValueAtTime(gains.turbine, now)
        burner.gain.gain.setValueAtTime(gains.burner, now)
        turbine.src.playbackRate.setValueAtTime(turbineRate(throttle), now)
        first = false
      } else {
        idle.gain.gain.setTargetAtTime(gains.idle, now, FOLLOW)
        turbine.gain.gain.setTargetAtTime(gains.turbine, now, FOLLOW)
        burner.gain.gain.setTargetAtTime(gains.burner, now, FOLLOW)
        turbine.src.playbackRate.setTargetAtTime(turbineRate(throttle), now, FOLLOW)
      }
      if (shouldLightBurner(previous, throttle, now, lastLitAt)) {
        lastLitAt = now
        const src = ctx.createBufferSource()
        src.buffer = samples['burner-light']
        const gain = ctx.createGain()
        gain.gain.value = BURNER_LIGHT_GAIN
        src.connect(gain).connect(bus)
        src.start(now)
      }
      previous = throttle
    },
    setLevel(level: number, seconds: number): void {
      const now = ctx.currentTime
      bus.gain.cancelScheduledValues(now)
      bus.gain.setValueAtTime(bus.gain.value, now)
      bus.gain.linearRampToValueAtTime(level * ENGINE_LEVEL, now + seconds)
    },
    dispose(): void {
      try {
        idle.src.stop()
        turbine.src.stop()
        burner.src.stop()
      } catch {
        // すでに止まっている
      }
    },
  }
}

/**
 * 実録音の機銃（段 B11c、ADR 0039）。撃っているあいだ M61A2 の連射のループを鳴らし、止めたら余韻を
 * 1 回鳴らす。合成音の `GunVoice` と同じ口
 */
export interface RecordedGunVoice {
  start(): void
  stop(): void
  dispose(): void
}

/** 機銃のループと余韻の大きさ。合成音の機銃（rms 0.095）と耳で並ぶ程度にした（推測） */
const GUN_GAIN = 0.8
/** 撃ち始めと撃ち止めの寄せ 秒。即座に切るとプツッと鳴る（合成音と同じ） */
const GUN_EDGE = 0.02

export function createRecordedGunVoice(ctx: BaseAudioContext, destination: AudioNode, samples: WeaponSamples): RecordedGunVoice {
  const src = ctx.createBufferSource()
  src.buffer = samples['gun-loop']
  src.loop = true
  const gain = ctx.createGain()
  gain.gain.value = 0
  src.connect(gain).connect(destination)
  src.start()
  let firing = false
  return {
    start(): void {
      if (firing) return
      firing = true
      const now = ctx.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(GUN_GAIN, now + GUN_EDGE)
    },
    stop(): void {
      if (!firing) return
      firing = false
      const now = ctx.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(0, now + GUN_EDGE)
      // 撃ち止めの余韻。ループが消えるのと同時に鳴らし始める
      const tail = ctx.createBufferSource()
      tail.buffer = samples['gun-tail']
      const tailGain = ctx.createGain()
      tailGain.gain.value = GUN_GAIN
      tail.connect(tailGain).connect(destination)
      tail.start(now)
    },
    dispose(): void {
      try {
        src.stop()
      } catch {
        // すでに止まっている
      }
    },
  }
}

/** ミサイルの発射音の大きさ。ピーク −1 dBFS にそろえてあるので下げる（推測） */
const MISSILE_LAUNCH_GAIN = 0.35

/** 実録音のミサイルの発射音を `when` に 1 回鳴らす（段 B11c） */
export function playRecordedLaunch(ctx: BaseAudioContext, destination: AudioNode, samples: WeaponSamples, when = ctx.currentTime): void {
  const src = ctx.createBufferSource()
  src.buffer = samples['missile-launch']
  const gain = ctx.createGain()
  gain.gain.value = MISSILE_LAUNCH_GAIN
  src.connect(gain).connect(destination)
  src.start(when)
}
