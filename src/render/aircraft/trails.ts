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
 * 翼端渦の濃さを決める水蒸気の範囲。
 *
 * 元の駆動量は マッハ数 × 揚力係数で、sim が時定数つきで追従させている
 * （`Aircraft.wingtipVapor`）。
 *
 * 判定は 2 度作り直した。
 *
 * 荷重倍数だと旋回で出ない。定常旋回は 3.0〜3.3 G までしか出ないので
 * 閾値 3.5 に届かず、旋回でまったく渦が出なかった。
 *
 * 揚力係数だけだと速い引き起こしで出ない。急上昇の実測は 6.86 G・340 m/s
 * で揚力係数 0.453 しかなく、引き起こし直後でも渦が見えなかった。
 *
 * 芯の温度低下を無次元で書くと ΔT/T ∝ γM²Cl²/2 になる。マッハ数と揚力
 * 係数の積が駆動量で、どちらか片方では足りない。実測値（M·Cl）。
 *
 * | 場面 | M | Cl | M·Cl |
 * | 水平飛行 (low-pass f2500) | 1.20 | 0.044 | 0.053 |
 * | 高速の引き起こし (island-run f2000) | 1.15 | 0.171 | 0.196 |
 * | 浅い旋回 (bank-left f420) | 0.77 | 0.449 | 0.344 |
 * | 定常旋回 (bank-left f1800) | 0.68 | 0.569 | 0.387 |
 * | 急上昇 (zoom-climb f200) | 1.01 | 0.453 | 0.456 |
 * | 引き起こし (pull-up f430) | 0.89 | 0.610 | 0.542 |
 * | 高 G の引き起こし (pull-up f900) | 0.82 | 0.710 | 0.582 |
 */
const VORTEX_DRIVE_START = 0.25
const VORTEX_DRIVE_FULL = 0.6

/** 翼端渦を出す位置。翼幅 11.571 m の少し内側 */
const WINGTIP_OFFSET = 5.6

/**
 * リボンの半幅 m。生まれたばかりの根元の値。
 *
 * 幅の中心が最も濃く、縁で 0 になる。だから見た目の太さは半幅より細い。
 * 0.18 の一様な帯より、0.30 の中心が濃い帯のほうが淡く見える。
 */
const VORTEX_HALF_WIDTH = 0.6
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
 * 見た目が半分にならないのは、重なった層の合成が飽和するため。0.018 まで下げた。
 *
 * そこから 0.09 へ引き上げた。near 面の手前で終端するようにしたので、
 * **見えていた軌跡の大半（カメラ脇を通る 7 m ぶんが拡大されたもの）が
 * なくなった。**実測で最大 45 → 7 階調、平均 18.8 → 1.8。残るのは遠方の
 * 細い部分なので、そこが読める濃さに上げ直す。半幅も 0.3 → 0.6 m にして
 * 遠方で 1 画素を割らないようにする。
 */
const VORTEX_OPACITY = 0.09
const CONTRAIL_OPACITY = 0.12

/**
 * 消えるまでの秒数。
 *
 * 実機の翼端渦は十数秒から数十秒かけて拡散して見えなくなる。履歴を
 * 25.6 秒へ伸ばしたので、寿命も 16 秒から 30 秒へ広げた。16 秒のままだと
 * 伸ばした後ろ半分が減衰で消えて、伸ばした意味がなくなる。
 *
 * コントレイルは分単位で残る。終端は下の先細りが処理する。
 */
const VORTEX_LIFETIME = 30
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
 * 途切れる手前を先細りさせる本数。1.07 秒ぶん。
 *
 * 濃さが 0 になる境目の手前を、0 へ向かって滑らかに落とす。
 *
 * **境目は履歴の末尾だけにあるのではない。**水蒸気は引き始めに 0.2 秒で
 * 立ち上がるので、機動を始めた瞬間の位置に急な段差ができる。旋回を続けると
 * その段差が視界へ回り込んできて、**直角に切り落としたような末端**に見える。
 * 実機の 5.44 G 旋回のスクリーンショットで指摘された。
 *
 * だから本数で数えるのではなく、0 になる点からの距離で数える。履歴の
 * 打ち切りも「その先が 0」と同じ扱いになるので、1 つの仕組みで両方に効く。
 */
const TAPER_POINTS = 32

