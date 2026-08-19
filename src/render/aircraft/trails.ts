import * as THREE from 'three'
import { TRAIL_LENGTH, type TrailSource } from '../../sim/aircraft'
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
 * 出る条件は物理から決める。翼端渦は荷重倍数、コントレイルは気温。
 * どちらもフレーム番号から決まる sim の状態だけを読むので決定論が保たれる。
 */

/** 翼端渦が出始める荷重倍数。ここから濃くなる */
const VORTEX_G_START = 3.5
/** 完全に濃くなる荷重倍数 */
const VORTEX_G_FULL = 6.5

/** 翼端渦を出す位置。翼幅 11.571 m の少し内側 */
const WINGTIP_OFFSET = 5.6

/**
 * リボンの半幅 m。根元の値。
 *
 * 0.35 で試したら白い板に見えた。翼端渦は細い筋なので 0.18 まで絞る。
 */
const VORTEX_HALF_WIDTH = 0.18
const CONTRAIL_HALF_WIDTH = 1.0
/** 後ろへ行くほど広がる倍率 */
const SPREAD = 1.6

/**
 * 濃さの上限。
 *
 * 1.0 だと不透明な白になる。実際の渦は向こう側が透けるので抑える。
 */
const VORTEX_OPACITY = 0.55
const CONTRAIL_OPACITY = 0.7

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

      const age = count > 1 ? i / (count - 1) : 0
      const width = halfWidth * (1 + age * SPREAD)

      const strength =
        ribbon.kind === 'vortex'
          ? vortexStrength(current.loadFactor) * VORTEX_OPACITY
          : contrailStrength(current.altitude, current.throttle) * CONTRAIL_OPACITY
      // 後ろへ行くほど薄くなる。二乗で落として尾を細く見せる
      const alpha = strength * (1 - age) * (1 - age)

      const base = i * 2
      ribbon.position.setXYZ(
        base,
        point.x - side.x * width,
        point.y - side.y * width,
        point.z - side.z * width,
      )
      ribbon.position.setXYZ(
        base + 1,
        point.x + side.x * width,
        point.y + side.y * width,
        point.z + side.z * width,
      )
      ribbon.color.setXYZW(base, 1, 1, 1, alpha)
      ribbon.color.setXYZW(base + 1, 1, 1, 1, alpha)
    }

    ribbon.position.needsUpdate = true
    ribbon.color.needsUpdate = true
    // 使う三角形だけ描く。点が足りないうちは短く
    ribbon.geometry.setDrawRange(0, Math.max(0, count - 1) * 6)
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
 * 翼端渦の濃さ 0..1。
 *
 * 高 G で引き起こすと翼端から白い筋が出るのは実機で見える現象。翼端の
 * 渦の中心で圧力が下がり、水蒸気が凝結する。荷重倍数が上がるほど渦が
 * 強くなるので、そのまま濃さに使う。
 */
function vortexStrength(loadFactor: number): number {
  const t = (Math.abs(loadFactor) - VORTEX_G_START) / (VORTEX_G_FULL - VORTEX_G_START)
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

/** 2 × TRAIL_LENGTH 頂点のリボン。毎フレーム位置と色だけ書き換える */
function createRibbon(): {
  geometry: THREE.BufferGeometry
  position: THREE.BufferAttribute
  color: THREE.BufferAttribute
} {
  const vertices = TRAIL_LENGTH * 2
  const position = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3)
  const color = new THREE.BufferAttribute(new Float32Array(vertices * 4), 4)
  position.setUsage(THREE.DynamicDrawUsage)
  color.setUsage(THREE.DynamicDrawUsage)

  const index = new Uint16Array((TRAIL_LENGTH - 1) * 6)
  for (let i = 0; i < TRAIL_LENGTH - 1; i++) {
    const a = i * 2
    const o = i * 6
    index[o] = a
    index[o + 1] = a + 1
    index[o + 2] = a + 2
    index[o + 3] = a + 1
    index[o + 4] = a + 3
    index[o + 5] = a + 2
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', position)
  geometry.setAttribute('color', color)
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.setDrawRange(0, 0)
  return { geometry, position, color }
}
