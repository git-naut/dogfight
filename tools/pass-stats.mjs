// GPU のパスごとの所要の統計（段 S0a）。`tools/win-pass-perf.mjs` が読む。
//
// 素の JavaScript で書く。Windows 側の node が変換なしで実行するため
// （`tools/win-perf.mjs` と同じ作法）。型は `pass-stats.d.mts`。
//
// 入力はフックの `gpuPassHistory`（フレームごとの内訳）を重なりを除いて
// 集めたもの。群は `src/render/pipeline/passTimes.ts` の表で決まっている。

/**
 * 分位点。線形補間（R の type 7）。空なら null。
 * @param {readonly number[]} values
 * @param {number} q 0..1
 */
export function quantile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * フレームの列に新しいフレームを足す。フレーム番号で重なりを除く。
 * **フックの輪は 0.5 秒おきに読むと前回と重なる**ので、番号で見分ける
 * @param {Map<number, import('./pass-stats.d.mts').PassFrame>} seen
 * @param {readonly import('./pass-stats.d.mts').PassFrame[]} history
 * @returns {number} 新しく足した数
 */
export function collectFrames(seen, history) {
  let added = 0
  for (const frame of history) {
    if (seen.has(frame.frame)) continue
    seen.set(frame.frame, frame)
    added++
  }
  return added
}

/**
 * フレームごとの群の和。
 * @param {import('./pass-stats.d.mts').PassFrame} frame
 * @returns {Map<string, number>}
 */
export function groupSums(frame) {
  const sums = new Map()
  for (const pass of frame.passes) sums.set(pass.group, (sums.get(pass.group) ?? 0) + pass.ms)
  return sums
}

/**
 * 群ごとと合計の統計。
 *
 * **間欠の群は「出たフレームの値」と「全フレームの平均の寄与」を分ける。**
 * 環境反射は約 1 秒に 1 回だけ 40 本加わる。全フレームの中央値を取ると 0 になり、
 * 出たフレームだけの中央値では毎フレームの重さに見える。両方を出す。
 * @param {readonly import('./pass-stats.d.mts').PassFrame[]} frames
 * @returns {import('./pass-stats.d.mts').PassStats}
 */
export function passStats(frames) {
  const totals = frames.map((f) => f.totalMs)
  const perGroup = new Map()
  for (const frame of frames) {
    for (const [group, ms] of groupSums(frame)) {
      let list = perGroup.get(group)
      if (list === undefined) {
        list = []
        perGroup.set(group, list)
      }
      list.push(ms)
    }
  }
  const groups = [...perGroup].map(([group, values]) => ({
    group,
    frames: values.length,
    share: frames.length === 0 ? 0 : values.length / frames.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: Math.max(...values),
    meanPerFrame: values.reduce((a, b) => a + b, 0) / frames.length,
  }))
  return {
    frames: frames.length,
    unlabeled: frames.reduce((n, f) => n + f.unlabeled, 0),
    total: {
      min: totals.length === 0 ? null : Math.min(...totals),
      median: quantile(totals, 0.5),
      p95: quantile(totals, 0.95),
      max: totals.length === 0 ? null : Math.max(...totals),
    },
    groups,
  }
}

/** 60 fps の 1 フレームの長さ ms */
export const FRAME_BUDGET_MS = 1000 / 60
/** rAF の間隔がこれを越えたら 1 フレーム落ちたとみなす（60 fps の 1.5 倍） */
export const DROPPED_INTERVAL_MS = FRAME_BUDGET_MS * 1.5
/** rAF の間隔がこれを越えたら、間の記録が読み出しで抜けたとみなす ms */
export const READ_GAP_MS = 1000

/**
 * 跳ねたコマ（段 S5）。中央値と 95% だけでは、最大のコマと fps の落ちの正体が見えない。
 *
 * - GPU: 合計が 1 フレームの長さを越えたコマの数と、重い順に `limit` 個の群の内訳
 * - CPU: rAF の間隔（`cpuFrameHistory` の隣どうしの差）が 1.5 倍を越えたコマの数と、
 *   長い順に `limit` 個。そのコマの CPU の内訳と、同じ番号の GPU の合計を添える
 *
 * CPU の記録が無い版（段 S0e より前）では `cpu` を null にする
 * @param {readonly import('./pass-stats.d.mts').PassFrame[]} frames
 * @param {readonly import('./pass-stats.d.mts').CpuFrame[]} cpuFrames
 * @param {number} [limit]
 * @returns {import('./pass-stats.d.mts').FrameOutliers}
 */
export function frameOutliers(frames, cpuFrames, limit = 8) {
  const top = (sums) =>
    [...sums]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([group, ms]) => ({ group, ms }))
  const worst = [...frames]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
    .map((f) => ({ frame: f.frame, totalMs: f.totalMs, groups: top(groupSums(f)) }))
  const gpu = { over: frames.filter((f) => f.totalMs > FRAME_BUDGET_MS).length, worst }
  if (cpuFrames.length < 2) return { gpu, cpu: null }

  const byFrame = new Map(frames.map((f) => [f.frame, f.totalMs]))
  const sorted = [...cpuFrames].sort((a, b) => a.frame - b.frame)
  const intervals = []
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i]
    const intervalMs = c.at - sorted[i - 1].at
    // **番号は 1 ずつ進むとは限らない。**段 S5 の実機で、番号の連続を条件にしたら間隔が
    // 1 つも取れなかった（three の `info.frame` が 1 回の rAF で複数進むと見ている。推測）。
    // 1 秒を越える間隔は読み出しの抜けとみなし、作らない
    if (intervalMs > READ_GAP_MS) continue
    intervals.push({
      frame: c.frame,
      intervalMs,
      simMs: c.simMs,
      syncMs: c.syncMs,
      renderMs: c.renderMs,
      hudMs: c.hudMs,
      gpuMs: byFrame.get(c.frame) ?? null,
    })
  }
  return {
    gpu,
    cpu: {
      intervals: intervals.length,
      dropped: intervals.filter((x) => x.intervalMs > DROPPED_INTERVAL_MS).length,
      worst: intervals.sort((a, b) => b.intervalMs - a.intervalMs).slice(0, limit),
    },
  }
}
