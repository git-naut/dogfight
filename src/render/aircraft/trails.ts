import * as THREE from 'three'
import { FIXED_DT } from '../../sim/loop'
import { TRAIL_LENGTH, TRAIL_STRIDE, type TrailSource } from '../../sim/aircraft'
import { CONTRAIL_TEMPERATURE, temperature } from '../../sim/isa'
import type { QualitySettings } from '../quality'

/**
 * コントレイルと翼端渦。
 *
 * 履歴は sim が持つ（`Aircraft` のリングバッファ）。ここは読んでリボンを
 * 張るだけ。描画側にバッファを置くと、キャプチャモードは `sync` が 1 回しか
 * 走らないので何も出ない。
 *
 * リボンはカメラへ向けて立てる。翼端渦を機体上方向で立てると、真後ろから
 * 見たときに線に潰れて消える。進行方向と視線の両方に直交する向きを取れば、
 * どこから見ても幅が残る。
 *
 * 1 点につき頂点を 3 個置く。左端・中心・右端で、濃さは端が 0、中心が最大。
 * 端も中心も同じ濃さにすると縁の硬い帯になり、水蒸気に見えない。
 *
 * 出る条件は物理から決める。翼端渦は荷重倍数、コントレイルは気温。
 * どちらもフレーム番号から決まる sim の状態だけを読むので決定論が保たれる。
 *
 * 濃さと太さは経過秒で決める。履歴の何本目かで決めると、品質プリセットで
 * 本数を変えたときに絵そのものが変わってしまう。秒で決めれば、段を落とした
 * ときに変わるのは長さだけになる。
 *
 * 画面に出るのは実測で 1 秒弱・270 m ほど。追従カメラが機体のすぐ後ろに
 * いるので、それより古い点は視錐台の外へ出る（`trailSegments` を 320 と
 * 48 にしても画素が 1 ビットも違わない）。だから軌跡は薄れて消えるのでは
 * なく画面の縁で切れる。長さの余裕はそれを保証するために持たせている。
 */

/** 履歴 1 本ぶんの秒数。sim が TRAIL_STRIDE ステップごとに記録する */
const SECONDS_PER_POINT = TRAIL_STRIDE * FIXED_DT

/**
 * 翼端渦の濃さを決める揚力係数の範囲。
 *
 * 最初は荷重倍数で決めていたが、実測すると台本の当たり外れが出た。旋回は
 * 3.0〜3.3 G までしか出ないので閾値 3.5 に届かず**旋回でまったく渦が
 * 出ない**。逆に島へ向かう高速の引き起こしは 3.3 G で閾値近くまで来る。
 *
 * 揚力係数で見ると逆転する。旋回（速度 204〜254 m/s）は 0.47〜0.69、
 * 高速の引き起こし（速度 390 m/s）は 0.15〜0.17、水平飛行は 0.05。
 * 渦の芯の圧力低下は循環の二乗に比例し、循環は揚力係数に比例するので、
 * こちらが物理的にも正しい。遅くて迎角の高い旋回でよく出る、という
 * 実機の映像とも合う。
 */
const VORTEX_CL_START = 0.3
const VORTEX_CL_FULL = 0.8

/** 翼端渦を出す位置。翼幅 11.571 m の少し内側 */
const WINGTIP_OFFSET = 5.6

/**
 * リボンの半幅 m。生まれたばかりの根元の値。
 *
 * 幅の中心が最も濃く、縁で 0 になる。だから見た目の太さは半幅より細い。
 * 0.18 の一様な帯より、0.30 の中心が濃い帯のほうが淡く見える。
 */
const VORTEX_HALF_WIDTH = 0.3
const CONTRAIL_HALF_WIDTH = 1.4

/**
 * 1 秒あたり何倍に広がるか、と広がりの上限。
 *
 * 渦は乱流で拡散して太くなる。以前は履歴の何本目かに比例させていたので、
 * 描く本数を変えると同じ形のまま伸び縮みした。秒あたりに変えて、上限で
 * 頭打ちにする。0.35/秒・上限 4 倍なので 8.6 秒で太り切る。
 */
const SPREAD_PER_SECOND = 0.35
const SPREAD_LIMIT = 4

/**
 * 濃さの上限。
 *
 * 1 画素ぶんの濃さがそのまま見た目になるわけではない。リボンは後方へ
 * 伸びるので、追従カメラからはほぼ真横ではなく長手方向に見る。1 本の視線が
 * 何区間も貫くため、実測で 5 枚ぶん重なっていた。0.22 でも空との差が
 * 95 階調あって白い筋に見える。0.10 で 71 階調。
 *
 * さらに 0.028 へ。同じ断面（pull-up の frame 430、y=650）で空との差を
 * 測ると 28.7 → 12.7 階調、断面の積分は 1989 → 976。濃さを半分にしても
 * 見た目が半分にならないのは、重なった層の合成が飽和するため。
 */
