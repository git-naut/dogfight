import {
  createNoiseBuffer,
  createGunVoice,
  createEngineVoice,
  playExplosion,
  playLaunch,
  createWarningVoice,
  createLimiter,
  createSoftClip,
  type GunVoice,
  type EngineVoice,
  type WarningVoice,
} from './synth'
import { warblePeriod } from './warningTone'
import {
  createSpatialVoices,
  type AudioEnemy,
  type AudioExplosions,
  type AudioListener,
} from './spatialVoices'
import {
  createRecordedEngineVoice,
  createRecordedGunVoice,
  loadEngineSamples,
  loadSamples,
  loadWeaponSamples,
  playRecordedLaunch,
  type RecordedEngineVoice,
  type RecordedGunVoice,
  type WeaponSamples,
} from './recorded'
import {
  diffCounters,
  limitExplosions,
  isFiring,
  type AudioCounters,
  type AudioEvents,
} from './events'

/**
 * 効果音。
 *
 * **`AudioContext` はユーザ操作に紐づける。**ブラウザの autoplay 制限で、
 * クリックなしに作った `AudioContext` は `suspended` のまま音が出ない。
 * タイトルの START が受け皿（段 7 で `onStart` を開けてある）。
 *
 * **sim には触らない。**`Combat` が持つ単調増加のカウンタの差を見る
 * （`events.ts`）。sim にコールバックを生やすと `layering.test.ts` の
 * 規約を破る道ができる。
 *
 * **キャプチャモードでは作らない。**1 枚描いて止まるので鳴らす意味がなく、
 * `AudioContext` の生成が待ち時間になる（`?sound=0`）。
 */

/** 毎フレーム渡す状態 */
export interface AudioView extends AudioCounters {
  /** スロットル 0..1 */
  readonly throttle: number
  /** ミサイルに追われているか。HUD の警告と同じ条件 */
  readonly threatened: boolean
  /** いちばん近いミサイルの着弾までの秒（段 B10）。警告音の揺れの周期を縮める */
  readonly timeToImpact: number
  /** 自機（段 B11d）。音を置く向きと距離、ドップラーの基準 */
  readonly listener: AudioListener
  /** 敵機（段 B11d）。エンジン音・通過音・発射の音を置く */
  readonly enemies: readonly AudioEnemy[]
  /** 爆発（段 B11d）。新しい順に位置を読む */
  readonly explosions: AudioExplosions | null
  /** すれ違った回数と、最後にすれ違った敵機の添字（段 B11d、sim の `World.flybyCount`） */
  readonly flybyCount: number
  readonly lastFlybyEnemy: number
}

export interface GameAudio {
  /** 毎フレーム呼ぶ */
  update(view: AudioView): void
  /** エンジンが実録音に切り替わったか（段 B11b）。読み込みの前と、読み込めなかったときは false */
  readonly engineRecorded: boolean
  /** 機銃とミサイルが実録音に切り替わったか（段 B11c） */
  readonly weaponsRecorded: boolean
  /** 鳴らしている敵機のエンジン音の数（段 B11d） */
  readonly enemyEnginesPlaying: number
  /** 音量 0..1。設定画面から呼ぶ */
  setVolume(volume: number): void
  /** 止める。ページを離れるとき */
  dispose(): void
}

/** 合成音から実録音のエンジンへ入れ替える秒（段 B11b） */
const ENGINE_SWAP_SECONDS = 0.5

/**
 * 機銃の発射速度 発/秒。
 *
 * M61A1 は毎分 6,000 発（`docs/weapons.md`）。振幅変調の周波数に使う
 */
const ROUNDS_PER_SECOND = 100

/**
 * 音を作る。
 *
 * **失敗しても null を返す。**`AudioContext` が作れない環境（古い
 * ブラウザ、音声デバイスが無い、ポリシーで拒否）でゲームが止まっては
 * いけない。音は無くても遊べる。
 */
