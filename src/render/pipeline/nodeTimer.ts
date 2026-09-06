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
  let pendingId: number | null = null

  return {
    supported: true,

    get inflight() {
      return waiting
    },

    begin(id) {
      pendingId = id
    },

    end() {
      if (pendingId === null) return
      const id = pendingId
      pendingId = null
      waiting++
      void target
        .resolveTimestampsAsync('render')
        .then((ms) => {
          // **`undefined` は `timestamp-query` が無いということ。**
          // 数を作らないので、回収できた件数がそのまま「測れたか」になる
          if (typeof ms === 'number' && Number.isFinite(ms)) {
            resolved.push({ id, ms })
          }
        })
        .catch(() => {
          // 解決に失敗した回は捨てる。次の回で拾い直す
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