const VORTEX_OPACITY = 0.028
const CONTRAIL_OPACITY = 0.12

/**
 * 消えるまでの秒数。
 *
 * 実機の翼端渦は数秒から十数秒で拡散して見えなくなる。コントレイルは
 * 分単位で残るが、履歴が 12.8 秒しかないので終端は下の先細りが処理する。
 */
const VORTEX_LIFETIME = 16
const CONTRAIL_LIFETIME = 90

/**
 * 減衰を始めるまでの割合。
 *
 * ここまでは濃さを保ち、そこから寿命まで滑らかに 0 へ落とす。
 *
 * 以前は履歴の何本目かに対して二乗で落としていた。描く本数を 96 に
 * 制限していたので、画面に映る範囲で 3 割ほど薄くなり、軌跡が空中で
 * 尻すぼみに消えた。秒で測って手前を保たせると、薄れて消えるのではなく
 * 画面の縁で切れる。
 */
export const TRAIL_DECAY_HOLD = 0.15

/**
 * 終端を先細りさせる本数。
 *
 * 品質プリセットが履歴を途中で打ち切ると、そこで濃さが残ったまま切れる。
 * 旋回して軌跡が視界へ回り込むと切り口が見えるので、末尾だけ 0 へ落とす。
 * 1.07 秒ぶん。
 */
const TAPER_POINTS = 32

export interface AircraftTrails {
  readonly object: THREE.Object3D
  /**
   * 履歴からリボンを張り直す。毎フレーム呼ぶ。
   *
   * @param cameraPosition リボンを向ける先
   */
  update(source: TrailSource, cameraPosition: THREE.Vector3): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: AircraftTrails = {
  object: new THREE.Group(),
  update() {},
  setQuality() {},
  dispose() {},
}

/** リボン 1 本 */
interface Ribbon {
  geometry: THREE.BufferGeometry
  position: THREE.BufferAttribute
  color: THREE.BufferAttribute
  /** 翼端のずらし量。0 なら機体の中心 */
  offset: number
  kind: 'vortex' | 'contrail'
}

export function createAircraftTrails(quality: QualitySettings): AircraftTrails {
  let segments = quality.trailSegments
  if (segments === 0) return NOT_ENABLED

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    // 奥行きは書かない。リボンどうしが順序で欠けるのを避ける
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: true,
  })

  const group = new THREE.Group()
  // リボンは機体の後ろに伸びる。視錐台で捨てられると消える
  group.frustumCulled = false

  const ribbons: Ribbon[] = [
    { ...createRibbon(), offset: -WINGTIP_OFFSET, kind: 'vortex' },
    { ...createRibbon(), offset: WINGTIP_OFFSET, kind: 'vortex' },
    { ...createRibbon(), offset: 0, kind: 'contrail' },
  ]
  for (const ribbon of ribbons) {
    const mesh = new THREE.Mesh(ribbon.geometry, material)
    mesh.frustumCulled = false
    group.add(mesh)
  }

  // 使い回す。毎フレーム作るとゴミが増える
  const point = new THREE.Vector3()
  const next = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const toCamera = new THREE.Vector3()
  const side = new THREE.Vector3()

  function writeRibbon(
    ribbon: Ribbon,
    source: TrailSource,
    cameraPosition: THREE.Vector3,
    count: number,
  ): void {
    const halfWidth =
      ribbon.kind === 'vortex' ? VORTEX_HALF_WIDTH : CONTRAIL_HALF_WIDTH

    for (let i = 0; i < count; i++) {
      const current = source.trailPoint(i)
      const following = source.trailPoint(Math.min(i + 1, count - 1))

      point
        .set(current.position.x, current.position.y, current.position.z)
        .addScaledVector(
          side.set(current.right.x, current.right.y, current.right.z),
          ribbon.offset,
        )
      next
        .set(following.position.x, following.position.y, following.position.z)
        .addScaledVector(
          tangent.set(following.right.x, following.right.y, following.right.z),
          ribbon.offset,
        )

      tangent.subVectors(next, point)
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1)
      toCamera.subVectors(cameraPosition, point)
      // 進行方向と視線の両方に直交する向き。どこから見ても幅が残る
      side.crossVectors(tangent, toCamera)
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
      side.normalize()

      const age = i * SECONDS_PER_POINT
      const width =
        halfWidth * Math.min(SPREAD_LIMIT, 1 + age * SPREAD_PER_SECOND)

      const isVortex = ribbon.kind === 'vortex'
      const strength = isVortex
        ? vortexStrength(current.liftCoefficient) * VORTEX_OPACITY
        : contrailStrength(current.altitude, current.throttle) * CONTRAIL_OPACITY
      const lifetime = isVortex ? VORTEX_LIFETIME : CONTRAIL_LIFETIME
      // 履歴の末尾で切れないよう、描く本数の最後だけ 0 へ落とす
      const taper = Math.min(1, (count - 1 - i) / TAPER_POINTS)
      const alpha = strength * trailDecay(age / lifetime) * taper

      const base = i * 3
      ribbon.position.setXYZ(
        base,
        point.x - side.x * width,
        point.y - side.y * width,
        point.z - side.z * width,
      )
      ribbon.position.setXYZ(base + 1, point.x, point.y, point.z)
      ribbon.position.setXYZ(
        base + 2,
        point.x + side.x * width,
        point.y + side.y * width,
        point.z + side.z * width,
      )
      // 縁は透明、中心が最大。硬い帯にしない
      ribbon.color.setXYZW(base, 1, 1, 1, 0)
      ribbon.color.setXYZW(base + 1, 1, 1, 1, alpha)
      ribbon.color.setXYZW(base + 2, 1, 1, 1, 0)
    }

    ribbon.position.needsUpdate = true
    ribbon.color.needsUpdate = true
    // 使う三角形だけ描く。点が足りないうちは短く。1 区間あたり 4 枚
    ribbon.geometry.setDrawRange(0, Math.max(0, count - 1) * 12)
  }

  return {
    object: group,

    update(source, cameraPosition) {
      const count = Math.min(source.trailLength, segments)
      if (count < 2) {
        for (const ribbon of ribbons) ribbon.geometry.setDrawRange(0, 0)
        return
      }
      for (const ribbon of ribbons) writeRibbon(ribbon, source, cameraPosition, count)
    },

    setQuality(next) {
      segments = next.trailSegments
      group.visible = segments > 0
    },

    dispose() {
      for (const ribbon of ribbons) ribbon.geometry.dispose()
      material.dispose()
    },
  }
}

