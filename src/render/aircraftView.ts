import * as THREE from 'three'

/**
 * 機体のプレースホルダ。
 *
 * 実機モデルは Phase 4 で NASA 3D Resources から取り込む。ここでは
 * 姿勢が読み取れる最小限の形を組む。円錐ひとつだとロールもピッチも
 * 見分けがつかず、飛行モデルの検証にならない。
 *
 * 機首は -Z、上は +Y（CLAUDE.md の座標系規約）。
 */

const BODY_COLOR = 0x9fb0bd
const ACCENT_COLOR = 0x2c3a46
const EXHAUST_COLOR = 0xff8a3d

export interface AircraftView {
  readonly object: THREE.Object3D
  /** アフターバーナーの強さ 0..1 */
  setThrottle(value: number): void
  dispose(): void
}

export function createAircraftView(): AircraftView {
  const group = new THREE.Group()
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = []

  const skin = new THREE.MeshStandardMaterial({
    color: BODY_COLOR,
    roughness: 0.42,
    metalness: 0.65,
  })
  const accent = new THREE.MeshStandardMaterial({
    color: ACCENT_COLOR,
    roughness: 0.6,
    metalness: 0.3,
  })
  disposables.push(skin, accent)

  // 胴体。前後に伸ばした八角柱
  const fuselage = new THREE.CylinderGeometry(0.75, 1.05, 12, 8)
  fuselage.rotateX(-Math.PI / 2)
  const fuselageMesh = new THREE.Mesh(fuselage, skin)
  fuselageMesh.position.z = 0.5
  group.add(fuselageMesh)
  disposables.push(fuselage)

  // 機首
  const nose = new THREE.ConeGeometry(0.75, 5, 8)
  nose.rotateX(-Math.PI / 2)
  const noseMesh = new THREE.Mesh(nose, skin)
  noseMesh.position.z = -8
  group.add(noseMesh)
  disposables.push(nose)

  // キャノピー。前後の向きを見分ける手がかりになる
  const canopy = new THREE.SphereGeometry(0.85, 10, 8)
  canopy.scale(1, 0.7, 2.1)
  const canopyMesh = new THREE.Mesh(canopy, accent)
  canopyMesh.position.set(0, 0.6, -3.2)
  group.add(canopyMesh)
  disposables.push(canopy)

  // デルタ翼。左右それぞれ 2 枚の三角で作る
  const wing = createDeltaWingGeometry()
  const wingMesh = new THREE.Mesh(wing, skin)
  group.add(wingMesh)
  disposables.push(wing)

  // 垂直尾翼
  const fin = createFinGeometry()
  const finMesh = new THREE.Mesh(fin, accent)
  group.add(finMesh)
  disposables.push(fin)

  // 水平尾翼
  const stabilizer = new THREE.BoxGeometry(7.2, 0.16, 1.9)
  const stabilizerMesh = new THREE.Mesh(stabilizer, skin)
  stabilizerMesh.position.set(0, 0.1, 5.4)
  group.add(stabilizerMesh)
  disposables.push(stabilizer)

  // 排気。スロットルに応じて伸びる
  const exhaustMaterial = new THREE.MeshBasicMaterial({
    color: EXHAUST_COLOR,
    transparent: true,
    opacity: 0.85,
  })
  const exhaustGeometry = new THREE.ConeGeometry(0.62, 4, 8, 1, true)
  exhaustGeometry.rotateX(Math.PI / 2)
  const exhaust = new THREE.Mesh(exhaustGeometry, exhaustMaterial)
  exhaust.position.z = 8.5
  group.add(exhaust)
  disposables.push(exhaustGeometry, exhaustMaterial)

  return {
    object: group,

    setThrottle(value: number) {
      const t = Math.min(1, Math.max(0, value))
      // アイドルでは見えず、アフターバーナー域で伸びる
      const stretch = 0.15 + t * t * 1.85
      exhaust.scale.set(0.7 + t * 0.5, 0.7 + t * 0.5, stretch)
      exhaust.position.z = 6.6 + stretch * 1.9
      exhaustMaterial.opacity = 0.25 + t * 0.6
    },

    dispose() {
      for (const item of disposables) item.dispose()
    },
  }
}

/** 左右対称のデルタ翼。前縁が後退した三角形。 */
function createDeltaWingGeometry(): THREE.BufferGeometry {
  const halfSpan = 6.4
  const rootFront = -4.5
  const rootBack = 5.2
  const tipFront = 3.1
  const tipBack = 5.2
  const thickness = 0.13

  const positions: number[] = []

  for (const side of [1, -1]) {
    const tip = halfSpan * side
    // 上面と下面を貼る
    for (const y of [thickness, -thickness]) {
      pushTriangle(
        positions,
        [0, y, rootFront],
        [tip, y, tipFront],
        [tip, y, tipBack],
        side > 0 === y > 0,
      )
      pushTriangle(
        positions,
        [0, y, rootFront],
        [tip, y, tipBack],
        [0, y, rootBack],
        side > 0 === y > 0,
      )
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** 垂直尾翼。後退角のついた板。 */
function createFinGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const thickness = 0.1

  for (const x of [thickness, -thickness]) {
    pushTriangle(
      positions,
      [x, 0.7, 2.0],
      [x, 0.7, 6.4],
      [x, 4.6, 6.4],
      x > 0,
    )
    pushTriangle(
      positions,
      [x, 0.7, 2.0],
      [x, 4.6, 6.4],
      [x, 4.6, 5.0],
      x > 0,
    )
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

type Point = readonly [number, number, number]

/** 三角形を 1 枚積む。flip で表裏の向きを揃える。 */
function pushTriangle(out: number[], a: Point, b: Point, c: Point, flip: boolean): void {
  const order = flip ? [a, b, c] : [a, c, b]
  for (const p of order) out.push(p[0], p[1], p[2])
}
