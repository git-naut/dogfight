import * as THREE from 'three'
import type { BulletSource } from '../../sim/weapons/gun'
import { RIBBON_NEAR_CLIP_DEPTH } from '../ribbon'

/**
 * 曳光弾。
 *
 * 弾は 5 発に 1 発だけ光る。実銃の曳光弾の割合で、残りは見えない。だから
 * 描くのは `tracer` が立っている弾だけ。飛行中の弾が 250 発でも 50 本前後に
 * しかならない。
 *
 * **線分ではなくカメラを向いたクアッドで描く。**WebGL の `LineBasicMaterial` は
 * 線幅を変えられないので、どこでも 2 画素固定になる。実測で外接 2 × 96 画素の
 * 細い筋にしかならず、しかも加算の値が露出 6 倍と AgX を通って白に飛んだ
 * （芯の RGB 236,222,205。加算ぶんの比は 1 : 0.85 : 0.51 で、材質に与えた
 * 1 : 0.62 : 0.22 より彩度が落ちている）。
 *
 * クアッドなら幅を持たせられる。**幅は画面基準で決める。**世界の長さで
 * 決めると、遠い弾が 1 画素を割って消え、近い弾が太くなりすぎる。
 * 1 点につき頂点を 3 個（左端・中心・右端）置いて縁を透明にすると、
 * 硬い帯ではなく光の筋に見える。リボンと同じ作法。
 *
 * near 面の手前で終端する。曳光弾は機首の前方へ出るので普段はカメラから
 * 遠ざかるが、旋回中は視界を横切る。**端が near 面を越えるとラスタライザが
 * 切り、切り口が残る。**尾側は不透明度がもともと 0 なので終端だけで済み、
 * 先端は帯で滅衰させて飛び出しを消す。
 */

/**
 * 筋の長さ m。
 *
 * 60fps の 1 フレームで弾は 17 m 進む（1,030 m/s）。sim の 1 ステップでは
 * 8.6 m。目に見える筋の長さは残像なので、そのどちらでもなく見え方で決める。
 */
const TRACER_LENGTH = 34

/**
 * 芯の半幅 画面画素。
 *
 * 縁が透明なので、見た目の太さはこれより細い。1.6 だと線分と同じ細さになり、
 * クアッドにした意味がない。
 */
const HALF_WIDTH_PX = 2.6

/**
 * 光の色。
 *
 * **加算合成の値をそのまま上げると白に飛ぶ。**露出 6 倍と AgX が挟まるので、
 * 露出後に 1 を大きく超える値は彩度を失う。実測で 1.0, 0.62, 0.22 を与えたら
 * 加算ぶんが 1 : 0.85 : 0.51 に鈍った。低い値で彩度を残し、太さで見せる。
 */
const TRACER_COLOR = new THREE.Color(0.34, 0.13, 0.035)

/**
 * 先端が近づいたら滅衰させる帯 m。
 *
 * 打ち切りだけだと、閾値をまたいだ瞬間に筋が消えて飛び出して見える。
 * **淡くするだけでは断面は消えない**（リボンで実測した性質）。だから
 * 「尾側を閾値で終端し、先端は帯で滅衰させる」の両方をやる。
 */
const FADE_BAND = 20

export interface Tracers {
  readonly object: THREE.Object3D
  /** 描いた筋の数。予算と見え方の確認に使う */
  readonly drawn: number
  /**
   * 弾から筋を張り直す。毎フレーム呼ぶ。
   *
   * **弾源は複数ある。**自機と敵機がそれぞれ自分の機銃を持つので、1 本の帯へ
   * まとめて書き込む。プールが足りなければ手前で打ち切る。
   *
   * @param sources 弾を読む先。自機と生きている敵機のぶん
   * @param cameraPosition カメラの位置
   * @param cameraForward 視線方向の単位ベクトル。near 面の手前で終端するのに使う
   * @param radiansPerPixel 画面 1 画素が張る角度 rad。幅を画面基準にするのに使う
   */
  update(
    sources: readonly BulletSource[],
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
    radiansPerPixel: number,
  ): void
  dispose(): void
}

// 使い回す。毎フレーム作らない
const head = new THREE.Vector3()
const tail = new THREE.Vector3()
const along = new THREE.Vector3()
const toCamera = new THREE.Vector3()
const side = new THREE.Vector3()
const scratch = new THREE.Vector3()

/** 1 本あたりの頂点。左端・中心・右端 を尾と先で 2 組 */
const VERTS_PER_TRACER = 6
/** 1 本あたりの三角形の添字。区間 1 つに帯 2 枚（左半分と右半分） */
const INDICES_PER_TRACER = 12

