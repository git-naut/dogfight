import {
  createNoiseBuffer,
  playExplosion,
  playLaunch,
  playWarningBeep,
  createGunVoice,
  createEngineVoice,
  createLimiter,
  createSoftClip,
} from './synth'

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
async function renderOne(
  seconds: number,
  build: (ctx: OfflineAudioContext, noise: AudioBuffer) => void,
): Promise<AudioProbeResult> {
  const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE)
  build(ctx, createNoiseBuffer(ctx))
  return measure(await ctx.startRendering())
}

/**
 * 全部測る。
 *
 * 機銃とエンジンは連続音なので、`start()` と `setThrottle()` を呼んで
 * から書き出す。**`currentTime` は 0 のまま進まない**（`startRendering`
 * を呼ぶまで時間は動かない）ので、予約は 0 秒起点で入る。
 */
export async function probeAudio(): Promise<AudioProbe> {
  const [explosion, launch, warning, gun, engine, worstCase] = await Promise.all([
    renderOne(1.5, (ctx, noise) => playExplosion(ctx, ctx.destination, noise, 0)),
    renderOne(1.0, (ctx, noise) => playLaunch(ctx, ctx.destination, noise, 0)),
    renderOne(0.2, (ctx) => playWarningBeep(ctx, ctx.destination, 0)),
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
      playWarningBeep(ctx, master, 0)
      createGunVoice(ctx, master, noise, 100).start()
      createEngineVoice(ctx, master, noise).setThrottle(1)
    }),
  ])
  return { explosion, launch, warning, gun, engine, worstCase }
}
