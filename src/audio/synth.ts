/**
 * 音を合成する。
 *
 * **外部の音源を調達しない。**アセットのライセンス（`CLAUDE.md`）を
 * 増やさずに済むし、4 MB の大気 LUT を読み込む起動時間へ音声ファイルを
 * 積み増すこともない。Web Audio の発振器とノイズで作る。
 *
 * **すべて「作って鳴らして捨てる」。**`AudioBufferSourceNode` と
 * `OscillatorNode` は 1 回鳴らすと再利用できない仕様なので、使い捨てる。
 * `onended` を待たずに済むよう、停止時刻を指定して投げっぱなしにする。
 *
 * **受けるのは `BaseAudioContext`。**`OfflineAudioContext` も渡せる。
 * 音は目で見えないので、実際に振幅が出ているかは書き出した波形を測って
 * 確かめる（`tests/e2e/smoke.spec.ts` の「音」）。`AudioContext` に
 * 狭めると、その検査が書けない。
 */

/**
 * クリップを防ぐリミッタ。
 *
 * **個々のゲインを詰めても足りない。**爆発だけで実測 peak 1.22 だった
 * うえ、1 フレームに 2 発まで重ねる（`events.ts`）。機銃とエンジンは
 * その裏で鳴り続けている。全部が同時に立つ瞬間の振幅は予測できない。
 *
 * 音量を下げて逃げると、単発が聞こえないほど小さくなる。マスタの手前で
 * 抑えるのがゲーム音声の常道。
 *
 * `threshold` は −6 dB。`ratio` 12 と `knee` 0 でほぼリミッタとして働く。
 * `attack` を 3 ms にすると爆発の立ち上がり（12 ms）に間に合う。
 */
export function createLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -6
  limiter.knee.value = 0
  limiter.ratio.value = 12
  limiter.attack.value = 0.003
  limiter.release.value = 0.25
  return limiter
}

/**
 * ソフトクリップ。出力が必ず 1 を下回るようにする。
 *
 * **`DynamicsCompressorNode` だけでは足りない。**あちらはルックアヘッドを
 * 持たないので、瞬間的なピークを通してしまう。実測で、全部が同時に鳴る
 * 場合を 8 回測ったうち 2 回が 1 を超えた（1.0166 と 1.0535）。
 * 波形は `Math.random()` のノイズなので、引きによって変わる。
 *
 * 小信号は素通しにする。しきい値までは傾き 1 のまま、そこから上だけ
 * `tanh` で丸めて 1 へ漸近させる。全体に `tanh` を掛けると通常の音まで
 * 8% ほど痩せる。
 *
 * ```
 * f(x) = x                                          (|x| <= t)
 * f(x) = sign(x) * (t + (L-t) * tanh((|x|-t)/(L-t)))  (|x| > t)
 * ```
 *
 * **上限 L は 1 ではなく 0.98。**1 にすると `tanh` が 1 へ漸近する部分が
 * Float32 でちょうど 1.0 に丸められ、大きな入力がすべて 1.0 に張り付く。
 * 実測で 8 回すべてが 1.0000 だった。1.0 は有効範囲の内側なのでクリップ
 * ではないが、上限に触れているかどうかを測って区別できなくなる。
 */
export const SOFT_CLIP_KNEE = 0.7
export const SOFT_CLIP_LIMIT = 0.98
/** 定義域。これを超える入力は WaveShaper が端の値へ丸める */
export const SOFT_CLIP_DOMAIN = 4

/**
 * カーブそのもの。
 *
 * **`WaveShaperNode` から切り離す。**node でテストできる。「必ず上限を
 * 下回る」「小信号は素通し」「単調」という性質は、ブラウザを立ち上げずに
 * 確かめられるべきもの。
 */
export function softClipCurve(
  points: number,
  knee = SOFT_CLIP_KNEE,
  limit = SOFT_CLIP_LIMIT,
  domain = SOFT_CLIP_DOMAIN,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points)
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 * domain - domain
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (limit - knee) * Math.tanh((a - knee) / (limit - knee))
    curve[i] = Math.sign(x) * y
  }
  return curve
}

