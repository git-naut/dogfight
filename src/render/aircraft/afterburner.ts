import * as THREE from 'three'

/**
 * アフターバーナーの炎。
 *
 * **原本に炎が無いので自前で描く。**F/A-18C（FlightGear）は `ExternalFlame`
 * という板を持っていたが、F/A-18E（Sketchfab）には何も付いていない。C 型の
 * 板を glb ごと移す実装を書いて実測したが、three が読み込んでも 1 画素も
 * 描かれなかった。位置だけ glb の `extras.nozzles` から受け取り、形と色は
 * ここで作る。
 *
 * ## 2 層で描く
 *
 * **加算合成 1 枚では昼間に白く飛ぶ。**最初は加算だけで作ったが、明るい地形や
 * 空を背景にすると足した色が 1.0 を越えて飽和し、赤黄ではなく白い筋になった
 * （AgX のトーンマップが高輝度を白へ寄せる）。層を分ける。
 *
 * | 層 | 合成 | 長さ | 役割 |
 * |---|---|---|---|
 * | 内炎 | 通常 | ノズル半径の 7 倍 | 色をはっきり出す。背景に影響されない |
 * | 外炎 | 加算 | 同 13 倍 | 発光の滲み。背景へ溶ける |
 *
 * 内炎が形と色を決め、外炎が光を足す。順に描くため内炎の `renderOrder` を
 * 小さくする。**どちらも深度を書かない**ので、機体には隠れ、空には重なる。
 *
 * ## 色
 *
 * 長さ方向に赤黄のグラデーションを頂点カラーで置く。根元がいちばん熱くて黄、
 * 中ほどで橙、先端で赤に落ちて消える。実機の色の並びと同じ向き。
 *
 * **明るさは露出で決まる。**色の値は露出前の線形値で、トーンマップの中で
 * 6 倍される。露出後に 3 成分とも 1 を越えると AgX が白へ寄せるので、赤だけが
 * 越える帯（露出前 0.26 前後）に置く。
 *
 * ## 強さ
 *
 * スロットルが `AUGMENTATION_THROTTLE` を超えた分を 0..1 に写し、長さと
 * 不透明度に掛ける。**材質は自機ごとに作る**ので、標的機のスロットルと
 * 混ざらない。
 */

/** ノズルの定義。glb の `scenes[0].extras.nozzles` から来る */
export interface Nozzle {
  /** ノズル面の中心。機体座標 */
  readonly position: readonly [number, number, number]
  /** 口の半径 m */
  readonly radius: number
}

export interface Afterburner {
  readonly object: THREE.Object3D
  /** 0..1。0 なら消える */
  setStrength(value: number): void
  dispose(): void
}

/** 円周の分割。**16 で足りる。**追従カメラから見える幅は 30 画素ほど */
const SEGMENTS = 16
/** 長さの分割。色の段を作るので粗くしない */
const RINGS = 14

interface Stop {
  at: number
  /** 線形の RGB。**sRGB の 16 進では書かない**（変換の分だけ色が動く） */
  rgb: readonly [number, number, number]
  alpha: number
}

interface Layer {
  /** 長さ。ノズル半径の何倍か */
  length: number
  /** 根元の太さ。ノズル半径の何倍か */
  mouth: number
  /** 先端の細さ */
  tip: number
  stops: readonly Stop[]
}

/**
 * 内炎。色をはっきり出す層。
 *
 * **値は露出前の線形値。**`RenderPipeline` はトーンマップの中で露出 6 倍を
 * 掛ける（`docs/decisions/0011-post-processing.md`）ので、露出後に 1.0 を
 * 狙うなら 0.167 前後に置く。最初 (1.0, 0.88, 0.55) と書いて実測したら
 * 画素が (249, 224, 192) になった。**3 成分とも飽和して白い筋**にしかならない。
 *
 * いまの並びは露出後に 赤 1.6 / 緑 0.9 / 青 0.3 から始まる。赤だけが 1 を
 * 越えるので、AgX を通ると芯が黄橙、外へ向かって橙から赤へ落ちる。
 */
const INNER: Layer = {
  length: 7,
  mouth: 0.92,
  tip: 0.12,
  stops: [
    { at: 0.0, rgb: [0.26, 0.07, 0.01], alpha: 1.0 },
    { at: 0.16, rgb: [0.24, 0.045, 0.004], alpha: 0.98 },
    { at: 0.4, rgb: [0.21, 0.022, 0.001], alpha: 0.88 },
    { at: 0.65, rgb: [0.15, 0.009, 0.0], alpha: 0.58 },
    { at: 0.85, rgb: [0.085, 0.003, 0.0], alpha: 0.24 },
    { at: 1.0, rgb: [0.04, 0.001, 0.0], alpha: 0.0 },
  ],
}

