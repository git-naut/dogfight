/**
 * 実録音の効果音を読み込んで鳴らす（Phase 10 の段 B11b、ADR 0038）。
 *
 * 音のファイルは `tools/audio-import.mjs` が `public/audio/` に書き出した Opus（ADR 0037）。
 * **読み込みに失敗しても止めない。**null を返し、呼ぶ側は合成音のまま鳴らす。音は無くても遊べる
 */
import { engineLayerGains, shouldLightBurner, turbineRate } from './engineMix'

/** エンジンの 3 層と点火の音 */
export const ENGINE_SAMPLES = ['engine-idle', 'engine-turbine', 'engine-burner', 'burner-light'] as const
export type EngineSampleName = (typeof ENGINE_SAMPLES)[number]
export type EngineSamples = Record<EngineSampleName, AudioBuffer>

/** `baseUrl`（`import.meta.env.BASE_URL`）の `audio/` から読み、デコードする。1 本でも失敗したら null */
export async function loadEngineSamples(ctx: BaseAudioContext, baseUrl: string): Promise<EngineSamples | null> {
  try {
    const buffers = await Promise.all(
      ENGINE_SAMPLES.map(async (name) => {
        const response = await fetch(`${baseUrl}audio/${name}.ogg`)
        if (!response.ok) throw new Error(`${name}: ${response.status}`)
        return ctx.decodeAudioData(await response.arrayBuffer())
      }),
    )
    return Object.fromEntries(ENGINE_SAMPLES.map((name, i) => [name, buffers[i]!])) as EngineSamples
  } catch {
    return null
  }
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