export function createSoftClip(ctx: BaseAudioContext): WaveShaperNode {
  const shaper = ctx.createWaveShaper()
  const curve = softClipCurve(8192)
  shaper.curve = curve
  // **オーバーサンプリングは切る。**内部で 4 倍にしてから戻すときの
  // フィルタがリンギングを生み、カーブが 1 未満に丸めた波形を 1 の上へ
  // 押し戻す。実測で `'4x'` にしたら 8 回すべてが 1.04〜1.07 になり、
  // 切る前（2 回超過）より悪化した。歪みの少なさよりクリップしない
  // 保証を取る
  shaper.oversample = 'none'
  return shaper
}

/**
 * ホワイトノイズの土台。
 *
 * 爆発と機銃とエンジンで使い回す。**毎回作ると重い。**1 秒ぶんを 1 枚
 * 作り、再生位置をずらして使う。1 秒あれば繰り返しの周期は聞き取れない。
 */
export function createNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  // 決定論は要らない（描画に影響しない）が、Math.random を sim の外で
  // 使うことは規約に反しない（`layering.test.ts` は src/sim だけを見る）
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

/**
 * 爆発。
 *
 * ノイズの急峻な立ち上がりと指数減衰に、低域の衝撃を重ねる。
 * 低い正弦波を下へ滑らせると「ドン」に、ノイズのローパスを閉じていくと
 * 「シャー」が「ゴォ」へ変わる。
 */
export function playExplosion(
  ctx: BaseAudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
  when = ctx.currentTime,
): void {
  const duration = 1.4

  // ノイズ。ローパスを閉じながら減衰させる
  const src = ctx.createBufferSource()
  src.buffer = noise
  src.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(2200, when)
  filter.frequency.exponentialRampToValueAtTime(180, when + duration)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, when)
  // 立ち上がりは 12 ms。これより長いと「ボワッ」になって衝撃が消える。
  // **0.9 から 0.54 へ下げた。**単発で peak 1.18 になり、1 フレームに
  // 2 発まで重ねる（`events.ts`）ので後段が常に潰れていた
  gain.gain.exponentialRampToValueAtTime(0.54, when + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration)
  src.connect(filter).connect(gain).connect(destination)
  src.start(when)
  src.stop(when + duration)

  // 低域の衝撃。90 Hz から 35 Hz へ落とす
  const thump = ctx.createOscillator()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(90, when)
  thump.frequency.exponentialRampToValueAtTime(35, when + 0.45)
  const thumpGain = ctx.createGain()
  thumpGain.gain.setValueAtTime(0.0001, when)
  thumpGain.gain.exponentialRampToValueAtTime(0.48, when + 0.02)
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.6)
  thump.connect(thumpGain).connect(destination)
  thump.start(when)
  thump.stop(when + 0.6)
}

/**
 * ミサイルの発射。
 *
 * ロケットモータの点火。ノイズを帯域で削り、短く抜ける。
 */
export function playLaunch(
  ctx: BaseAudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
  when = ctx.currentTime,
): void {
  const duration = 0.9
  const src = ctx.createBufferSource()
  src.buffer = noise
  src.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(700, when)
  filter.frequency.exponentialRampToValueAtTime(2400, when + duration)
  filter.Q.value = 0.7
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(0.55, when + 0.05)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration)
  src.connect(filter).connect(gain).connect(destination)
  src.start(when)
  src.stop(when + duration)
}

/**
 * ミサイル警告。
 *
 * 矩形波の断続。**HUD の警告と同じ意味を持たせる。**耳障りにする必要が
 * あるので方形波を使うが、そのままだと痛いのでローパスで角を落とす。
 */