/**
 * カメラのこれより手前ではリボンを打ち切る距離 m。
 *
 * **軌跡が空中で直角に切れる原因はこれだった。**リボンは後方へ伸びて
 * カメラの脇を通り、near 面（`scene.ts` の 5 m）を越える。越えた三角形は
 * ラスタライザが near 面で切り、切り口の直線がそのまま画面に出る。濃さも
 * 幅も残っているので断面が露出する。
 *
 * 切り分けの経緯。減衰と先細りを両方外しても画素が 1 つも変わらなかった
 * （turn-in の frame 1000 で輪郭 4700 画素・最悪 22 階調が一致）。つまり
 * 見えている範囲は全部「減衰なし」の領域で、端はリボンの終端ではない。
 * 残るのは視錐台の切り取りだけ。
 *
 * 頂点を淡くするだけでは直らない。**クリップされた辺の色は両端の頂点から
 * 補間されるので、切り口には手前の頂点の濃さが乗る。**実測でも距離フェード
 * 5→18 m は断面を 22 から 19 階調にしか下げず、5→30 m にすると消える代わりに
 * 軌跡の平均濃さが 18.8 から 4.0 へ落ちた。
 *
 * だから淡くするのではなく、**near 面の手前へ頂点を寄せて、幅と濃さを 0 に
 * して終端する。**クリップが起きないので切り口が生まれない。細く消える。
 *
 * 半径で測ってはいけない。追従カメラは機体の 23 m 後方・6.8 m 上にいる
 * （`camera.ts` の OFFSET）ので、翼端の軌跡は 8.8 m まで近づく。半径 14 m で
 * 打ち切ると 3 点目で終わり、実測で渦の画素が 181,649 から 240 へ落ちた。
 * クリップは視線方向の深度で起きるので、深度で測る。near 面 5 m に対して 7 m。
 */
const NEAR_CLIP_DEPTH = 7

/**
 * 先細りで幅をどこまで絞るか。
 *
 * 濃さだけ落とすと、太いまま薄くなって靄の塊に見える。**淡く細く**
 * 消えるように幅も絞る。0 で消える手前は元の 35%。
 */
const TAPER_WIDTH_FLOOR = 0.35

/**
 * いまの翼端の状態。リボンの先頭をここへ繋ぐ。
 *
 * 履歴は `TRAIL_STRIDE` ステップごとにしか記録しないので、最新の点は最大で
 * 1/30 秒ぶん後ろにある。**翼端の目の前ではそれが数十画素の隙間になり、
 * リボンの先頭が直角に切り落とされたように見える。**実機の 5.44 G 旋回で
 * 指摘され、同じ構図を再現して x=1060 と翼端 x=1140 のあいだが空くのを
 * 確かめた。補間した現在の状態を先頭に足して埋める。
 */
export interface TrailHead {
  readonly position: THREE.Vector3
  /** 機体右方向の単位ベクトル */
  readonly right: THREE.Vector3
  readonly wingtipVapor: number
  readonly altitude: number
  readonly throttle: number
}

export interface AircraftTrails {
  readonly object: THREE.Object3D
  /**
   * 履歴からリボンを張り直す。毎フレーム呼ぶ。
   *
   * @param cameraPosition リボンを向ける先
   * @param cameraForward 視線方向の単位ベクトル。near 面の手前で終端するのに使う
   * @param head いまの翼端。リボンの先頭に足して隙間を埋める
   */
  update(
    source: TrailSource,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
    head: TrailHead,
  ): void
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

  // 使い回す。位置・濃さ・先細りは書き込む前に 1 周して求める
  const positions = new Float32Array(TRAIL_LENGTH * 3)
  const strengths = new Float32Array(TRAIL_LENGTH)
  const tapers = new Float32Array(TRAIL_LENGTH)
  const previous = new THREE.Vector3()

  /**
   * 濃さと先細りを先に求める。
   *
   * 先細りは「濃さが 0 になる点からの距離」で決める。古いほうから新しい
   * ほうへ数えるので、0 に当たるたびにやり直す。履歴の打ち切りも
   * 「その先が 0」として同じ式で扱える。
   */
  function prepare(
    ribbon: Ribbon,
    source: TrailSource,
    count: number,
    head: TrailHead,
  ): void {
    const scale = ribbon.kind === 'vortex' ? VORTEX_OPACITY : CONTRAIL_OPACITY
    for (let i = 0; i < count; i++) {
      const point = i === 0 ? head : source.trailPoint(i - 1)
      strengths[i] =
        (ribbon.kind === 'vortex'
          ? vortexStrength(point.wingtipVapor)
          : contrailStrength(point.altitude, point.throttle)) * scale
    }
    fillTapers(strengths, count, tapers)
  }

