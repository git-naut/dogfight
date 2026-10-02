import * as THREE from 'three'
import type { AircraftSample } from '../sim/aircraft'
import type { LookOffset } from '../input/mouseLook'

/**
 * 追従カメラ。
 *
 * 速度感の大半はここで作る。機体に剛結すると動きが読めず、逆に遅らせすぎると
 * 操作が鈍く感じる。機体まわりの向きだけ指数ラグで少し遅れて追い、速いほど画角を
 * 狭めて機体を近く大きく見せる。
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
 * 参考画像では機体の翼幅が画面の幅の 39〜49%、中心が高さの 74% 前後。それでも「まだ
 * 小さい」と 2 度言われたので、参考画像より大きく取った。
 *
 * | カメラ | 巡航 `level` の翼幅・中心 | 高速 `low-pass` の翼幅・中心 |
 * |---|---|---|
 * | 後方 23 m・上 6.8 m、画角 60→78° | 27.7%・66.5% | — |
 * | 後方 15.5 m・上 4.4 m、画角 60→78° | 44.4%・69.4% | 40.8%・73.4% |
 * | 後方 15.5 m・上 3.8 m、画角 50→68° | 54.5%・68.5% | 49.7%・72.3% |
 * | 後方 15.5 m・上 3.0 m、画角 50→38° | 69.5%・64.7% | 75.0%・71.0% |
 *
 * **いまは後方 19.5 m・上 3.8 m、画角 50→42°**（2026-10-02）。15.5 m・50→36° では
 * 「大きく写りすぎ。調整前との間くらいに」とユーザーの指摘。翼幅をライブで測り、
 * 調整前（70bf6d0 のライブ）と 15.5 m の版の中間を狙った。高さは距離と同じ比で
 * 上げたので、機体の中心の上下の位置は 15.5 m の版と変わらない
 *
 * | 速度 | 70bf6d0 のライブ | 15.5 m・50→36° | 中間 | いま |
 * |---|---|---|---|---|
 * | 150 m/s | 30.0% | 51.8% | 40.9% | 41.1% |
 * | 250 m/s | 24.8% | 61.3% | 43.1% | 45.2% |
 * | 320 m/s | 22.9% | 72.5% | 47.7% | 49.3% |
 *
 * **この表はキャプチャ（`snap`、遅れ無し）で測った値。**ライブでは 2026-10-01 まで
 * 世界の位置を遅れて追っていて、250 m/s でカメラが 36 m 後ろに残り、翼幅は表の半分
 * ほどだった（「速くしても近づいて見えない」とユーザーの指摘）。いまは遅れを向きに
 * だけ掛けるので、ライブも表と同じ距離に写る。画角は 150〜350 m/s で狭める
 * （`FOV_SLOW_SPEED`）。数での確かめは `tests/render/chaseCamera.test.ts`
 *
 * **距離を縮める手は捨てた。**後方 13.5 m ではアフターバーナーの内炎の先がカメラから
 * 4.4 m に入り、近い面（5 m）で丸く切れた。近い面を手前へ寄せると遠くの稜線で深度の
 * 精度が落ちる（`webgl.ts` の near 5 m の注記）。画角を狭めれば近い面に触れずに大きく写せる。
 *
 * **大きく写すと機体が画面の下へずれる**ので、高さで戻した（画角 50→42° では上 3.8 m で
 * 下端が 95.7%、2.6 m では中心が 59.8% と上に寄った）。高さは F-16 の垂直尾翼の先端
 * （y = 4.6）より低い。尾翼と同じ高さだと真後ろから尾翼が線に潰れてロールが読みにくいが、
 * F/A-18E の尾翼は外へ傾いた 2 枚なので潰れない
 */
const OFFSET = new THREE.Vector3(0, 3.8, 19.5)

/** 注視点を機首の先に置く距離 m */
const LOOK_AHEAD = 60

/** 位置と注視点の追従時定数 s */
const POSITION_TAU = 0.09
const TARGET_TAU = 0.05
/** 機体のロールにカメラが追従する時定数 s */
const ROLL_TAU = 0.14