/**
 * 経過の割合 0..1 から濃さの倍率を返す。
 *
 * TRAIL_DECAY_HOLD までは 1 のまま、そこから smoothstep で 0 へ。
 */
export function trailDecay(t: number): number {
  if (t <= TRAIL_DECAY_HOLD) return 1
  if (t >= 1) return 0
  const u = (t - TRAIL_DECAY_HOLD) / (1 - TRAIL_DECAY_HOLD)
  return 1 - u * u * (3 - 2 * u)
}

/**
 * 翼端渦の濃さ 0..1。
 *
 * 翼端で巻き上がる渦の中心は圧力が下がり、断熱膨張で温度が下がって
 * 水蒸気が凝結する。圧力低下は循環の二乗に比例し、循環は揚力係数に
 * 比例するので、揚力係数をそのまま濃さに使う。
 */
export function vortexStrength(cl: number): number {
  const t = (Math.abs(cl) - VORTEX_CL_START) / (VORTEX_CL_FULL - VORTEX_CL_START)
  return Math.min(1, Math.max(0, t))
}

/**
 * コントレイルの濃さ 0..1。
 *
 * 排気の水蒸気が氷晶になる気温より上でしか出ない。ISA だと高度 8,460 m より
 * 上。この機体の実用高度では滅多に出ないが、物理をそのまま入れてある。
 */
function contrailStrength(altitude: number, throttle: number): number {
  if (temperature(altitude) >= CONTRAIL_TEMPERATURE) return 0
  return Math.min(1, Math.max(0, throttle))
}

/**
 * 3 × TRAIL_LENGTH 頂点のリボン。毎フレーム位置と色だけ書き換える。
 *
 * 1 点につき 左端・中心・右端 の 3 個。区間ごとに 2 枚の帯（左半分と右半分）を
 * 張るので三角形は 4 枚。
 */
function createRibbon(): {
  geometry: THREE.BufferGeometry
  position: THREE.BufferAttribute
  color: THREE.BufferAttribute
} {
  const vertices = TRAIL_LENGTH * 3
  const position = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3)
  const color = new THREE.BufferAttribute(new Float32Array(vertices * 4), 4)
  position.setUsage(THREE.DynamicDrawUsage)
  color.setUsage(THREE.DynamicDrawUsage)

  const index = new Uint16Array((TRAIL_LENGTH - 1) * 12)
  for (let i = 0; i < TRAIL_LENGTH - 1; i++) {
    const a = i * 3
    const b = a + 3
    const o = i * 12
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
  return { geometry, position, color }
}
