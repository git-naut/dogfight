/**
 * 世界座標から画面座標への投影。
 *
 * **three には触らない。**ビュー射影行列を数値の並びとして受け取り、掛け算
 * だけをここで行う。行列そのものは three のカメラが作るので値の出どころは
 * 1 つのまま、算術は node の単体テストで固定できる。HUD の線が 1 画素ずれる
 * 類の退行は絵では捕まらないので、ここを数値で押さえる意味がある。
 *
 * 行列は three の `Matrix4.elements` と同じ列優先 16 要素。
 * clip = M · (x, y, z, w) を素直に書き下してある。
 */

/** 列優先 16 要素のビュー射影行列 */
export type Mat4 = Readonly<ArrayLike<number>>

export interface ScreenPoint {
  /** CSS 画素。画面左上が原点、y は下向き */
  x: number
  y: number
  /**
   * カメラの前にあるか。
   *
   * 後ろにあると同次除算で符号が反転し、画面の反対側へ折り返した位置が出る。
   * **その点をそのまま線で結ぶと、画面を横切る嘘の線が引かれる。**呼び出し側は
   * 必ずこれを見てから使う。
   */
  inFront: boolean
}

export function createScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, inFront: false }
}

/**
 * 同次座標 (x, y, z, w) を画面座標へ写す。
 *
 * w = 1 なら世界の点、w = 0 なら無限遠の方向。ピッチラダーと水平線は
 * 無限遠の方向として扱う（機体の位置によらず同じ場所に出る）。
 */
export function projectHomogeneous(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  w: number,
  width: number,
  height: number,
  out: ScreenPoint = createScreenPoint(),
): ScreenPoint {
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w

  out.inFront = cw > 0
  if (cw === 0 || !Number.isFinite(cw)) {
    out.x = 0
    out.y = 0
    out.inFront = false
    return out
  }

  // NDC は [-1, 1]。y は上向きなので画面座標へは反転して写す
  const ndcX = cx / cw
  const ndcY = cy / cw
  out.x = (ndcX * 0.5 + 0.5) * width
  out.y = (0.5 - ndcY * 0.5) * height
  return out
}

/** 世界の点を投影する */
export function projectPoint(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  out: ScreenPoint = createScreenPoint(),
): ScreenPoint {
  return projectHomogeneous(m, x, y, z, 1, width, height, out)
}

/**
 * 方向（無限遠の点）を投影する。
 *
 * ピッチラダーと水平線と速度ベクトルはこれで出す。機体の位置を混ぜないので、
 * 高度が変わっても水平線が動かない。実際の HUD と同じ振る舞いになる。
 */
export function projectDirection(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  out: ScreenPoint = createScreenPoint(),
): ScreenPoint {
  return projectHomogeneous(m, x, y, z, 0, width, height, out)
}

/**
 * 方位角と仰角から世界の方向ベクトルを作る。
 *
 * 方位は -Z（機首の基準）から +X（右）へ回る向きを正にする。仰角は上が正。
 * `Target` の旋回や `setBodyRates` と同じ約束にそろえてある。
 */
export function directionFromAzimuthElevation(
  azimuth: number,
  elevation: number,
  out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } {
  const c = Math.cos(elevation)
  out.x = Math.sin(azimuth) * c
  out.y = Math.sin(elevation)
  out.z = -Math.cos(azimuth) * c
  return out
}

/**
 * 前方ベクトルから方位角 rad を出す。真北（-Z）が 0、右回りが正。
 *
 * 真上や真下を向いていると水平成分が消えて方位が定まらない。その場合は 0 を
 * 返す。HUD の方位表示はそこで固まるが、値を暴れさせるよりよい。
 */
export function headingOf(x: number, y: number, z: number): number {
  void y
  if (Math.abs(x) < 1e-9 && Math.abs(z) < 1e-9) return 0
  return Math.atan2(x, -z)
}

/** 前方ベクトルから仰角 rad を出す。上が正 */
export function elevationOf(x: number, y: number, z: number): number {
  const horizontal = Math.hypot(x, z)
  return Math.atan2(y, horizontal)
}

/**
 * 角度を半開区間 [-π, π) へ畳む。方位の差を取るのに使う。
 *
 * 端は -π 側に寄せる。±π は同じ角なのでどちらでもよいが、どちらかに
 * 決めておかないと「方位が 180 度のとき HUD の数字が 180 と -180 で
 * ちらつく」といった振る舞いになる。
 */
export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2
  let a = (angle + Math.PI) % twoPi
  if (a < 0) a += twoPi
  return a - Math.PI
}