export function playWarningBeep(
  ctx: BaseAudioContext,
  destination: AudioNode,
  when = ctx.currentTime,
): void {
  const duration = 0.12
  const osc = ctx.createOscillator()
  osc.type = 'square'
  osc.frequency.value = 880
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 2600
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(0.32, when + 0.008)
  gain.gain.setValueAtTime(0.32, when + duration - 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration)
  osc.connect(filter).connect(gain).connect(destination)
  osc.start(when)
  osc.stop(when + duration)
}

/**
 * 機銃。撃っているあいだ鳴らし続ける。
 *
 * **1 発ずつ鳴らさない。**秒 100 発（`docs/weapons.md`）なので個々の
 * 発射音は分離せず、連続した唸りになる。ノイズを帯域で削り、発射速度で
 * 振幅変調を掛けて「ブーッ」を作る。
 *
 * 返すのは止めるための関数。
 */
export interface GunVoice {
  /** 鳴らし始める。すでに鳴っていれば何もしない */
  start(): void
  /** 止める。短くフェードして切る */
  stop(): void
  dispose(): void
}

export function createGunVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
  /** 発射速度 発/秒。振幅変調の周波数になる */
  roundsPerSecond: number,
): GunVoice {
  const src = ctx.createBufferSource()
  src.buffer = noise
  src.loop = true

  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 1100
  filter.Q.value = 0.8

  // 発射速度で振幅を揺らす。これが唸りの正体
  const modulator = ctx.createOscillator()
  modulator.type = 'sawtooth'
  modulator.frequency.value = roundsPerSecond
  const modGain = ctx.createGain()
  modGain.gain.value = 0.45

  const gain = ctx.createGain()
  gain.gain.value = 0

  src.connect(filter).connect(gain).connect(destination)
  // 変調は gain の値に足し込む。gain.gain の基準値と合わせて 0..1 に収める
  modulator.connect(modGain).connect(gain.gain)

  src.start()
  modulator.start()

  let firing = false
  return {
    start(): void {
      if (firing) return
      firing = true
      const now = ctx.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(0.5, now + 0.02)
    },
    stop(): void {
      if (!firing) return
      firing = false
      const now = ctx.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      // **切るのは 30 ms。**即座に 0 にするとプツッと鳴る
      gain.gain.linearRampToValueAtTime(0, now + 0.03)
    },
    dispose(): void {
      try {
        src.stop()
        modulator.stop()
      } catch {
        // すでに止まっている
      }
    },
  }
}

/**
 * エンジン。連続音。
 *
 * ノイズのローパスと低い正弦波を重ね、スロットルで周波数と音量を動かす。
 * **止めない。**飛んでいるあいだずっと鳴る。
 */
export interface EngineVoice {
  /** スロットル 0..1 を反映する */
  setThrottle(throttle: number): void
  dispose(): void
}

export function createEngineVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
): EngineVoice {
  const src = ctx.createBufferSource()
  src.buffer = noise
  src.loop = true

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 420
  filter.Q.value = 1.2

  const tone = ctx.createOscillator()
  tone.type = 'sawtooth'
  tone.frequency.value = 70

  const toneGain = ctx.createGain()
  toneGain.gain.value = 0.12

  const gain = ctx.createGain()
  gain.gain.value = 0.18

  src.connect(filter).connect(gain).connect(destination)
  tone.connect(toneGain).connect(gain)

  src.start()
  tone.start()

  return {
    setThrottle(throttle: number): void {
      const t = Math.min(1, Math.max(0, throttle))
      const now = ctx.currentTime
      // **急に変えない。**スロットルは 2.5 秒で 0 から 1 まで動くので
      // （`keyboard.ts`）、追従を 0.15 秒にすれば階段が聞こえない
      filter.frequency.setTargetAtTime(320 + t * 900, now, 0.15)
      tone.frequency.setTargetAtTime(58 + t * 46, now, 0.15)
      gain.gain.setTargetAtTime(0.12 + t * 0.22, now, 0.15)
    },
    dispose(): void {
      try {
        src.stop()
        tone.stop()
      } catch {
        // すでに止まっている
      }
    },
  }
}
