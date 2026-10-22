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
import { createSpatialVoices } from './spatialVoices'
import {
  createRecordedEngineVoice,
  createRecordedGunVoice,
  loadEngineSamples,
  loadSamples,
  loadWeaponSamples,
  playRecordedLaunch,
} from './recorded'

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
  /** 実録音の機銃とミサイル（段 B11c）。音のファイルを読めなかったら null */
  readonly weapons: WeaponProbe | null
  /** 立体の音（段 B11d） */
  readonly spatial: SpatialProbe
  /** 敵機の機銃（段 B11c の追加）。音のファイルを読めなかったら null */
  readonly enemyGun: EnemyGunProbe | null
}

export interface EnemyGunProbe {
  /** 左 300 m で撃っている敵機に鳴らした数（1 のはず） */
  readonly playing: number
  /** そのときの左 − 右の大きさ dB */
  readonly leftDb: number
  /** 撃っていない敵機に鳴らした数（0 のはず） */
  readonly silentPlaying: number
}

/** 敵機の機銃の音。左 300 m の敵機が `shooting` なら 0.05 秒ごとに弾を 5 発ずつ増やして 1 秒書き出す */
async function renderEnemyGun(baseUrl: string, shooting: boolean): Promise<{ playing: number; leftDb: number } | null> {
  const ctx = new OfflineAudioContext(2, Math.floor(RATE * 1), RATE)
  const samples = await loadSamples(ctx, baseUrl, ['engine-turbine', 'flyby', 'gun-loop'] as const)
  if (samples === null) return null
  const spatial = createSpatialVoices(ctx, ctx.destination, { playExplosion() {}, playLaunch() {} })
  spatial.setSamples({ turbine: samples['engine-turbine'], flyby: samples.flyby, gunLoop: samples['gun-loop'] })
  const listener = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
  // エンジン音の範囲（1.5 km）より外に置けないので、エンジン音は鳴る。左右の差はエンジン音と合わせて測る
  const enemy = { aircraft: { position: { x: -300, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }, alive: true, missilesFired: 0, roundsFired: 0 }
  let playing = 0
  const step = 0.05
  for (let t = step; t < 1 - step; t += step) {
    const at = t
    void ctx.suspend(at).then(() => {
      if (shooting) enemy.roundsFired += 5
      spatial.update({ listener, enemies: [enemy], explosions: null, newExplosions: 0, flybyCount: 0, lastFlybyEnemy: -1 })
      playing = Math.max(playing, spatial.enemyGunsPlaying)
      void ctx.resume()
    })
  }
  const buffer = await ctx.startRendering()
  const rms = (data: Float32Array) => {
    let sum = 0
    for (const v of data) sum += v * v
    return 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-12)
  }
  return { playing, leftDb: rms(buffer.getChannelData(0)) - rms(buffer.getChannelData(1)) }
}

async function probeEnemyGun(baseUrl: string): Promise<EnemyGunProbe | null> {
  const [shooting, silent] = await Promise.all([renderEnemyGun(baseUrl, true), renderEnemyGun(baseUrl, false)])
  if (shooting === null || silent === null) return null
  return { playing: shooting.playing, leftDb: shooting.leftDb, silentPlaying: silent.playing }
}

export interface SpatialProbe {
  /** 自機の左 200 m に置いた音の、左 − 右の大きさ dB */
  readonly leftDb: number
  /** 自機の右 200 m に置いた音の、右 − 左の大きさ dB */
  readonly rightDb: number
  /** 前 100 m と前 1,000 m に置いた音の大きさの差 dB（近い − 遠い） */
  readonly distanceDb: number
}

/** 2 チャンネルで、自機の座標 `at` に置いた雑音を 0.5 秒書き出し、左右の大きさ dBFS を返す */
async function renderPlaced(at: { x: number; y: number; z: number }): Promise<{ left: number; right: number }> {
  const ctx = new OfflineAudioContext(2, Math.floor(RATE * 0.5), RATE)
  const spatial = createSpatialVoices(ctx, ctx.destination, { playExplosion() {}, playLaunch() {} })
  const listener = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
  const out = spatial.placeAt(at, listener)
  const src = ctx.createBufferSource()
  src.buffer = createNoiseBuffer(ctx)
  src.loop = true
  src.connect(out)
  src.start()
  const buffer = await ctx.startRendering()
  const rms = (data: Float32Array) => {
    let sum = 0
    for (const v of data) sum += v * v
    return 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-12)
  }
  return { left: rms(buffer.getChannelData(0)), right: rms(buffer.getChannelData(1)) }
}

/**
 * 試聴用。2 チャンネルで 8 秒。敵機が前方の左から自機の 50 m 横をすれ違って右後ろへ抜ける（自機との速さの差
 * 300 m/s）。敵機のエンジン音・ドップラー・通過音（すれ違った直後）が入る（`?audiosweep=spatial`）
 */
