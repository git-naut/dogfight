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
 *
 * **参考画像（Ace Combat 7 の追従視点）に合わせて寄せた**（2026-10-01、ユーザーの指示）。
 * 参考画像では機体の翼幅が画面の幅の 39〜49%、中心が高さの 74% 前後。
 *
 * | カメラ | 巡航 `level` の翼幅・中心 | 高速 `low-pass` の翼幅・中心 |
 * |---|---|---|
 * | 後方 23 m・上 6.8 m、画角 60〜78° | 27.7%・66.5% | — |
 * | 後方 15.5 m・上 4.4 m、画角 60〜78° | 44.4%・69.4% | 40.8%・73.4% |
 * | 後方 13.5 m・上 3.85 m、画角 60〜78° | 53.0%・72.0% | 48.6%・74.4% |
 * | **後方 15.5 m・上 3.8 m、画角 50〜68°（いま）** | **54.5%・68.5%** | **49.7%・72.3%** |
 *
 * **速く飛ぶほど画角が開いて機体が小さく写る**ので、参考画像の大きい方（49%）を高速の
 * 構図で満たすように合わせた。**距離を縮める手は捨てた。**13.5 m ではアフターバーナーの
 * 内炎の先がカメラから 4.4 m に入り、近い面（5 m）で丸く切れた。近い面を手前へ寄せると
 * 遠くの稜線で深度の精度が落ちる（`webgl.ts` の near 5 m の注記）。画角を狭めれば
 * 近い面に触れずに大きく写せる。
 *
 * 高さは F-16 の垂直尾翼の先端（y = 4.6）より低い。尾翼と同じ高さだと真後ろから尾翼が
 * 線に潰れてロールが読みにくいが、F/A-18E の尾翼は外へ傾いた 2 枚なので潰れない。
 * 上 4.4 m では高速の構図で機体の下端が画面の端に届いた
 */
const OFFSET = new THREE.Vector3(0, 3.8, 15.5)

/** 注視点を機首の先に置く距離 m */
const LOOK_AHEAD = 60

/** 位置と注視点の追従時定数 s */
const POSITION_TAU = 0.09
const TARGET_TAU = 0.05
/** 機体のロールにカメラが追従する時定数 s */
const ROLL_TAU = 0.14

/**
 * 画角の下限と上限 度（縦）。速いほど開く。**60〜78° から 50〜68° へ狭めた**（2026-10-01、
 * 機体を大きく写すため。上の `OFFSET` の表）。速度で 18° 開く幅は変えていない
 */
const FOV_BASE = 50
const FOV_MAX = 68
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
