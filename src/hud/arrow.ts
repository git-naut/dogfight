/**
 * 画面の外の相手を指す矢印の向き（段 35、参考画像に合わせた）。**純関数。**
 *
 * 投影した点（`projectPoint`）から、画面の中心からその相手へ向かう単位ベクトルを返す。
 * 画面の中に写っていれば null（矢印は要らない）。
 *
 * **カメラの後ろの点は向きを反転する。**同次除算で符号が反転し、画面の反対側へ折り返した
 * 位置が出るため（`project.ts` の `ScreenPoint.inFront`）。真後ろで中心に重なったら、
 * 下（振り返る向き）を指す
 */
export function offscreenDirection(
  point: { x: number; y: number; inFront: boolean },
  width: number,
  height: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } | null {
  const onScreen = point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
  if (point.inFront && onScreen) return null

  const sign = point.inFront ? 1 : -1
  const dx = (point.x - width / 2) * sign
  const dy = (point.y - height / 2) * sign
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) {
    out.x = 0
    out.y = 1
    return out
  }
  out.x = dx / length
  out.y = dy / length
  return out
}