/**
 * 画角 度（縦）。遅いとき `FOV_BASE`、`FOV_FULL_SPEED` で `FOV_FAST`。
 *
 * **速いほど狭めて、機体を近く大きく見せる**（2026-10-01、ユーザーの指示）。以前は速いほど
 * 開いて（60→78°）、速く飛ぶほど機体が小さく写っていた。いまは 50→42°。ライブで測ると、
 * 翼幅（13.4 m の両端を投影）は 150 m/s で 41.1%、250 m/s で 45.2%、350 m/s で 49.9%
 * （150→350 m/s で 1.21 倍）。50→36° では 1.43 倍だったが、15.5 m と合わせて大きすぎた
 */
const FOV_BASE = 50
const FOV_FAST = 42
/**
 * 画角が狭まり始める速度と、`FOV_FAST` に届く速度 m/s。間は smoothstep。
 *
 * **台本と実戦の速度域（150〜350 m/s）の中で変える。**以前は 0〜420 m/s に t² で
 * 掛けていて、150→320 m/s で翼幅が 1.14 倍にしか変わらなかった（2026-10-02）
 */
const FOV_SLOW_SPEED = 150
const FOV_FULL_SPEED = 350

export interface ChaseCamera {
  readonly camera: THREE.PerspectiveCamera
  /** 1 フレーム分追従させる */
  update(sample: AircraftSample, dt: number, look: LookOffset): void
  /** 補間を挟まず一気に定位置へ置く。キャプチャモードと初期化で使う */
  snap(sample: AircraftSample, look: LookOffset): void
}

export function createChaseCamera(camera: THREE.PerspectiveCamera): ChaseCamera {
  /** 機体から見たカメラと注視点の位置（世界の向き）。遅れはここにだけ掛ける */
  const currentOffset = new THREE.Vector3()
  const currentLook = new THREE.Vector3()
  const desiredOffset = new THREE.Vector3()
  const desiredLook = new THREE.Vector3()
  const target = new THREE.Vector3()
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

    desiredOffset.copy(offset)

    forward.set(0, 0, -1).applyQuaternion(q)
    desiredLook.copy(forward).multiplyScalar(LOOK_AHEAD)

    bodyUp.set(0, 1, 0).applyQuaternion(q)
  }

  function applyFov(speed: number): void {
    const t = Math.min(1, Math.max(0, (speed - FOV_SLOW_SPEED) / (FOV_FULL_SPEED - FOV_SLOW_SPEED)))
    const fov = FOV_BASE + (FOV_FAST - FOV_BASE) * t * t * (3 - 2 * t)
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

      // **遅れは機体まわりの向きにだけ掛ける。**世界の位置を追わせると、等速でも
      // 速度 × 約 0.085 秒だけ後ろに残り、250 m/s で 15.5 m の定位置が 36 m に伸びて
      // 機体が半分の大きさに写っていた（2026-10-02 に測った。キャプチャは snap なので
      // 基準画像には出ない）。平行移動は機体と一緒にして、距離を速度で変えない
      currentOffset.lerp(desiredOffset, kp)
      currentLook.lerp(desiredLook, kt)
      camera.position.copy(craftPos).add(currentOffset)
      target.copy(craftPos).add(currentLook)

      // ロールを遅らせて追う。即座に合わせると回転が読み取れない
      up.lerp(bodyUp, kr).normalize()
      camera.up.copy(up)
      camera.lookAt(target)

      applyFov(sample.speed)
    },

    snap(sample, look) {
      computeDesired(sample, look)
      currentOffset.copy(desiredOffset)
      currentLook.copy(desiredLook)
      camera.position.copy(craftPos).add(currentOffset)
      target.copy(craftPos).add(currentLook)
      up.copy(bodyUp)
      camera.up.copy(up)
      camera.lookAt(target)
      applyFov(sample.speed)
      initialized = true
    },
  }
}
