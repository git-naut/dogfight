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

/**
 * ターゲットロケーターの寸法（段 D8、ADR 0036）。録画（lesson 5 のコマ 19660〜19730）の 1920×1080 の画素。
 *
 * 録画の印は、線だけの細長い三角錐。先端・底の左右の角・底の真ん中のくぼみを結び、先端からくぼみへ稜線が
 * 通る。底は画面の中心から 約 80〜90 画素（照準のすぐ外）、長さ 約 113〜120 画素、底の幅 約 17〜30 画素
 */
export const LOCATOR_BASE_RADIUS_REF = 85
export const LOCATOR_LENGTH_REF = 115
/** 底のくぼみの深さ（底の左右の角から先端の側へ）。録画は 約 13 画素 */
export const LOCATOR_NOTCH_REF = 14
/**
 * 底の幅。近いほど太く、遠いほど細く鋭くする（ユーザーの決定）。1 km で 30、8 km で 14、間は一様。
 * 幅の範囲は録画（17〜30）に合わせ、距離の範囲は推測
 */
export const LOCATOR_WIDTH_NEAR_REF = 30
export const LOCATOR_WIDTH_FAR_REF = 14
export const LOCATOR_NEAR_M = 1000
export const LOCATOR_FAR_M = 8000

/** 相手までの距離 m から底の幅（1080 基準の画素）を出す */
export function locatorWidth(distance: number): number {
  if (!(distance > LOCATOR_NEAR_M)) return LOCATOR_WIDTH_NEAR_REF
  if (distance >= LOCATOR_FAR_M) return LOCATOR_WIDTH_FAR_REF
  const t = (distance - LOCATOR_NEAR_M) / (LOCATOR_FAR_M - LOCATOR_NEAR_M)
  return LOCATOR_WIDTH_NEAR_REF + (LOCATOR_WIDTH_FAR_REF - LOCATOR_WIDTH_NEAR_REF) * t
}

/** 印の 4 点（画面の画素）。先端・底の左・くぼみ・底の右 */
export interface LocatorShape {
  tipX: number
  tipY: number
  leftX: number
  leftY: number
  notchX: number
  notchY: number
  rightX: number
  rightY: number
}

/**
 * 印の 4 点を出す。`dir` は画面の中心から相手へ向かう単位ベクトル（`offscreenDirection`）、`scale` は
 * 1080 基準からの縮尺。底の真ん中を中心から `LOCATOR_BASE_RADIUS_REF` に置き、先端を相手の側へ伸ばす
 */
export function locatorShape(
  dir: { x: number; y: number },
  distance: number,
  centerX: number,
  centerY: number,
  scale: number,
  out: LocatorShape = { tipX: 0, tipY: 0, leftX: 0, leftY: 0, notchX: 0, notchY: 0, rightX: 0, rightY: 0 },
): LocatorShape {
  const baseX = centerX + dir.x * LOCATOR_BASE_RADIUS_REF * scale
  const baseY = centerY + dir.y * LOCATOR_BASE_RADIUS_REF * scale
  const half = (locatorWidth(distance) / 2) * scale
  // 向きに直交する向き
  const nx = -dir.y
  const ny = dir.x
  out.tipX = baseX + dir.x * LOCATOR_LENGTH_REF * scale
  out.tipY = baseY + dir.y * LOCATOR_LENGTH_REF * scale
  out.leftX = baseX + nx * half
  out.leftY = baseY + ny * half
  out.rightX = baseX - nx * half
  out.rightY = baseY - ny * half
  out.notchX = baseX + dir.x * LOCATOR_NOTCH_REF * scale
  out.notchY = baseY + dir.y * LOCATOR_NOTCH_REF * scale
  return out
}
