import * as THREE from 'three'

/**
 * カメラへ向けて立てるリボン。
 *
 * 翼端渦、コントレイル、ミサイルの煙が共通して使う。点の列を受け取り、
 * 1 点につき頂点を 3 個（左端・中心・右端）置いて帯を張る。端も中心も同じ
 * 濃さにすると縁の硬い帯になり、水蒸気にも煙にも見えない。
 *
 * 幅の向きは進行方向と視線の両方に直交させる。機体上方向で立てると、真後ろから
 * 見たときに線に潰れて消える。直交する向きを取ればどこから見ても幅が残る。
 *
 * 濃さと太さは経過秒で決める。履歴の何本目かで決めると、品質プリセットで
 * 描く本数を変えたときに絵そのものが変わってしまう。秒で決めれば、段を
 * 落としたときに変わるのは長さだけになる。
 *
 * **near 面の手前での終端は `update()` が必ず通す。**呼び出し側が選べない形に
 * してある。Phase 4 でこれを 2 度読み違えて、翼端渦の断面をユーザーから
 * 2 度指摘された。新しいリボンを足すたびに同じ罠を踏まないための設計。
 */

/**
 * カメラのこれより手前では打ち切る距離 m。
 *
 * **軌跡が空中で直角に切れる原因はこれだった。**リボンは後方へ伸びて
 * カメラの脇を通り、near 面（`scene.ts` の 5 m）を越える。越えた三角形は
 * ラスタライザが near 面で切り、切り口の直線がそのまま画面に出る。濃さも
 * 幅も残っているので断面が露出する。
 *
 * 頂点を淡くするだけでは直らない。**クリップされた辺の色は両端の頂点から
 * 補間されるので、切り口には手前の頂点の濃さが乗る。**実測でも距離フェード
 * 5→18 m は断面を 22 から 19 階調にしか下げず、5→30 m にすると消える代わりに
 * 軌跡の平均濃さが 18.8 から 4.0 へ落ちた。
 *
 * だから淡くするのではなく、**near 面の手前へ頂点を寄せて、幅と濃さを 0 に
 * して終端する。**クリップが起きないので切り口が生まれない。細く消える。
 * 実測で断面 22 → 4〜5 階調。
 *
 * **半径で測ってはいけない。**追従カメラは機体の 23 m 後方・6.8 m 上にいる
 * （`camera.ts` の `OFFSET`）ので、翼端の軌跡は 8.8 m まで近づく。半径 14 m で
 * 打ち切ると 3 点目で終わり、実測で渦の画素が 181,649 から 240 へ落ちた。
 * クリップは視線方向の深度で起きるので、深度で測る。near 面 5 m に対して 7 m。
 */
export const RIBBON_NEAR_CLIP_DEPTH = 7

/** 点の列を読む口。位置は横のずらしを済ませた世界座標で渡す */
export interface RibbonSource {
  /** 使える点の数。添字 0 が新しい端 */
  readonly count: number
  /** index 番目の点の世界座標を out へ書く */
  positionAt(index: number, out: THREE.Vector3): void
  /**
   * index 番目の濃さ。0 は「出ていない」。
   *
   * 上限の掛け算まで済ませた値を返す。0 になる点は先細りの起点になる。
   */
  strengthAt(index: number): number
}

/** リボンを向ける先と、終端に使う視線方向 */
export interface RibbonCamera {
  readonly position: THREE.Vector3
  /** 視線方向の単位ベクトル */
  readonly forward: THREE.Vector3
}

/**
 * リボンの見え方を決める値。
 *
 * すべて呼び出し側が持つ。翼端渦とコントレイルと煙で違う値になり、それぞれの
 * 根拠は使う側のファイルに書いてある。ここは機構だけを持つ。
 */
export interface RibbonParams {
  /** 生まれたばかりの根元の半幅 m。中心が最も濃く縁で 0 になる */
  halfWidth: number
  /** 1 秒あたり何倍に広がるか。乱流の拡散 */
  spreadPerSecond: number
  /** 広がりの上限（倍） */
  spreadLimit: number
  /** 消えるまでの秒数 */
  lifetime: number
  /** 履歴 1 本ぶんの秒数。経過秒を添字から出すのに使う */
  secondsPerPoint: number
  /** 減衰を始めるまでの寿命に対する割合。ここまでは濃さを保つ */
  decayHold: number
  /** 先細りに使う本数。「濃さが 0 になる点からの距離」で数える */
  taperPoints: number
  /** 先細りで幅をどこまで絞るか。濃さだけ落とすと靄の塊に見える */
  taperWidthFloor: number
}

