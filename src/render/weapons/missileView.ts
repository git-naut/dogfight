import * as THREE from 'three'
import { MISSILE_DIAMETER, MISSILE_LENGTH } from '../../sim/weapons/missile'
import { PYLON_OFFSETS, type Launcher } from '../../sim/combat'

/**
 * ミサイルの本体。
 *
 * glb は調達しない。円錐と円柱と翼板を自前で組む。**画面に出るのは
 * 数十画素なので、形の細かさに意味がない。**全長 2.85 m の弾体は 500 m
 * 先だと実測の画角（垂直 66.4 度 / 720 画素）で 4 画素にしかならない。
 * 見えるのは発射直後の数百ミリ秒だけで、そこでは煙のほうが目を引く。
 *
 * 三角形は 1 発あたり 100 前後。6 発で 600。地形 45 万に対して無視できる。
 *
 * 機首は −Z。`Missile.orientation` が速度の向きへ機首を合わせるので、
 * ここは姿勢をそのまま入れるだけ。
 */

/** 弾体の分割数。少なくてよい */
const RADIAL = 8
/** 弾頭の長さの割合 */
const NOSE_FRACTION = 0.18
/** 尾翼の張り出し。直径に対する倍率 */
const FIN_SPAN = 2.2

export interface MissileViews {
  readonly object: THREE.Object3D
  /** 描いた本数 */
  readonly drawn: number
  /** 三角形の総数。予算の確認に使う */
  readonly triangles: number
  /**
   * 飛んでいるミサイルの位置と姿勢を反映する。
   *
   * 渡された数だけ見せ、余りは隠す。
   */
  update(
    poses: readonly { position: THREE.Vector3; quaternion: THREE.Quaternion }[],
  ): void
  dispose(): void
}

/** 弾体 1 発ぶんのジオメトリを組む。原点は重心、機首が −Z */
function createBodyGeometry(): THREE.BufferGeometry {
  const radius = MISSILE_DIAMETER / 2
  const noseLength = MISSILE_LENGTH * NOSE_FRACTION
  const bodyLength = MISSILE_LENGTH - noseLength

  // 円柱。three の CylinderGeometry は Y 軸なので Z 軸へ倒す
  const body = new THREE.CylinderGeometry(radius, radius, bodyLength, RADIAL, 1, true)
  body.rotateX(Math.PI / 2)
  // 機首側が −Z。円柱の中心を後ろへずらす
  body.translate(0, 0, MISSILE_LENGTH / 2 - bodyLength / 2)

  const nose = new THREE.ConeGeometry(radius, noseLength, RADIAL, 1, true)
  nose.rotateX(-Math.PI / 2)
  nose.translate(0, 0, -MISSILE_LENGTH / 2 + noseLength / 2)

  // 尾翼。薄い板を 4 枚
  const finGeometries: THREE.BufferGeometry[] = []
  const finSpan = radius * FIN_SPAN
  const finChord = MISSILE_LENGTH * 0.16
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.PlaneGeometry(finSpan, finChord)
    fin.rotateX(Math.PI / 2)
    fin.rotateZ((i * Math.PI) / 2)
    fin.translate(0, 0, MISSILE_LENGTH / 2 - finChord / 2)
    finGeometries.push(fin)
  }

  const merged = mergeGeometries([body, nose, ...finGeometries])
  for (const g of [body, nose, ...finGeometries]) g.dispose()
  return merged
}

/**
 * 位置属性だけを連結する。
 *
 * three の `BufferGeometryUtils` を読むと、そのぶんバンドルが増える。ここで
 * 要るのは位置と法線だけなので自分で足す。
 */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  for (const part of parts) {
    const nonIndexed = part.index === null ? part : part.toNonIndexed()
    const position = nonIndexed.getAttribute('position')
    const normal = nonIndexed.getAttribute('normal')
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i))
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i))
    }
    if (nonIndexed !== part) nonIndexed.dispose()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  return geometry
}

/**
 * 弾体の材質。飛んでいるミサイルと吊るしたミサイルで同じ見た目にする。
 *
 * 機体と同じ物理ベースの材質。空の環境反射が効く。AC3D の spec を金属度にすると鏡になるという
 * Phase 4 の教訓があるので、ここも誘電体寄りにしておく
 */
function createMissileMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xb9bcc0,
    roughness: 0.55,
    metalness: 0.15,
  })
}

export function createMissileViews(capacity: number): MissileViews {
  const geometry = createBodyGeometry()
  const triangleCount = geometry.getAttribute('position').count / 3

  const material = createMissileMaterial()

  const group = new THREE.Group()
  group.frustumCulled = false

  const instances: THREE.Mesh[] = []
  let drawn = 0

  function instance(index: number): THREE.Mesh {
    const existing = instances[index]
    if (existing !== undefined) return existing
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.visible = false
    instances[index] = mesh
    group.add(mesh)
    return mesh
  }

  return {
    object: group,

    get drawn() {
      return drawn
    },

    get triangles() {
      return triangleCount * drawn
    },

    update(poses) {
      const used = Math.min(poses.length, capacity)
      for (let i = 0; i < used; i++) {
        const pose = poses[i]!
        const mesh = instance(i)
        mesh.position.copy(pose.position)
        mesh.quaternion.copy(pose.quaternion)
        mesh.visible = true
      }
      for (let i = used; i < instances.length; i++) instances[i]!.visible = false
      drawn = used
    },

    dispose() {
      geometry.dispose()
      material.dispose()
      group.clear()
      instances.length = 0
    },
  }
}

/** 吊るしたミサイル（段 B9） */
export interface HungMissiles {
  /** 自機の物体の子に付ける。位置は機体の座標 */
  readonly object: THREE.Object3D
  /** 見せている本数 */
  readonly shown: number
  /** 発射機の状態を写す。満ちている側だけ見せる */
  update(launchers: readonly Launcher[]): void
  dispose(): void
}

/**
 * 左右の発射機に吊るしたミサイル（段 B9、ADR 0034）。
 *
 * 録画（lesson 5 のコマ 20019〜20040）は、翼の付け根の下にミサイルを吊るし、撃った 1 発だけが
 * 消える。満ちたあと戻るかは録画で見分けられず、兵装の欄の印が満ちるのに合わせて戻す（推測、
 * ユーザーの決定）。位置は sim が放つ点（`PYLON_OFFSETS`）と同じなので、撃ったフレームに吊るした
 * 弾体が消え、同じ所から飛ぶ弾体に替わる
 */
export function createHungMissiles(): HungMissiles {
  const geometry = createBodyGeometry()
  const material = createMissileMaterial()
  const group = new THREE.Group()
  const meshes = PYLON_OFFSETS.map((offset) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(offset.x, offset.y, offset.z)
    group.add(mesh)
    return mesh
  })
  let shown = meshes.length

  return {
    object: group,

    get shown() {
      return shown
    },

    update(launchers) {
      shown = 0
      for (let side = 0; side < meshes.length; side++) {
        const launcher = launchers[side]
        const visible = launcher === undefined || (!launcher.empty && launcher.progress >= 1)
        meshes[side]!.visible = visible
        if (visible) shown++
      }
    },

    dispose() {
      geometry.dispose()
      material.dispose()
      group.clear()
    },
  }
}
