import {
  createNoiseBuffer,
  playExplosion,
  playLaunch,
  createWarningVoice,
  createGunVoice,
  createEngineVoice,
  createLimiter,
  createSoftClip,
} from './synth'
import { WARNING_TONE_HZ } from './warningTone'
import { createRecordedEngineVoice, loadEngineSamples } from './recorded'

/**
 * 音の自己診断。
 *
 * **音は目で見えない。**ノードが繋がっただけで振幅が 0 という状態は、
 * 画面を見ても分からないしスクリーンショット回帰にも写らない。実際に
 * 波形を書き出して測る。
 *
 * `?audioprobe=1` のときだけ走る。`?bench=` や `?sweep=1` と同じ、
 * 計測のためのモード（`capture.ts`）。**本番の経路には入らない。**
 *
 * `OfflineAudioContext` を使うので実時間を待たない。1.5 秒ぶんの合成が
 * ミリ秒で終わる。
 */

/** 1 つの音の測定結果 */
export interface AudioProbeResult {
  /** 二乗平均平方根。全体としてどれだけ鳴っているか */
  readonly rms: number
  /** 最大振幅。1 を超えるとクリップする */
  readonly peak: number
}

export interface AudioProbe {
  readonly explosion: AudioProbeResult
  readonly launch: AudioProbeResult
  readonly warning: AudioProbeResult
  readonly gun: AudioProbeResult
  readonly engine: AudioProbeResult
  /**
   * 全部が同時に鳴っている最悪の場合。**リミッタを通す。**
   *
   * 爆発 2 発（`MAX_EXPLOSIONS_PER_FRAME`）とミサイル発射、警告、機銃、
   * エンジンを重ねる。`peak` が 1 を超えていたらクリップしている
   */
  readonly worstCase: AudioProbeResult
  /** 警告音の形（段 B10）。持続音の倍音の山と、途切れないか */
  readonly warningShape: WarningShape
  /**
   * 実録音のエンジン（段 B11b）。スロットル 0.2・0.7・1.0 で 1.5 秒ずつ書き出し、鳴り始めの 0.5 秒を
   * 除いて測る。音のファイルを読めなかったら null
   */
  readonly engineLayers: readonly EngineLayerProbe[] | null
}

export interface EngineLayerProbe {
  readonly throttle: number
  /** 全体の大きさ dBFS */
  readonly rmsDb: number
  /** 音色の重心 Hz（48 点の強さの重み付き平均） */
  readonly centroidHz: number
  /** アフターバーナーの帯（200〜800 Hz）の強さ dB（相対） */
  readonly burnerBandDb: number
}

/** 周波数ごとの強さを測る点。40 Hz〜12 kHz を対数で 48 点 */
const BAND_FREQS = Array.from({ length: 48 }, (_, i) => 40 * Math.pow(12000 / 40, i / 47))

function measureEngine(buffer: AudioBuffer, throttle: number): EngineLayerProbe {
  const data = buffer.getChannelData(0)
  const rate = buffer.sampleRate
  const start = Math.floor(0.5 * rate)
  const end = data.length
  let sum = 0
  for (let i = start; i < end; i++) sum += (data[i] ?? 0) ** 2
  const rms = Math.sqrt(sum / (end - start))
  const powers = BAND_FREQS.map((f) => powerAt(data, start, end, f, rate))
  let weighted = 0
  let total = 0
  let band = 0
  BAND_FREQS.forEach((f, i) => {
    weighted += f * powers[i]!
    total += powers[i]!
    if (f >= 200 && f <= 800) band += powers[i]!
  })
  return {
    throttle,
    rmsDb: 20 * Math.log10(rms + 1e-12),
    centroidHz: weighted / (total + 1e-12),
    burnerBandDb: 10 * Math.log10(band + 1e-12),
  }
}

/** 実録音のエンジンを `throttle` で 1.5 秒書き出す */
async function renderRecordedEngine(baseUrl: string, throttle: number): Promise<EngineLayerProbe | null> {
  const ctx = new OfflineAudioContext(1, Math.floor(RATE * 1.5), RATE)
  const samples = await loadEngineSamples(ctx, baseUrl)
  if (samples === null) return null
  createRecordedEngineVoice(ctx, ctx.destination, samples).setThrottle(throttle)
  return measureEngine(await ctx.startRendering(), throttle)
}

/**
 * 試聴用。実録音のエンジンで、スロットルを `seconds` 秒かけて 0 から 1 へ上げた音を書き出す
 * （`?audiosweep=1`）。0.05 秒ごとに止めてスロットルを進めるので、ゲームの毎フレームの更新に近い
 */
export async function renderEngineSweep(baseUrl: string, seconds = 8): Promise<Float32Array | null> {
  const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE)
  const samples = await loadEngineSamples(ctx, baseUrl)
  if (samples === null) return null
  const voice = createRecordedEngineVoice(ctx, ctx.destination, samples)
  voice.setThrottle(0)
  const step = 0.05
  for (let t = step; t < seconds - step; t += step) {
    const at = t
    void ctx.suspend(at).then(() => {
      voice.setThrottle(Math.min(1, at / (seconds - 1)))
      void ctx.resume()
    })
  }
  return (await ctx.startRendering()).getChannelData(0)
}