// 毎フレームの一時変数。update() は再入しないので使い回す
const point = new THREE.Vector3()
const next = new THREE.Vector3()
const previous = new THREE.Vector3()
const tangent = new THREE.Vector3()
const toCamera = new THREE.Vector3()
const side = new THREE.Vector3()
const scratch = new THREE.Vector3()

export class Ribbon {
  readonly geometry: THREE.BufferGeometry

  private readonly position: THREE.BufferAttribute
  private readonly color: THREE.BufferAttribute

  /**
   * 位置・濃さ・先細りは書き込む前に 1 周して求める。
   *
   * 先細りは古いほうから数えるので、頂点を書きながらでは決まらない。
   * 位置も、終端の割り込み位置を出すのに直前の点を読み返す必要がある。
   */
  private readonly positions: Float32Array
  private readonly strengths: Float32Array
  private readonly tapers: Float32Array

  constructor(readonly capacity: number) {
    const vertices = capacity * 3
    this.position = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3)
    this.color = new THREE.BufferAttribute(new Float32Array(vertices * 4), 4)
    this.position.setUsage(THREE.DynamicDrawUsage)
    this.color.setUsage(THREE.DynamicDrawUsage)

    this.positions = new Float32Array(capacity * 3)
    this.strengths = new Float32Array(capacity)
    this.tapers = new Float32Array(capacity)

    // 頂点は 3 個 / 点なので、容量が 21,845 を超えると 16bit の添字で足りない
    const index =
      vertices > 65_536
        ? new Uint32Array((capacity - 1) * 12)
        : new Uint16Array((capacity - 1) * 12)
    // 区間ごとに 2 枚の帯（左半分と右半分）を張るので三角形は 4 枚
    for (let i = 0; i < capacity - 1; i++) {
      const a = i * 3
      const b = a + 3
      const o = i * 12
      index[o] = a
      index[o + 1] = b
      index[o + 2] = a + 1
      index[o + 3] = a + 1
      index[o + 4] = b
      index[o + 5] = b + 1
      index[o + 6] = a + 1
      index[o + 7] = b + 1
      index[o + 8] = a + 2
      index[o + 9] = a + 2
      index[o + 10] = b + 1
      index[o + 11] = b + 2
    }

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', this.position)
    this.geometry.setAttribute('color', this.color)
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1))
    this.geometry.setDrawRange(0, 0)
  }

  /** 何も描かない。点が足りないときに呼ぶ */
  clear(): void {
    this.geometry.setDrawRange(0, 0)
  }

  /** 点の列から帯を張り直す。毎フレーム呼ぶ */
  update(source: RibbonSource, camera: RibbonCamera, params: RibbonParams): void {
    const available = Math.min(source.count, this.capacity)
    if (available < 2) return this.clear()

    // near 面の手前で終端させる。またぐとクリップされて断面が出る
    const { count, cut } = this.writePositions(source, camera, available)
    if (count < 2) return this.clear()

    this.writeVertices(source, camera, params, count, cut)
  }

  dispose(): void {
    this.geometry.dispose()
  }

  /**
   * 位置を作りながら、near 面の手前で終端させる。
   *
   * 視線方向の深度が `RIBBON_NEAR_CLIP_DEPTH` を割る点が出たら、直前の点との
   * 間を深度がちょうど閾値になるところで割って、そこを最後の点にする。返り値の
   * `cut` がその添字で、頂点を書くときに幅と濃さを 0 にする。
   */
  private writePositions(
    source: RibbonSource,
    camera: RibbonCamera,
    available: number,
  ): { count: number; cut: number } {
    const positions = this.positions
    for (let i = 0; i < available; i++) {
      source.positionAt(i, point)
      const depth = scratch.subVectors(point, camera.position).dot(camera.forward)
      if (depth < RIBBON_NEAR_CLIP_DEPTH) {
        if (i === 0) return { count: 0, cut: -1 }
        // 直前の点は閾値より奥にある。深度が閾値になる位置まで戻す
        previous.set(
          positions[(i - 1) * 3]!,
          positions[(i - 1) * 3 + 1]!,
          positions[(i - 1) * 3 + 2]!,
        )
        const before = scratch.subVectors(previous, camera.position).dot(camera.forward)
        const t = (before - RIBBON_NEAR_CLIP_DEPTH) / (before - depth)
        point.lerpVectors(previous, point, Math.min(1, Math.max(0, t)))
        positions[i * 3] = point.x
        positions[i * 3 + 1] = point.y
        positions[i * 3 + 2] = point.z
        return { count: i + 1, cut: i }
      }
      positions[i * 3] = point.x
      positions[i * 3 + 1] = point.y
      positions[i * 3 + 2] = point.z
    }
    return { count: available, cut: -1 }
  }

  private writeVertices(
    source: RibbonSource,
    camera: RibbonCamera,
    params: RibbonParams,
    count: number,
    cut: number,
  ): void {
    const { positions, strengths, tapers } = this

    for (let i = 0; i < count; i++) strengths[i] = source.strengthAt(i)
    fillTapers(strengths, count, params.taperPoints, tapers)

    for (let i = 0; i < count; i++) {
      const j = Math.min(i + 1, count - 1) * 3
      point.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
      next.set(positions[j]!, positions[j + 1]!, positions[j + 2]!)

      tangent.subVectors(next, point)
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1)
      toCamera.subVectors(camera.position, point)
      // 進行方向と視線の両方に直交する向き。どこから見ても幅が残る
      side.crossVectors(tangent, toCamera)
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
      side.normalize()

      const age = i * params.secondsPerPoint
      const taper = tapers[i]!
      // near 面の手前へ寄せた終端は、幅も濃さも 0 にして細く消す
      const terminal = i === cut ? 0 : 1
      const width =
        params.halfWidth *
        Math.min(params.spreadLimit, 1 + age * params.spreadPerSecond) *
        (params.taperWidthFloor + (1 - params.taperWidthFloor) * taper) *
        terminal

      const alpha =
        strengths[i]! *
        ribbonDecay(age / params.lifetime, params.decayHold) *
        taper *
        terminal

      const base = i * 3
      this.position.setXYZ(
        base,
        point.x - side.x * width,
        point.y - side.y * width,
        point.z - side.z * width,
      )
      this.position.setXYZ(base + 1, point.x, point.y, point.z)
      this.position.setXYZ(
        base + 2,
        point.x + side.x * width,
        point.y + side.y * width,
        point.z + side.z * width,
      )
      // 縁は透明、中心が最大。硬い帯にしない
      this.color.setXYZW(base, 1, 1, 1, 0)
      this.color.setXYZW(base + 1, 1, 1, 1, alpha)
      this.color.setXYZW(base + 2, 1, 1, 1, 0)
    }

    this.position.needsUpdate = true
    this.color.needsUpdate = true
    // 使う三角形だけ描く。点が足りないうちは短く。1 区間あたり 4 枚
    this.geometry.setDrawRange(0, Math.max(0, count - 1) * 12)
  }
}