export async function renderSpatialDemo(baseUrl: string): Promise<Float32Array | null> {
  const seconds = 8
  const ctx = new OfflineAudioContext(2, Math.floor(RATE * seconds), RATE)
  const samples = await loadSamples(ctx, baseUrl, ['engine-turbine', 'flyby', 'gun-loop'] as const)
  if (samples === null) return null
  const spatial = createSpatialVoices(ctx, ctx.destination, { playExplosion() {}, playLaunch() {} })
  spatial.setSamples({ turbine: samples['engine-turbine'], flyby: samples.flyby, gunLoop: samples['gun-loop'] })
  const listener = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
  // 4 秒で真横（x = −50 → +50 へ斜めに抜ける）。z は −1,200 から +1,200 へ
  const enemy = { aircraft: { position: { x: -50, y: 0, z: -1200 }, velocity: { x: 0, y: 0, z: 300 } }, alive: true, missilesFired: 0, roundsFired: 0 }
  let flybyCount = 0
  let passed = false
  const step = 0.05
  for (let t = 0; t < seconds - step; t += step) {
    const at = t
    void ctx.suspend(at).then(() => {
      enemy.aircraft.position.z = -1200 + 300 * at
      enemy.aircraft.position.x = -50 + 25 * at
      if (!passed && enemy.aircraft.position.z > 0) {
        passed = true
        flybyCount++
      }
      spatial.update({ listener, enemies: [enemy], explosions: null, newExplosions: 0, flybyCount, lastFlybyEnemy: 0 })
      void ctx.resume()
    })
  }
  const buffer = await ctx.startRendering()
  // 左右を交互に並べて返す（書き出す側が 2 チャンネルの WAV にする）
  const l = buffer.getChannelData(0)
  const r = buffer.getChannelData(1)
  const out = new Float32Array(l.length * 2)
  for (let i = 0; i < l.length; i++) {
    out[2 * i] = l[i] ?? 0
    out[2 * i + 1] = r[i] ?? 0
  }
  return out
}

async function probeSpatial(): Promise<SpatialProbe> {
  const [left, right, near, far] = await Promise.all([
    renderPlaced({ x: -200, y: 0, z: 0 }),
    renderPlaced({ x: 200, y: 0, z: 0 }),
    renderPlaced({ x: 0, y: 0, z: -100 }),
    renderPlaced({ x: 0, y: 0, z: -1000 }),
  ])
  return {
    leftDb: left.left - left.right,
    rightDb: right.right - right.left,
    distanceDb: near.left - far.left,
  }
}

export interface WeaponProbe {
  /** 撃っているあいだ（0.2〜0.9 秒）の 20 ms ごとの大きさの、最小と平均の比 */
  readonly gunContinuity: number
  /** 撃っているあいだ（0.2〜0.9 秒）の大きさ dBFS */
  readonly gunRmsDb: number
  /** 撃ち止めの直後（1.05〜1.25 秒）と、そのあと（1.8〜2.0 秒）の大きさ dBFS */
  readonly tailEarlyDb: number
  readonly tailLateDb: number
  /** ミサイルの発射音が聞こえる長さ 秒（−60 dBFS を越える最後の時刻） */
  readonly missileSeconds: number
}

function windowRmsDb(data: Float32Array, rate: number, from: number, to: number): number {
  const a = Math.floor(from * rate)
  const b = Math.floor(to * rate)
  let sum = 0
  for (let i = a; i < b; i++) sum += (data[i] ?? 0) ** 2
  return 20 * Math.log10(Math.sqrt(sum / (b - a)) + 1e-12)
}

async function probeWeapons(baseUrl: string): Promise<WeaponProbe | null> {
  const gunCtx = new OfflineAudioContext(1, Math.floor(RATE * 2), RATE)
  const samples = await loadWeaponSamples(gunCtx, baseUrl)
  if (samples === null) return null
  const gun = createRecordedGunVoice(gunCtx, gunCtx.destination, samples)
  gun.start()
  void gunCtx.suspend(1.0).then(() => {
    gun.stop()
    void gunCtx.resume()
  })
  const gunData = (await gunCtx.startRendering()).getChannelData(0)
  const win = Math.floor(0.02 * RATE)
  const rms: number[] = []
  for (let i = Math.floor(0.2 * RATE); i + win <= Math.floor(0.9 * RATE); i += win) {
    let sum = 0
    for (let j = i; j < i + win; j++) sum += (gunData[j] ?? 0) ** 2
    rms.push(Math.sqrt(sum / win))
  }
  const mean = rms.reduce((x, y) => x + y, 0) / rms.length

  const missileCtx = new OfflineAudioContext(1, Math.floor(RATE * 3), RATE)
  const missileSamples = await loadWeaponSamples(missileCtx, baseUrl)
  if (missileSamples === null) return null
  playRecordedLaunch(missileCtx, missileCtx.destination, missileSamples, 0)
  const missileData = (await missileCtx.startRendering()).getChannelData(0)
  let last = 0
  const floor = 10 ** (-60 / 20)
  for (let i = 0; i < missileData.length; i++) if (Math.abs(missileData[i] ?? 0) > floor) last = i

  return {
    gunContinuity: Math.min(...rms) / (mean + 1e-12),
    gunRmsDb: windowRmsDb(gunData, RATE, 0.2, 0.9),
    tailEarlyDb: windowRmsDb(gunData, RATE, 1.05, 1.25),
    tailLateDb: windowRmsDb(gunData, RATE, 1.8, 2.0),
    missileSeconds: last / RATE,
  }
}

/**
 * 試聴用。実録音の機銃を 1.5 秒撃って止め（余韻）、1 秒あけてミサイルを撃つ流れを書き出す
 * （`?audiosweep=weapons`）
 */
export async function renderWeaponDemo(baseUrl: string): Promise<Float32Array | null> {
  const ctx = new OfflineAudioContext(1, Math.floor(RATE * 6), RATE)
  const samples = await loadWeaponSamples(ctx, baseUrl)
  if (samples === null) return null
  const gun = createRecordedGunVoice(ctx, ctx.destination, samples)
  gun.start()
  void ctx.suspend(1.5).then(() => {
    gun.stop()
    void ctx.resume()
  })
  playRecordedLaunch(ctx, ctx.destination, samples, 3.0)
  return (await ctx.startRendering()).getChannelData(0)
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
  const weapons = await probeWeapons(baseUrl)
  const spatial = await probeSpatial()
  const enemyGun = await probeEnemyGun(baseUrl)
  return { explosion, launch, warning, gun, engine, worstCase, warningShape, engineLayers, weapons, spatial, enemyGun }
}