/** 外炎。光を足す層。加算なので内炎よりさらに弱く置く */
const OUTER: Layer = {
  length: 13,
  mouth: 1.25,
  tip: 0.2,
  stops: [
    { at: 0.0, rgb: [0.07, 0.014, 0.002], alpha: 1.0 },
    { at: 0.28, rgb: [0.05, 0.006, 0.0005], alpha: 1.0 },
    { at: 0.55, rgb: [0.025, 0.002, 0.0], alpha: 1.0 },
    { at: 1.0, rgb: [0.0, 0.0, 0.0], alpha: 1.0 },
  ],
}

/** 位置 t の色と不透明度を線形に取る */
function sample(stops: readonly Stop[], t: number): { rgb: [number, number, number]; alpha: number } {
  let lo = stops[0]!
  let hi = stops[stops.length - 1]!
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i]!.at) {
      lo = stops[i - 1]!
      hi = stops[i]!
      break
    }
  }
  const span = hi.at - lo.at
  const k = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - lo.at) / span))
  return {
    rgb: [
      lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k,
      lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k,
      lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k,
    ],
    alpha: lo.alpha + (hi.alpha - lo.alpha) * k,
  }
}

/**
 * 1 本の円錐を作る。
 *
 * **`ConeGeometry` は使わない。**あちらは側面を長さで割る輪の構造を持たず、
 * 先端が 1 点に潰れる。ここでは輪を `RINGS` 段重ねて、段ごとに色を変える。
 *
 * 色は 4 成分で置く。通常合成の層は 4 成分目が背景と混ぜる比、加算の層は
 * 足す光の量なので色へ畳み込む。
 */
function buildLayerGeometry(radius: number, layer: Layer, additive: boolean): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  const length = radius * layer.length
  for (let ring = 0; ring <= RINGS; ring++) {
    const t = ring / RINGS
    const { rgb, alpha } = sample(layer.stops, t)
    // 根元からわずかに膨らんでから細る。t = 0.15 あたりが最も太い
    const bulge = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5)
    const r = radius * (layer.mouth + (layer.tip - layer.mouth) * t) * (0.84 + bulge * 0.16)
    for (let seg = 0; seg <= SEGMENTS; seg++) {
      const a = (seg / SEGMENTS) * Math.PI * 2
      positions.push(Math.cos(a) * r, Math.sin(a) * r, t * length)
      // 加算の層は「足す光の量」なので不透明度を色へ畳み込む。通常合成の層は
      // 背景と混ぜる比なので、4 成分目として渡す
      if (additive) colors.push(rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, 1)
      else colors.push(rgb[0], rgb[1], rgb[2], alpha)
    }
  }
  const stride = SEGMENTS + 1
  for (let ring = 0; ring < RINGS; ring++) {
    for (let seg = 0; seg < SEGMENTS; seg++) {
      const a = ring * stride + seg
      const b = a + 1
      const c = a + stride
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  // **4 成分で渡す。**three は `color` が itemSize 4 のとき `USE_COLOR_ALPHA` を
  // 立てて不透明度も頂点から読む。3 成分だと色を暗くするしかなく、通常合成の
  // 層で先端が「黒い筋」になる
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * ノズルの数だけ炎を作る。
 *
 * @param nozzles glb の `extras.nozzles`。空なら何も描かない器を返す
 */
export function createAfterburner(nozzles: readonly Nozzle[]): Afterburner {
  const group = new THREE.Group()
  group.name = 'afterburner'
  group.visible = false

  const base = {
    vertexColors: true,
    transparent: true,
    // **深度は読むが書かない。**書くと左右のノズルが重なる角度で片方が消える
    depthWrite: false,
    side: THREE.DoubleSide,
  } as const

  const innerMaterial = new THREE.MeshBasicMaterial({ ...base, blending: THREE.NormalBlending })
  const outerMaterial = new THREE.MeshBasicMaterial({ ...base, blending: THREE.AdditiveBlending })

  const geometries: THREE.BufferGeometry[] = []
  for (const nozzle of nozzles) {
    for (const [i, layer] of [INNER, OUTER].entries()) {
      const geometry = buildLayerGeometry(nozzle.radius, layer, i === 1)
      geometries.push(geometry)
      const mesh = new THREE.Mesh(geometry, i === 0 ? innerMaterial : outerMaterial)
      mesh.position.set(nozzle.position[0], nozzle.position[1], nozzle.position[2])
      // 内炎を先に置く。加算の外炎はその上から光を足す
      mesh.renderOrder = i
      // 追従カメラは機体の後方 23 m。視錐台で捨てられると炎が消える
      mesh.frustumCulled = false
      group.add(mesh)
    }
  }

  return {
    object: group,

    setStrength(value) {
      const t = Math.min(1, Math.max(0, value))
      group.visible = t > 0
      if (t <= 0) return
      // 点火してすぐは短く、全開で伸びる
      const length = 0.5 + t * 0.5
      for (const child of group.children) child.scale.set(1, 1, length)
      innerMaterial.opacity = 0.75 + t * 0.25
      outerMaterial.opacity = 0.5 + t * 0.5
    },

    dispose() {
      for (const geometry of geometries) geometry.dispose()
      innerMaterial.dispose()
      outerMaterial.dispose()
    },
  }
}