/**
 * 経過の割合 0..1 から濃さの倍率を返す。
 *
 * `hold` までは 1 のまま、そこから smoothstep で 0 へ。
 *
 * 以前は履歴の何本目かに対して二乗で落としていた。描く本数を制限していたので
 * 画面に映る範囲で 3 割ほど薄くなり、軌跡が空中で尻すぼみに消えた。秒で測って
 * 手前を保たせると、薄れて消えるのではなく画面の縁で切れる。
 */
export function ribbonDecay(t: number, hold: number): number {
  if (t <= hold) return 1
  if (t >= 1) return 0
  const u = (t - hold) / (1 - hold)
  return 1 - u * u * (3 - 2 * u)
}

/**
 * 濃さの列から先細りの列を作る。
 *
 * 濃さが 0 の点からの距離を、古いほうから新しいほうへ数える。0 に当たる
 * たびにやり直すので、**区間ごとに古い側の縁が透明から立ち上がる**。
 * 履歴の打ち切り（count の先）も「その先が 0」として同じ式で扱える。
 *
 * **境目は履歴の末尾だけにあるのではない。**翼端の水蒸気は引き始めに 0.2 秒で
 * 立ち上がるので、機動を始めた瞬間の位置に急な段差ができる。旋回を続けると
 * その段差が視界へ回り込んできて、**直角に切り落としたような末端**に見える。
 * 実機の 5.44 G 旋回のスクリーンショットで指摘された。だから本数で数えるのでは
 * なく、0 になる点からの距離で数える。
 *
 * @param strengths 新しい順の濃さ。0 が「出ていない」
 * @param count 有効な本数
 * @param taperPoints 何本かけて 0 から 1 へ立ち上げるか
 * @param out 書き込み先。長さは strengths と同じ
 */
export function fillTapers(
  strengths: Float32Array,
  count: number,
  taperPoints: number,
  out: Float32Array,
): void {
  let run = 0
  for (let i = count - 1; i >= 0; i--) {
    run = strengths[i]! > 0 ? run + 1 : 0
    out[i] = Math.min(1, run / taperPoints)
  }
}
