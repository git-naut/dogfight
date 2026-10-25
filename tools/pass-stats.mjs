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
