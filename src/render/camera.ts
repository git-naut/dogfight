import * as THREE from 'three'
import type { AircraftSample } from '../sim/aircraft'
import type { LookOffset } from '../input/mouseLook'

/**
 * 追従カメラ。
 *
 * 速度感の大半はここで作る。機体に剛結すると動きが読めず、逆に遅らせすぎると
 * 操作が鈍く感じる。指数ラグで少し遅れて追い、速度に応じて画角を広げる。
 *
 * 平滑化は 1 - exp(-dt/τ) で書く。単純に係数を掛けるとフレームレートで
 * 追従の速さが変わってしまう。
 *
 * **バネダンパではない。**ダンパ項も速度の状態も持たないので、行き過ぎて
 * 戻る動きは出ない。目標へ単調に近づくだけ。オーバーシュートを前提に
 * 定数を選ぶと合わない。
 */

/**
 * 機体座標での定位置。-Z が前なので、後方は +Z。
 * 高さは垂直尾翼（先端が y=4.6）より上に置く。尾翼と同じ高さだと
 * 真後ろから見たときに尾翼が線に潰れてロールが読み取りにくい。
 */
const OFFSET = new THREE.Vector3(0, 6.8, 23)

/** 注視点を機首の先に置く距離 m */
const LOOK_AHEAD = 60

/** 位置と注視点の追従時定数 s */
const POSITION_TAU = 0.09
const TARGET_TAU = 0.05
/** 機体のロールにカメラが追従する時定数 s */
const ROLL_TAU = 0.14

const FOV_BASE = 60
const FOV_MAX = 78
/** この速度で画角が最大になる m/s */
const FOV_FULL_SPEED = 420

export interface ChaseCamera {
  readonly camera: THREE.PerspectiveCamera
  /** 1 フレーム分追従させる */
  update(sample: AircraftSample, dt: number, look: LookOffset): void
  /** 補間を挟まず一気に定位置へ置く。キャプチャモードと初期化で使う */
  snap(sample: AircraftSample, look: LookOffset): void
}

export function createChaseCamera(camera: THREE.PerspectiveCamera): ChaseCamera {
  const target = new THREE.Vector3()
  const desiredPosition = new THREE.Vector3()
  const desiredTarget = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)

  const q = new THREE.Quaternion()
  const offset = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const lookQuat = new THREE.Quaternion()
  const bodyUp = new THREE.Vector3()
  const craftPos = new THREE.Vector3()

  let initialized = false

  function computeDesired(sample: AircraftSample, look: LookOffset): void {
    q.set(
      sample.orientation.x,
      sample.orientation.y,
      sample.orientation.z,
      sample.orientation.w,
    )
    craftPos.set(sample.position.x, sample.position.y, sample.position.z)

    // 視点操作ぶんだけ機体まわりにオフセットを回す
    offset.copy(OFFSET)
    if (look.yaw !== 0 || look.pitch !== 0) {
      lookQuat.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'))
      offset.applyQuaternion(lookQuat)
    }
    offset.applyQuaternion(q)

    desiredPosition.copy(craftPos).add(offset)

    forward.set(0, 0, -1).applyQuaternion(q)
    desiredTarget.copy(craftPos).addScaledVector(forward, LOOK_AHEAD)

    bodyUp.set(0, 1, 0).applyQuaternion(q)
  }

  function applyFov(speed: number): void {
    const t = Math.min(1, Math.max(0, speed / FOV_FULL_SPEED))
    const fov = FOV_BASE + (FOV_MAX - FOV_BASE) * t * t
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  return {
    camera,

    update(sample, dt, look) {
      if (!initialized) return this.snap(sample, look)

      computeDesired(sample, look)

      const kp = 1 - Math.exp(-dt / POSITION_TAU)
      const kt = 1 - Math.exp(-dt / TARGET_TAU)
      const kr = 1 - Math.exp(-dt / ROLL_TAU)

      camera.position.lerp(desiredPosition, kp)
      target.lerp(desiredTarget, kt)

      // ロールを遅らせて追う。即座に合わせると回転が読み取れない
      up.lerp(bodyUp, kr).normalize()
      camera.up.copy(up)
      camera.lookAt(target)

      applyFov(sample.speed)
    },

    snap(sample, look) {
      computeDesired(sample, look)
      camera.position.copy(desiredPosition)
      target.copy(desiredTarget)
      up.copy(bodyUp)
      camera.up.copy(up)
      camera.lookAt(target)
      applyFov(sample.speed)
      initialized = true
    },
  }
}
