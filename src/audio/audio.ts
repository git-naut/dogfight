import {
  createNoiseBuffer,
  createGunVoice,
  createEngineVoice,
  playExplosion,
  playLaunch,
  playWarningBeep,
  createLimiter,
  createSoftClip,
  type GunVoice,
  type EngineVoice,
} from './synth'
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
 * 警告音の間隔 秒。
 *
 * **HUD の点滅と同じ速さにしない。**目と耳が別々に主張すると落ち着かない。
 * 0.5 秒はロックオン警報の実機の感覚に近く、切迫を伝えつつ会話を邪魔しない
 */
const WARNING_INTERVAL = 0.5

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

  /** 前のフレームのカウンタ。最初のフレームは差を取らない */
  let previous: AudioCounters | null = null
  /** 次に警告音を鳴らす時刻。`ctx.currentTime` と比べる */
  let nextWarningAt = 0

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

      if (view.threatened) {
        if (now >= nextWarningAt) {
          playWarningBeep(ctx, master, now)
          nextWarningAt = now + WARNING_INTERVAL
        }
      } else {
        // 追われなくなったら次の警告は即座に鳴らせるようにする
        nextWarningAt = 0
      }

      engine.setThrottle(view.throttle)
    },

    setVolume(value: number): void {
      master.gain.setTargetAtTime(clamp01(value), ctx.currentTime, 0.05)
    },

    dispose(): void {
      gun.dispose()
      engine.dispose()
      void ctx.close()
    },
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