/** 警告音の形。`probeAudio` が警告音を 1 秒書き出して測る */
export interface WarningShape {
  /**
   * 766 Hz の 3〜6 倍の高さの強さが、その ±6% の強さより何 dB 強いか。録画の線（2,300・3,060・3,830・
   * 4,600 Hz）に山があることを見る
   */
  readonly harmonicPeaksDb: readonly number[]
  /** 20 ms ごとの二乗平均平方根の、最小と平均の比。1 に近いほど途切れない */
  readonly continuity: number
}

/** `freq` Hz の強さ（Goertzel 法）。狙った周波数だけを測る */
function powerAt(data: Float32Array, start: number, end: number, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end; i++) {
    const s0 = (data[i] ?? 0) + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

function measureWarningShape(buffer: AudioBuffer): WarningShape {
  const data = buffer.getChannelData(0)
  const rate = buffer.sampleRate
  // 立ち上がり（20 ms）を外した 0.1〜0.9 秒を見る
  const start = Math.floor(0.1 * rate)
  const end = Math.floor(0.9 * rate)
  const harmonicPeaksDb = [3, 4, 5, 6].map((k) => {
    const f = WARNING_TONE_HZ * k
    const peak = powerAt(data, start, end, f, rate)
    const side = (powerAt(data, start, end, f * 0.94, rate) + powerAt(data, start, end, f * 1.06, rate)) / 2
    return 10 * Math.log10((peak + 1e-12) / (side + 1e-12))
  })
  const win = Math.floor(0.02 * rate)
  const rms: number[] = []
  for (let i = start; i + win <= end; i += win) {
    let sum = 0
    for (let j = i; j < i + win; j++) sum += (data[j] ?? 0) ** 2
    rms.push(Math.sqrt(sum / win))
  }
  const mean = rms.reduce((a, b) => a + b, 0) / rms.length
  return { harmonicPeaksDb, continuity: Math.min(...rms) / (mean + 1e-12) }
}

/** 書き出したサンプルを測る */
function measure(buffer: AudioBuffer): AudioProbeResult {
  const data = buffer.getChannelData(0)
  let sum = 0
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0
    sum += v * v
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  return { rms: Math.sqrt(sum / data.length), peak }
}

const RATE = 44100

/** 1 本ぶんを書き出す */
async function renderBuffer(
  seconds: number,
  build: (ctx: OfflineAudioContext, noise: AudioBuffer) => void,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE)
  build(ctx, createNoiseBuffer(ctx))
  return ctx.startRendering()
}

async function renderOne(
  seconds: number,
  build: (ctx: OfflineAudioContext, noise: AudioBuffer) => void,
): Promise<AudioProbeResult> {
  return measure(await renderBuffer(seconds, build))
}

/**
 * 全部測る。
 *
 * 機銃とエンジンは連続音なので、`start()` と `setThrottle()` を呼んで
 * から書き出す。**`currentTime` は 0 のまま進まない**（`startRendering`
 * を呼ぶまで時間は動かない）ので、予約は 0 秒起点で入る。
 */
export async function probeAudio(baseUrl: string): Promise<AudioProbe> {
  // 警告音は 1 秒書き出し、大きさと形の両方を測る（段 B10。段 B9 までは 0.2 秒の断続音 1 回）
  const warningBuffer = await renderBuffer(1.0, (ctx) => createWarningVoice(ctx, ctx.destination).start())
  const warning = measure(warningBuffer)
  const warningShape = measureWarningShape(warningBuffer)
  const [explosion, launch, gun, engine, worstCase] = await Promise.all([
    renderOne(1.5, (ctx, noise) => playExplosion(ctx, ctx.destination, noise, 0)),
    renderOne(1.0, (ctx, noise) => playLaunch(ctx, ctx.destination, noise, 0)),
    renderOne(0.5, (ctx, noise) => {
      createGunVoice(ctx, ctx.destination, noise, 100).start()
    }),
    renderOne(0.5, (ctx, noise) => {
      createEngineVoice(ctx, ctx.destination, noise).setThrottle(0.8)
    }),
    // **本番と同じ経路で測る。**マスタ音量 1.0 → リミッタ → 出力
    renderOne(1.5, (ctx, noise) => {
      const master = ctx.createGain()
      master.gain.value = 1
      master.connect(createLimiter(ctx)).connect(createSoftClip(ctx)).connect(ctx.destination)
      playExplosion(ctx, master, noise, 0)
      playExplosion(ctx, master, noise, 0.04)
      playLaunch(ctx, master, noise, 0)
      createWarningVoice(ctx, master).start()
      createGunVoice(ctx, master, noise, 100).start()
      createEngineVoice(ctx, master, noise).setThrottle(1)
    }),
  ])
  const layers = await Promise.all([0.2, 0.7, 1].map((t) => renderRecordedEngine(baseUrl, t)))
  const engineLayers = layers.every((l) => l !== null) ? (layers as EngineLayerProbe[]) : null
  return { explosion, launch, warning, gun, engine, worstCase, warningShape, engineLayers }
}
