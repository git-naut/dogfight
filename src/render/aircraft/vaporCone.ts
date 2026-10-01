import * as THREE from 'three'

/**
 * ベイパーコーン（段 30f）。**音速の近くで機体を包む白い円錐の膜。**
 *
 * 遷音速で主翼の上に衝撃波が立ち、その後ろで圧力と温度が急に下がって水蒸気が
 * 凝結する。主翼のあたりを底にして機首の方へすぼむ、白い膜に見える。マッハ 0.9
 * 前後で現れ、超音速へ抜けると消える。
 *
 * 機体の座標に付ける（F/A-18E。主翼の後縁は z 2 前後、補助翼の蝶番が x ±6.44、
 * キャノピーは z −6〜−4）。濃さは底の少し手前で最も強く、機首の方と底の外側で 0 へ落とす
 */
export const VAPOR = {
  /** 底（主翼のあたり）と先（機体の中ほど）の z と半径 m。機首は −Z */
  baseZ: 1.5,
  baseRadius: 4.5,
  tipZ: -3,
  tipRadius: 1.2,
  /** 膜の中心の高さ m */
  y: 0.4,
  /** いちばん濃い所の不透明度 */
  opacity: 0.3,
  rings: 24,
  segments: 32,
}

/**
 * マッハ数に対する濃さ 0..1。0.88 から現れて 0.95 で最大、1.02〜1.1 で消える
 */
export function vaporStrength(mach: number): number {
  return smooth(0.88, 0.95, mach) * (1 - smooth(1.02, 1.1, mach))
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface VaporCone {
  readonly object: THREE.Object3D
  /**
   * 0..1。0 なら隠す。
   *
   * @param seconds 描画の時刻（`frame × FIXED_DT`）。模様を流す位相（node 経路）
   */
  setStrength(value: number, seconds?: number): void
  dispose(): void
}

/**
 * ベイパーコーンの材質。**node 経路は差し替える**（`vaporNodes.ts`、ノイズで雲や靄の
 * ように揺らす）。既定は頂点の色で濃さを置いた滑らかな膜（GLSL 経路）
 */
export interface VaporMaterial {
  readonly material: THREE.Material
  /** 濃さ 0..1 と描画の時刻を渡す */
  setState(strength: number, seconds: number): void
}

export type VaporMaterialFactory = () => VaporMaterial

export function createGlVaporMaterial(): VaporMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  return {
    material,
    setState(strength) {
      material.opacity = VAPOR.opacity * strength
    },
  }
}

export function createVaporCone(makeMaterial: VaporMaterialFactory = createGlVaporMaterial): VaporCone {
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let ring = 0; ring <= VAPOR.rings; ring++) {
    // t = 0 が先（機首側）、1 が底（主翼側）
    const t = ring / VAPOR.rings
    const z = VAPOR.tipZ + (VAPOR.baseZ - VAPOR.tipZ) * t
    const r = VAPOR.tipRadius + (VAPOR.baseRadius - VAPOR.tipRadius) * t
    // 底の少し手前（t 0.8）で最も濃く、底と先へ柔らかく落とす。**底の縁で最大にすると
    // 外周が硬い円になり、白い泡に見えた**（試作）
    const alpha = smooth(0.25, 0.8, t) * (1 - smooth(0.8, 1, t))
    for (let seg = 0; seg <= VAPOR.segments; seg++) {
      const a = (seg / VAPOR.segments) * Math.PI * 2
      positions.push(Math.cos(a) * r, VAPOR.y + Math.sin(a) * r, z)
      // 円周の向きで濃さを揺らし、筋状のむらを付ける。一様な膜は泡に見える
      const streak = 0.55 + 0.45 * Math.abs(Math.sin(5 * a + 1) * Math.sin(3 * a + 2.3))
      colors.push(1, 1, 1, alpha * streak)
      // u は円周（0..1）、v は長さ（先 0、底 1）。node 経路のノイズが読む
      uvs.push(seg / VAPOR.segments, t)
    }
  }
  const stride = VAPOR.segments + 1
  for (let ring = 0; ring < VAPOR.rings; ring++) {
    for (let seg = 0; seg < VAPOR.segments; seg++) {
      const a = ring * stride + seg
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()

  const made = makeMaterial()
  const material = made.material
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'vapor-cone'
  mesh.frustumCulled = false
  mesh.visible = false
  // 機体の後、炎（0〜1）より先
  mesh.renderOrder = -1

  return {
    object: mesh,
    setStrength(value, seconds = 0) {
      const v = Math.min(1, Math.max(0, value))
      mesh.visible = v > 0
      made.setState(v, seconds)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
