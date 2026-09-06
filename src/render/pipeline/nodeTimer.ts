import type { Renderer } from 'three/webgpu'
import { NO_GPU_TIMER, type GpuFrameTimer } from '../backend'

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
 */

interface TimestampRenderer {
  resolveTimestampsAsync(type?: string): Promise<number | undefined>
  info: { render: { timestamp: number } }
}

export function createNodeTimer(renderer: Renderer): GpuFrameTimer {
  const target = renderer as unknown as TimestampRenderer
  if (typeof target.resolveTimestampsAsync !== 'function') return NO_GPU_TIMER

  const resolved: { id: number; ms: number }[] = []
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
      void target
        .resolveTimestampsAsync('render')
        .then((ms) => {
          // **`undefined` も 0 も「測れていない」。**`timestamp-query` が
          // 無ければ `undefined`、解決する物が無いか GPU の状態が乱れて
          // いれば初期値の 0 が返る。0 を数に混ぜると最小値が 0 になる
          if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
            resolved.push({ id, ms })
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