export function createGameAudio(volume: number): GameAudio | null {
  let ctx: AudioContext
  try {
    ctx = new AudioContext()
  } catch {
    return null
  }

  // **リミッタを最後に置く。**音量を絞る前に潰すと、音量を上げたとき
  // 潰れ具合が変わる。マスタ音量 → リミッタ → 出力の順にすれば、
  // 潰れる条件は音量に依らない
  const master = ctx.createGain()
  master.gain.value = clamp01(volume)
  master.connect(createLimiter(ctx)).connect(createSoftClip(ctx)).connect(ctx.destination)

  const noise = createNoiseBuffer(ctx)
  let gun: GunVoice | RecordedGunVoice = createGunVoice(ctx, master, noise, ROUNDS_PER_SECOND)
  let gunFiring = false
  let weapons: WeaponSamples | null = null
  // 合成音のエンジンは専用のバスを通す。実録音が読めたら下げて止める（段 B11b）
  const synthBus = ctx.createGain()
  synthBus.connect(master)
  let engine: EngineVoice | null = createEngineVoice(ctx, synthBus, noise)
  let recorded: RecordedEngineVoice | null = null
  let lastThrottle = 0
  let disposed = false
  // 機銃とミサイル（段 B11c）。読めたら入れ替える。撃っている最中なら合成音を止めて実録音で続ける
  void loadWeaponSamples(ctx, import.meta.env.BASE_URL).then((samples) => {
    if (samples === null || disposed) return
    weapons = samples
    const recordedGun = createRecordedGunVoice(ctx, master, samples)
    const synthGun = gun
    if (gunFiring) {
      synthGun.stop()
      recordedGun.start()
    }
    gun = recordedGun
    setTimeout(() => synthGun.dispose(), 100)
  })
  // **読み込みは待たない。**読み終わるまでは合成音で鳴らし、読めたら 0.5 秒で入れ替える
  void loadEngineSamples(ctx, import.meta.env.BASE_URL).then((samples) => {
    if (samples === null || disposed) return
    recorded = createRecordedEngineVoice(ctx, master, samples, 0)
    recorded.setThrottle(lastThrottle)
    recorded.setLevel(1, ENGINE_SWAP_SECONDS)
    const now = ctx.currentTime
    synthBus.gain.setValueAtTime(1, now)
    synthBus.gain.linearRampToValueAtTime(0, now + ENGINE_SWAP_SECONDS)
    const synth = engine
    engine = null
    setTimeout(() => synth?.dispose(), (ENGINE_SWAP_SECONDS + 0.1) * 1000)
  })
  // 立体の音（段 B11d）。爆発と敵のミサイルの発射は起きた位置に置く。敵機のエンジン音と通過音は
  // タービンと通過音を読めてから鳴らす
  const spatial = createSpatialVoices(ctx, master, {
    playExplosion: (out, when) => playExplosion(ctx, out, noise, when),
    playLaunch: (out, when) => {
      if (weapons !== null) playRecordedLaunch(ctx, out, weapons, when)
      else playLaunch(ctx, out, noise, when)
    },
  })
  void loadSamples(ctx, import.meta.env.BASE_URL, ['engine-turbine', 'flyby'] as const).then((samples) => {
    if (samples === null || disposed) return
    spatial.setSamples({ turbine: samples['engine-turbine'], flyby: samples.flyby })
  })
  // 段 B10 で持続音にした。段 B9 までは 0.5 秒おきの断続音（`WARNING_INTERVAL`）
  const warning: WarningVoice = createWarningVoice(ctx, master)

  /** 前のフレームのカウンタ。最初のフレームは差を取らない */
  let previous: AudioCounters | null = null

  return {
    update(view: AudioView): void {
      // **`suspended` のままなら鳴らさない。**タブが背面に回ると
      // ブラウザが止める。復帰は次の操作に任せる
      if (ctx.state !== 'running') return

      const events: AudioEvents =
        previous === null
          ? { shots: 0, explosions: 0, launches: 0 }
          : limitExplosions(diffCounters(previous, view))
      previous = {
        roundsFired: view.roundsFired,
        explosionCount: view.explosionCount,
        missilesFired: view.missilesFired,
      }

      gunFiring = isFiring(events)
      if (gunFiring) gun.start()
      else gun.stop()

      const now = ctx.currentTime
      // 爆発・敵機のエンジン音・通過音・敵のミサイルの発射は、起きた位置に置く（段 B11d）
      spatial.update({
        listener: view.listener,
        enemies: view.enemies,
        explosions: view.explosions,
        newExplosions: events.explosions,
        flybyCount: view.flybyCount,
        lastFlybyEnemy: view.lastFlybyEnemy,
      })
      // 自機のミサイルの発射は自機の位置で鳴らす
      for (let i = 0; i < events.launches; i++) {
        if (weapons !== null) playRecordedLaunch(ctx, master, weapons, now + i * 0.06)
        else playLaunch(ctx, master, noise, now + i * 0.06)
      }

      // 追われているあいだ鳴らし続け、着弾が近づくほど揺れを速める（段 B10）
      if (view.threatened) {
        warning.setPeriod(warblePeriod(view.timeToImpact))
        warning.start()
      } else {
        warning.stop()
      }

      engine?.setThrottle(view.throttle)
      recorded?.setThrottle(view.throttle)
      lastThrottle = view.throttle
    },

    get engineRecorded(): boolean {
      return recorded !== null
    },

    get weaponsRecorded(): boolean {
      return weapons !== null
    },

    get enemyEnginesPlaying(): number {
      return spatial.enemyEnginesPlaying
    },

    setVolume(value: number): void {
      master.gain.setTargetAtTime(clamp01(value), ctx.currentTime, 0.05)
    },

    dispose(): void {
      disposed = true
      gun.dispose()
      engine?.dispose()
      recorded?.dispose()
      spatial.dispose()
      warning.dispose()
      void ctx.close()
    },
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
