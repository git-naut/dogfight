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
}

export interface GameAudio {
  /** 毎フレーム呼ぶ */
  update(view: AudioView): void
  /** 音量 0..1。設定画面から呼ぶ */
  setVolume(volume: number): void
  /** 止める。ページを離れるとき */
  dispose(): void
}

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
  const gun: GunVoice = createGunVoice(ctx, master, noise, ROUNDS_PER_SECOND)
  const engine: EngineVoice = createEngineVoice(ctx, master, noise)
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

      if (isFiring(events)) gun.start()
      else gun.stop()

      const now = ctx.currentTime
      for (let i = 0; i < events.explosions; i++) {
        // **同じ時刻に重ねない。**位相が揃うと振幅が単純に足し合わさる
        playExplosion(ctx, master, noise, now + i * 0.04)
      }
      for (let i = 0; i < events.launches; i++) {
        playLaunch(ctx, master, noise, now + i * 0.06)
      }

      // 追われているあいだ鳴らし続け、着弾が近づくほど揺れを速める（段 B10）
      if (view.threatened) {
        warning.setPeriod(warblePeriod(view.timeToImpact))
        warning.start()
      } else {
        warning.stop()
      }

      engine.setThrottle(view.throttle)
    },

    setVolume(value: number): void {
      master.gain.setTargetAtTime(clamp01(value), ctx.currentTime, 0.05)
    },

    dispose(): void {
      gun.dispose()
      engine.dispose()
      warning.dispose()
      void ctx.close()
    },
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
