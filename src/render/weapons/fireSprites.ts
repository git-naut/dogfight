import * as THREE from 'three'
import { clampRadiusToNear } from './explosions'
import { radialSpriteHandle } from './radialSprite'

/**
 * 火の板の色と置き方（段 B9）。ミサイルの発射炎と炎の尾（`missileFlames.ts`）と、フレア（`flares.ts`）が
 * 同じものを使う。フレアはユーザーの指示で、ミサイルの炎と同じ赤みの橙の帯に寄せた。
 *
 * 色は**爆発の火の玉で測った教訓（`explosions.ts` の `FIREBALL_COLOR`・`CORE_COLOR`）を踏む。**
 *
 * - 露出 6 倍のあとで 1 を越えると AgX が白へ寄せて彩度が消える。ミサイルの炎の最初の版は芯
 *   (0.9, 0.55, 0.28)・暈 (0.7, 0.24, 0.06) で、出力は白い点と淡い桃色のにじみになった。次の
 *   (0.5, 0.24, 0.07) でも、いちばん明るい画素は rgb(221,165,125)・彩度 0.43 の肌色だった
 * - 赤は通常合成でしか出ない。加算は空が敷いた明るさより G と B を下げられない
 *
 * そこで、赤みの橙と黄みの橙は露出後が 1 未満に収まる値を通常合成で置き、黄みの白い芯は加算で重ねて
 * 出す（爆発の `HOT_CORE_COLOR` と同じ形）。
 *
 * どれも霞の後ろのパス（爆発の組の子）で描く前提。場面のパスに置くと、深度を書かない板に後ろの地形の
 * 距離で霞が掛かって消える
 */

/** 赤みの橙。暈と帯の外側 */
export const RED_ORANGE = new THREE.Color(0.16, 0.04, 0.008)
/** 黄みの橙。芯と帯の内側 */
export const YELLOW_ORANGE = new THREE.Color(0.17, 0.08, 0.016)
/** 黄みの白。露出前の値で、加算で重ねる */
export const HOT_COLOR = new THREE.Color(1.0, 0.8, 0.45)
/** 長い帯の芯の黄みの白。帯は長いので、丸い芯より抑える */
export const BAND_HOT_COLOR = new THREE.Color(0.6, 0.45, 0.24)

/** これより近い板は描かない m。画面を塗りつぶさないため（`flares.ts` の `MIN_CAMERA_DISTANCE`） */
const MIN_CAMERA_DISTANCE = 8

const scratch = new THREE.Vector3()
const lookMatrix = new THREE.Matrix4()
const middle = new THREE.Vector3()
const toCamera = new THREE.Vector3()
const side = new THREE.Vector3()
const normal = new THREE.Vector3()
const basis = new THREE.Matrix4()

function hide(mesh: THREE.Mesh): false {
  mesh.visible = false
  return false
}

/** カメラを向く丸い板を置く。描いたら true */
export function placeRound(
  mesh: THREE.Mesh,
  position: THREE.Vector3,
  radius: number,
  opacity: number,
  cameraPosition: THREE.Vector3,
  cameraForward: THREE.Vector3,
): boolean {
  scratch.subVectors(position, cameraPosition)
  if (opacity <= 0.004 || scratch.lengthSq() < MIN_CAMERA_DISTANCE ** 2) return hide(mesh)
  const clamped = clampRadiusToNear(scratch.dot(cameraForward), radius)
  if (clamped <= 0) return hide(mesh)
  mesh.position.copy(position)
  mesh.quaternion.setFromRotationMatrix(lookMatrix.lookAt(cameraPosition, position, THREE.Object3D.DEFAULT_UP))
  mesh.scale.setScalar(clamped * 2)
  radialSpriteHandle(mesh.material as THREE.Material)!.setOpacity(opacity)
  mesh.visible = true
  return true
}

/**
 * `start` から `direction`（単位ベクトル）の向きへ伸ばした帯の板を置く。軸の周りに回して面をカメラへ
 * 向ける。描いたら true。板の中心は `start` から `length / 2` 先。中心がカメラの near 面より手前なら
 * 描かない
 */
export function placeBand(
  mesh: THREE.Mesh,
  start: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  width: number,
  opacity: number,
  cameraPosition: THREE.Vector3,
  cameraForward: THREE.Vector3,
): boolean {
  middle.copy(start).addScaledVector(direction, length / 2)
  toCamera.subVectors(cameraPosition, middle)
  if (opacity <= 0.004 || toCamera.lengthSq() < MIN_CAMERA_DISTANCE ** 2) return hide(mesh)
  if (clampRadiusToNear(-toCamera.dot(cameraForward), width / 2) <= 0) return hide(mesh)
  side.crossVectors(direction, toCamera)
  // 真後ろから見ると軸が点になる。そのときは横の向きを決め打ちにする
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
  side.normalize()
  normal.crossVectors(side, direction).normalize()
  basis.makeBasis(side, direction, normal)
  mesh.position.copy(middle)
  mesh.quaternion.setFromRotationMatrix(basis)
  mesh.scale.set(width, length, 1)
  radialSpriteHandle(mesh.material as THREE.Material)!.setOpacity(opacity)
  mesh.visible = true
  return true
}
