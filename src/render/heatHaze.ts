import * as THREE from 'three'

/**
 * 陽炎（Phase 10、ADR 0041）。排気の熱で空気の屈折率が揺らぎ、排気口の後ろの景色が揺らいで見える
 * 現象を、場面の絵を読む位置を範囲の中だけ揺らして表す（`pipeline/nodeOutput.ts`）。
 *
 * ここは範囲と強さを出す純関数。範囲は自機の排気口の真ん中から後ろへ `PLUME_LENGTH` m の円錐で、
 * 画面の上の始まりと終わりの点と太さにして渡す。強さはスロットルで決める。値はどれも推測
 * （ユーザーが実機の絵で確かめる）
 */

/** 揺らぐ範囲の長さ m（排気口から後ろへ） */
export const PLUME_LENGTH = 8
/** 終わりの太さは始まりの何倍か。排気は広がりながら冷える */
export const PLUME_SPREAD = 2.5
/** 揺れの最大のずれ。1080 の画面の画素（縦の画素で測る） */
export const HAZE_MAX_PIXELS = 3.5
/** アイドルでも残る強さ。エンジンが回っていれば排気は熱い */
export const HAZE_IDLE = 0.3

/** 後処理へ渡す範囲。座標は NDC（−1..1、上が +1）。太さは NDC の縦の長さの単位（横は縦横比で伸ばして測る） */
export interface HeatHazeState {
  startX: number
  startY: number
  endX: number
  endY: number
  startRadius: number
  endRadius: number
  /** 0..1。0 なら揺らさない */
  strength: number
  /** 揺れの時刻 秒。描画の時刻（`frame × FIXED_DT`）から渡す。実時間を使うと撮った絵が決まらない */
  time: number
}

export function createHeatHazeState(): HeatHazeState {
  return { startX: 0, startY: 0, endX: 0, endY: 0, startRadius: 0, endRadius: 0, strength: 0, time: 0 }
}

/** スロットル 0..1 から強さを出す。アイドルで 0.3、全開で 1 */
export function hazeStrength(throttle: number): number {
  const t = Math.min(1, Math.max(0, throttle))
  const s = Math.min(1, Math.max(0, (t - 0.2) / 0.8))
  return HAZE_IDLE + (1 - HAZE_IDLE) * s * s * (3 - 2 * s)
}

const mid = new THREE.Vector3()
const end = new THREE.Vector3()
const back = new THREE.Vector3()
const side = new THREE.Vector3()
const edge = new THREE.Vector3()
const a = new THREE.Vector3()
const b = new THREE.Vector3()

/**
 * 範囲を出す。`nozzles` は機体の座標の排気口（位置と半径）、`object` は自機の物体（世界の行列が
 * 最新であること）。範囲の始まりか終わりがカメラの後ろにあれば強さを 0 にする
 */
export function computeHeatHaze(
  nozzles: readonly { position: readonly [number, number, number]; radius: number }[],
  object: THREE.Object3D,
  camera: THREE.Camera,
  throttle: number,
  out: HeatHazeState,
): HeatHazeState {
  out.strength = 0
  if (nozzles.length === 0) return out
  // 排気口の真ん中と、真ん中から外側の口の縁までの半径（2 つの口をまとめて覆う）
  mid.set(0, 0, 0)
  for (const n of nozzles) mid.add(back.set(n.position[0], n.position[1], n.position[2]))
  mid.multiplyScalar(1 / nozzles.length)
  let radius = 0
  for (const n of nozzles) {
    const d = back.set(n.position[0], n.position[1], n.position[2]).distanceTo(mid) + n.radius
    radius = Math.max(radius, d)
  }
  // 機体の座標で後ろは +Z
  end.copy(mid).add(back.set(0, 0, PLUME_LENGTH))
  mid.applyMatrix4(object.matrixWorld)
  end.applyMatrix4(object.matrixWorld)

  // 太さは、範囲の軸に直交する向きへ半径ぶん離した点を投影して測る
  const startRadius = projectedRadius(mid, end, radius, camera)
  const endRadius = projectedRadius(end, mid, radius * PLUME_SPREAD, camera)
  a.copy(mid).project(camera)
  b.copy(end).project(camera)
  // NDC の z が 1 を超える点はカメラの後ろ（投影が折り返す）
  if (a.z > 1 || b.z > 1 || startRadius === null || endRadius === null) return out
  out.startX = a.x
  out.startY = a.y
  out.endX = b.x
  out.endY = b.y
  out.startRadius = startRadius
  out.endRadius = endRadius
  out.strength = hazeStrength(throttle)
  return out
}

/**
 * `at` から、`at`→`other` の軸とカメラの向きの両方に直交する向きへ `radius` m 離した点との距離。
 * NDC の横を縦横比で伸ばし、縦の長さの単位で測る（後処理も同じ空間で距離を測る）
 */
function projectedRadius(at: THREE.Vector3, other: THREE.Vector3, radius: number, camera: THREE.Camera): number | null {
  back.subVectors(other, at)
  camera.getWorldDirection(side)
  side.cross(back)
  if (side.lengthSq() < 1e-12) side.set(0, 1, 0)
  side.normalize()
  edge.copy(at).addScaledVector(side, radius).project(camera)
  a.copy(at).project(camera)
  if (a.z > 1 || edge.z > 1) return null
  const aspect = (camera as THREE.PerspectiveCamera).aspect ?? 1
  return Math.hypot((edge.x - a.x) * aspect, edge.y - a.y)
}