export function createTracers(capacity: number): Tracers {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    // 自分で光っているものなので加算。奥行きは書かない
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const vertices = capacity * VERTS_PER_TRACER
  const position = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3)
  const color = new THREE.BufferAttribute(new Float32Array(vertices * 4), 4)
  position.setUsage(THREE.DynamicDrawUsage)
  color.setUsage(THREE.DynamicDrawUsage)

  const index = new Uint16Array(capacity * INDICES_PER_TRACER)
  for (let i = 0; i < capacity; i++) {
    // 尾の 3 頂点が a..a+2、先の 3 頂点が b..b+2
    const a = i * VERTS_PER_TRACER
    const b = a + 3
    const o = i * INDICES_PER_TRACER
    // 左半分
    index[o] = a
    index[o + 1] = b
    index[o + 2] = a + 1
    index[o + 3] = a + 1
    index[o + 4] = b
    index[o + 5] = b + 1
    // 右半分
    index[o + 6] = a + 1
    index[o + 7] = b + 1
    index[o + 8] = a + 2
    index[o + 9] = a + 2
    index[o + 10] = b + 1
    index[o + 11] = b + 2
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', position)
  geometry.setAttribute('color', color)
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.setDrawRange(0, 0)

  const mesh = new THREE.Mesh(geometry, material)
  // 弾は機体の前方へ散る。視錐台で捨てられると消える
  mesh.frustumCulled = false

  let drawn = 0

  /** 視線方向の深度 */
  function depthOf(
    p: THREE.Vector3,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): number {
    return scratch.subVectors(p, cameraPosition).dot(cameraForward)
  }

  /** 1 点ぶんの 3 頂点を書く */
  function writePoint(
    base: number,
    center: THREE.Vector3,
    halfWidth: number,
    alpha: number,
  ): void {
    position.setXYZ(
      base,
      center.x - side.x * halfWidth,
      center.y - side.y * halfWidth,
      center.z - side.z * halfWidth,
    )
    position.setXYZ(base + 1, center.x, center.y, center.z)
    position.setXYZ(
      base + 2,
      center.x + side.x * halfWidth,
      center.y + side.y * halfWidth,
      center.z + side.z * halfWidth,
    )
    // 縁は透明、中心が最も明るい
    color.setXYZW(base, TRACER_COLOR.r, TRACER_COLOR.g, TRACER_COLOR.b, 0)
    color.setXYZW(base + 1, TRACER_COLOR.r, TRACER_COLOR.g, TRACER_COLOR.b, alpha)
    color.setXYZW(base + 2, TRACER_COLOR.r, TRACER_COLOR.g, TRACER_COLOR.b, 0)
  }

  return {
    object: mesh,

    get drawn() {
      return drawn
    },

    update(sources, cameraPosition, cameraForward, radiansPerPixel) {
      let count = 0
      for (const source of sources) {
        if (count >= capacity) break
        for (let i = 0; i < source.bulletCapacity && count < capacity; i++) {
          const bullet = source.bulletAt(i)
          if (bullet.life <= 0 || !bullet.tracer) continue

          head.set(bullet.position.x, bullet.position.y, bullet.position.z)
          const speed = bullet.velocity.length()
          if (speed < 1e-6) continue
          tail
            .set(bullet.velocity.x, bullet.velocity.y, bullet.velocity.z)
            .multiplyScalar(-TRACER_LENGTH / speed)
            .add(head)

          const depthHead = depthOf(head, cameraPosition, cameraForward)
          // 先端がカメラの至近まで来たら描かない。帯で滅衰させてあるので、
          // ここに達した時点でほぼ透明になっている
          if (depthHead < RIBBON_NEAR_CLIP_DEPTH) continue

          const depthTail = depthOf(tail, cameraPosition, cameraForward)
          if (depthTail < RIBBON_NEAR_CLIP_DEPTH) {
            // 尾側だけが手前。深度が閾値になる位置まで先端側へ寄せる。
            // 尾側の不透明度はもともと 0 なので、切り口は生まれない
            const t = (depthHead - RIBBON_NEAR_CLIP_DEPTH) / (depthHead - depthTail)
            tail.lerpVectors(head, tail, Math.min(1, Math.max(0, t)))
          }

          // 幅を向ける先。進行方向と視線の両方に直交させる
          along.subVectors(head, tail)
          if (along.lengthSq() < 1e-8) continue
          toCamera.subVectors(cameraPosition, head)
          side.crossVectors(along, toCamera)
          if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
          side.normalize()

          // 先端の明るさは深度の帯で滅衰させる。閾値をまたぐ瞬間の飛び出しを消す
          const fade = Math.min(1, (depthHead - RIBBON_NEAR_CLIP_DEPTH) / FADE_BAND)
          // 幅は画面基準。深度に比例させれば、遠くても近くても同じ太さに出る
          const halfHead = depthHead * radiansPerPixel * HALF_WIDTH_PX
          const halfTail =
            Math.max(
              RIBBON_NEAR_CLIP_DEPTH,
              depthOf(tail, cameraPosition, cameraForward),
            ) *
            radiansPerPixel *
            HALF_WIDTH_PX

          const base = count * VERTS_PER_TRACER
          writePoint(base, tail, halfTail, 0)
          writePoint(base + 3, head, halfHead, fade)
          count++
        }
      }

      drawn = count
      position.needsUpdate = true
      color.needsUpdate = true
      geometry.setDrawRange(0, count * INDICES_PER_TRACER)
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