  /**
   * 位置を作りながら、near 面の手前で終端させる。
   *
   * 視線方向の深度が `NEAR_CLIP_DEPTH` を割る点が出たら、直前の点との間を
   * 深度がちょうど閾値になるところで割って、そこを最後の点にする。返り値の
   * `cut` がその添字で、呼び出し側は幅と濃さを 0 にする。
   *
   * @returns 使う本数と、終端にした添字（なければ -1）
   */
  function preparePositions(
    ribbon: Ribbon,
    source: TrailSource,
    head: TrailHead,
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
    available: number,
  ): { count: number; cut: number } {
    for (let i = 0; i < available; i++) {
      const current = i === 0 ? head : source.trailPoint(i - 1)
      point
        .set(current.position.x, current.position.y, current.position.z)
        .addScaledVector(
          side.set(current.right.x, current.right.y, current.right.z),
          ribbon.offset,
        )
      const depth = next.subVectors(point, cameraPosition).dot(cameraForward)
      if (depth < NEAR_CLIP_DEPTH) {
        if (i === 0) return { count: 0, cut: -1 }
        // 直前の点は閾値より奥にある。深度が閾値になる位置まで戻す
        previous.set(positions[(i - 1) * 3]!, positions[(i - 1) * 3 + 1]!, positions[(i - 1) * 3 + 2]!)
        const before = next.subVectors(previous, cameraPosition).dot(cameraForward)
        const t = (before - NEAR_CLIP_DEPTH) / (before - depth)
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

  function writeRibbon(
    ribbon: Ribbon,
    source: TrailSource,
    cameraPosition: THREE.Vector3,
    count: number,
    head: TrailHead,
    cut: number,
  ): void {
    const halfWidth =
      ribbon.kind === 'vortex' ? VORTEX_HALF_WIDTH : CONTRAIL_HALF_WIDTH
    prepare(ribbon, source, count, head)

    for (let i = 0; i < count; i++) {
      const j = Math.min(i + 1, count - 1) * 3
      point.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
      next.set(positions[j]!, positions[j + 1]!, positions[j + 2]!)

      tangent.subVectors(next, point)
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1)
      toCamera.subVectors(cameraPosition, point)
      // 進行方向と視線の両方に直交する向き。どこから見ても幅が残る
      side.crossVectors(tangent, toCamera)
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
      side.normalize()

      const age = i * SECONDS_PER_POINT
      const taper = tapers[i]!
      // near 面の手前へ寄せた終端は、幅も濃さも 0 にして細く消す
      const terminal = i === cut ? 0 : 1
      const width =
        halfWidth *
        Math.min(SPREAD_LIMIT, 1 + age * SPREAD_PER_SECOND) *
        (TAPER_WIDTH_FLOOR + (1 - TAPER_WIDTH_FLOOR) * taper) *
        terminal

      const lifetime =
        ribbon.kind === 'vortex' ? VORTEX_LIFETIME : CONTRAIL_LIFETIME
      const alpha = strengths[i]! * trailDecay(age / lifetime) * taper * terminal

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

    update(source, cameraPosition, cameraForward, head) {
      // 先頭に現在の翼端を足すので 1 本増える
      const available = Math.min(source.trailLength + 1, segments)
      if (available < 2) {
        for (const ribbon of ribbons) ribbon.geometry.setDrawRange(0, 0)
        return
      }
      for (const ribbon of ribbons) {
        // near 面の手前で終端させる。またぐとクリップされて断面が出る
        const { count, cut } = preparePositions(
          ribbon,
          source,
          head,
          cameraPosition,
          cameraForward,
          available,
        )
        if (count < 2) {
          ribbon.geometry.setDrawRange(0, 0)
          continue
        }
        writeRibbon(ribbon, source, cameraPosition, count, head, cut)
      }
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
 * 水蒸気が凝結する。凝結した量そのものは sim が持つので、ここは範囲を
 * 0..1 へ写すだけ。
 */
export function vortexStrength(vapor: number): number {
  const t =
    (Math.abs(vapor) - VORTEX_DRIVE_START) / (VORTEX_DRIVE_FULL - VORTEX_DRIVE_START)
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
 * 濃さの列から先細りの列を作る。
 *
 * 濃さが 0 の点からの距離を、古いほうから新しいほうへ数える。0 に当たる
 * たびにやり直すので、**区間ごとに古い側の縁が透明から立ち上がる**。
 * 履歴の打ち切り（count の先）も「その先が 0」として同じ式で扱える。
 *
 * @param strengths 新しい順の濃さ。0 が「出ていない」
 * @param count 有効な本数
 * @param out 書き込み先。長さは strengths と同じ
 */
export function fillTapers(
  strengths: Float32Array,
  count: number,
  out: Float32Array,
): void {
  let run = 0
  for (let i = count - 1; i >= 0; i--) {
    run = strengths[i]! > 0 ? run + 1 : 0
    out[i] = Math.min(1, run / TAPER_POINTS)
  }
}

/** 先細りに使う本数。テストから参照する */
export const TRAIL_TAPER_POINTS = TAPER_POINTS

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
