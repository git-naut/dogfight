import type { Renderer } from 'three/webgpu'
import { NO_GPU_TIMER, type GpuFrameSample, type GpuFrameTimer } from '../backend'
import { lastFrameOf, summarizeFrames, type FramePassTimes, type PassSource } from './passTimes'

/**
 * node 経路の GPU タイマー。
 *
 * WebGL2 の `EXT_disjoint_timer_query_webgl2` は node 経路に無い。
 * `renderer.resolveTimestampsAsync()` が返す ms を使う。
 *
 * **`trackTimestamp` は静かに false になる。**`device.features` に
 * `timestamp-query` が無い環境では、レンダラを `{ trackTimestamp: true }` で
 * 作っても有効にならず、`resolveTimestampsAsync()` が `undefined` を返す。
 * これを知らずに「GPU 時間が 0」を不具合として追うと時間を溶かす
 * （ADR 0010 の段 0 の注記）。**返り値が `undefined` かどうかで判定する。**
 *
 * 回収は非同期になる。WebGL2 のクエリと同じく「投げて数フレーム後に拾う」
 * 形なので、`GpuFrameTimer` の口はそのまま使える。
 *
 * **解決を重ねてはいけない。**WebGL2 のクエリは 1 本ずつ独立した物なので
 * 何本でも同時に飛ばせるが、こちらの解決は器が 1 つしかない。走っている
 * 最中にもう一度呼ぶと、three は解決を走らせずに前の値を返す
 * （`WebGLTimestampQueryPool.js:187` は `lastValue`、
 * `WebGPUTimestampQueryPool.js` は走っている promise そのもの）。
 * `lastValue` の初期値は 0 なので、重ねた回は 0 か「前の回の値」になる。
 * どちらもこの回の値ではない。**重なったら測らない。**
 *
 * **パスごとの内訳も同じ解決から読む**（段 S0a）。three は合計を返す直前に、
 * パスごとの ms を `timestampQueryPool.render.timestamps` に残している
 * （`WebGPUTimestampQueryPool.js` の `_resolveQueries`）。次の解決で消されるので、
 * 解決が決着したその場で読む。何のパスかは `sourceOf`（`PassInspector`）が引く。
 *
 * **コンピュートの時刻も解決する**（段 S3）。three はコンピュートの時刻を別の記録
 * （`timestampQueryPool.compute`）に持つ。描画だけを解決していたので、FFT の海の計算が
 * 実機の計測に 1 本も入らなかった。両方を解決し、合計にも内訳にも足す。コンピュートの
 * 無い場面では記録が無く（解決は `undefined`）、値は前と変わらない。
 */

interface TimestampRenderer {
  resolveTimestampsAsync(type?: string): Promise<number | undefined>
  info: { render: { timestamp: number } }
  backend?: {
    timestampQueryPool?: {
      render?: { timestamps?: ReadonlyMap<string, number>; frames?: readonly number[] } | null
      compute?: { timestamps?: ReadonlyMap<string, number>; frames?: readonly number[] } | null
    }
  }
}

/** パスの出どころを引く口。渡さなければ内訳を作らない */
export type PassSourceLookup = (uid: string) => PassSource | undefined

/** 1 回の解決に入っていた全フレームの内訳。読めなければ空 */
function readFrames(target: TimestampRenderer, sourceOf: PassSourceLookup): FramePassTimes[] {
  const pools = target.backend?.timestampQueryPool
  // 描画（鍵が `r:`）とコンピュート（`c:`）の記録を 1 つに合わせる。鍵は重ならない
  const merged = new Map<string, number>()
  for (const pool of [pools?.render, pools?.compute]) {
    for (const [uid, ms] of pool?.timestamps ?? []) merged.set(uid, ms)
  }
  if (merged.size === 0) return []
  return summarizeFrames(merged, sourceOf)
}

export function createNodeTimer(renderer: Renderer, sourceOf?: PassSourceLookup): GpuFrameTimer {
  const target = renderer as unknown as TimestampRenderer
  if (typeof target.resolveTimestampsAsync !== 'function') return NO_GPU_TIMER

  const resolved: GpuFrameSample[] = []
  let waiting = 0
  let dropped = 0
  let pendingId: number | null = null

  return {
    supported: true,

    get inflight() {
      return waiting
    },

    get dropped() {
      return dropped
    },

    begin(id) {
      pendingId = id
    },

    end() {
      if (pendingId === null) return
      const id = pendingId
      pendingId = null

      // 前の解決が決着するまで次を投げない。理由は本文の注記
      if (waiting > 0) {
        dropped++
        return
      }

      waiting++
      void Promise.all([target.resolveTimestampsAsync('render'), target.resolveTimestampsAsync('compute')])
        .then(([renderMs, computeMs]) => {
          // **2 つの「最後のフレーム」が違えば測らない。**three は記録ごとに、その記録へ最後に
          // 入ったフレームの合計を返す。起動直後はコンピュートの記録に海の初期化のフレームしか
          // 無く、足した値はどのフレームの値でもない（段 S4b で実機の記録から確かめた）
          const pools = target.backend?.timestampQueryPool
          const renderLast = pools?.render?.frames?.at(-1)
          const computeLast = pools?.compute?.frames?.at(-1)
          if (
            typeof computeMs === 'number' &&
            renderLast !== undefined &&
            computeLast !== undefined &&
            renderLast !== computeLast
          ) {
            dropped++
            return
          }
          // コンピュートの無い場面では `undefined`（足さない）
          const ms =
            typeof renderMs === 'number' && typeof computeMs === 'number' && Number.isFinite(computeMs)
              ? renderMs + computeMs
              : renderMs
          // **`undefined` も 0 も「測れていない」。**`timestamp-query` が
          // 無ければ `undefined`、解決する物が無いか GPU の状態が乱れて
          // いれば初期値の 0 が返る。0 を数に混ぜると最小値が 0 になる
          if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
            const frames = sourceOf === undefined ? [] : readFrames(target, sourceOf)
            // **内訳は three の合計と同じフレームから取る。**描画とコンピュートの記録を合わせた
            // 並びでは、コンピュートの古いフレーム（海の初期化）が後ろに来る。並びの最後を
            // 選ぶと別のフレームを比べる（段 S4b まで起動から 1 回の食い違いを数えていた）
            const passes =
              renderLast !== undefined
                ? (frames.find((f) => f.frame === renderLast) ?? lastFrameOf(frames))
                : lastFrameOf(frames)
            resolved.push(passes === null ? { id, ms } : { id, ms, passes, frames })
          } else {
            dropped++
          }
        })
        .catch(() => {
          // 解決に失敗した回は捨てる。次の回で拾い直す
          dropped++
        })
        .finally(() => {
          waiting--
        })
    },

    collect() {
      if (resolved.length === 0) return []
      return resolved.splice(0, resolved.length)
    },

    dispose() {
      resolved.length = 0
      pendingId = null
    },
  }
}
