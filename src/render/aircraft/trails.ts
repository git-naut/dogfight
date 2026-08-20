import * as THREE from 'three'
import { FIXED_DT } from '../../sim/loop'
import { TRAIL_LENGTH, TRAIL_STRIDE, type AircraftTrailSource } from '../../sim/aircraft'
import { CONTRAIL_TEMPERATURE, temperature } from '../../sim/isa'
import { Ribbon, type RibbonParams, type RibbonSource } from '../ribbon'
import type { QualitySettings } from '../quality'

/**
 * コントレイルと翼端渦。
 *
 * 履歴は sim が持つ（`Aircraft` の `TrailRing`）。ここは読んでリボンを
 * 張るだけ。描画側にバッファを置くと、キャプチャモードは `sync` が 1 回しか
 * 走らないので何も出ない。
 *
 * リボンの機構そのものは `../ribbon.ts` にある。カメラへの向け方、near 面の
 * 手前での終端、先細り、減衰はそこが持つ。このファイルが持つのは
 * 「翼端渦とコントレイルはいつ、どれだけ濃く出るか」という物理の判定と、
 * 実測で決めた諸元だけ。
 *
 * 出る条件は物理から決める。翼端渦はマッハ数 × 揚力係数、コントレイルは気温。
 * どちらもフレーム番号から決まる sim の状態だけを読むので決定論が保たれる。
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
 * コントレイルは分単位で残る。終端は先細りが処理する。
 */
const VORTEX_LIFETIME = 30
const CONTRAIL_LIFETIME = 90

/**
 * 減衰を始めるまでの割合。
 *
 * ここまでは濃さを保ち、そこから寿命まで滑らかに 0 へ落とす。
 * 減衰の式そのものは `ribbonDecay` にある。
 */
export const TRAIL_DECAY_HOLD = 0.15

/**
 * 途切れる手前を先細りさせる本数。1.07 秒ぶん。
 *
 * 数え方は `fillTapers` にある。本数ではなく「濃さが 0 になる点からの距離」で
 * 数えるので、履歴の末尾だけでなく機動を始めた瞬間の段差にも効く。
 */
export const TRAIL_TAPER_POINTS = 32

/**
 * 先細りで幅をどこまで絞るか。
 *
 * 濃さだけ落とすと、太いまま薄くなって靄の塊に見える。**淡く細く**
 * 消えるように幅も絞る。0 で消える手前は元の 35%。
 */
const TAPER_WIDTH_FLOOR = 0.35

const VORTEX_PARAMS: RibbonParams = {
  halfWidth: VORTEX_HALF_WIDTH,
  spreadPerSecond: SPREAD_PER_SECOND,
  spreadLimit: SPREAD_LIMIT,
  lifetime: VORTEX_LIFETIME,
  secondsPerPoint: SECONDS_PER_POINT,
  decayHold: TRAIL_DECAY_HOLD,
  taperPoints: TRAIL_TAPER_POINTS,
  taperWidthFloor: TAPER_WIDTH_FLOOR,
}

const CONTRAIL_PARAMS: RibbonParams = {
  ...VORTEX_PARAMS,
  halfWidth: CONTRAIL_HALF_WIDTH,
  lifetime: CONTRAIL_LIFETIME,
}

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

/**
 * 履歴の点と現在の翼端の共通部。リボンを張るのに読むのはここだけ。
 *
 * `TrailPoint`（sim の `Vec3`）と `TrailHead`（`THREE.Vector3`）の両方が
 * これを満たす。型が違うだけで中身は同じなので、読む側は成分だけ見る。
 */
interface TrailLike {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly right: { readonly x: number; readonly y: number; readonly z: number }
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
    source: AircraftTrailSource,
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

type RibbonKind = 'vortex' | 'contrail'

/** 翼端のずらしに使う一時変数。使い回す */
const offsetDir = new THREE.Vector3()

/**
 * 履歴と現在の翼端を、リボンから見て 1 本の点の列に見せる。
 *
 * 添字 0 が補間した現在の翼端、1 以降が履歴。翼端のずらしと濃さの判定を
 * ここで済ませるので、リボン側は物理を知らない。
 */
class TrailRibbonSource implements RibbonSource {
  count = 0

  private trail: AircraftTrailSource | null = null
  private head: TrailLike | null = null

  constructor(
    /** 翼端のずらし量。0 なら機体の中心 */
    private readonly offset: number,
    private readonly kind: RibbonKind,
  ) {}

  bind(trail: AircraftTrailSource, head: TrailLike, count: number): void {
    this.trail = trail
    this.head = head
    this.count = count
  }

  positionAt(index: number, out: THREE.Vector3): void {
    const p = this.at(index)
    out
      .set(p.position.x, p.position.y, p.position.z)
      .addScaledVector(offsetDir.set(p.right.x, p.right.y, p.right.z), this.offset)
  }

  strengthAt(index: number): number {
    const p = this.at(index)
    return this.kind === 'vortex'
      ? vortexStrength(p.wingtipVapor) * VORTEX_OPACITY
      : contrailStrength(p.altitude, p.throttle) * CONTRAIL_OPACITY
  }

  private at(index: number): TrailLike {
    return index === 0 ? this.head! : this.trail!.trailPoint(index - 1)
  }
}

interface Binding {
  readonly ribbon: Ribbon
  readonly source: TrailRibbonSource
  readonly params: RibbonParams
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

  const bindings: Binding[] = [
    {
      ribbon: new Ribbon(TRAIL_LENGTH),
      source: new TrailRibbonSource(-WINGTIP_OFFSET, 'vortex'),
      params: VORTEX_PARAMS,
    },
    {
      ribbon: new Ribbon(TRAIL_LENGTH),
      source: new TrailRibbonSource(WINGTIP_OFFSET, 'vortex'),
      params: VORTEX_PARAMS,
    },
    {
      ribbon: new Ribbon(TRAIL_LENGTH),
      source: new TrailRibbonSource(0, 'contrail'),
      params: CONTRAIL_PARAMS,
    },
  ]
  for (const binding of bindings) {
    const mesh = new THREE.Mesh(binding.ribbon.geometry, material)
    mesh.frustumCulled = false
    group.add(mesh)
  }

  // カメラの位置と視線。参照を握らず毎フレーム写す
  const cameraView = {
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(),
  }

  return {
    object: group,

    update(source, cameraPosition, cameraForward, head) {
      // 先頭に現在の翼端を足すので 1 本増える
      const available = Math.min(source.trailLength + 1, segments)
      if (available < 2) {
        for (const binding of bindings) binding.ribbon.clear()
        return
      }
      cameraView.position.copy(cameraPosition)
      cameraView.forward.copy(cameraForward)

      for (const binding of bindings) {
        binding.source.bind(source, head, available)
        binding.ribbon.update(binding.source, cameraView, binding.params)
      }
    },

    setQuality(next) {
      segments = next.trailSegments
      group.visible = segments > 0
    },

    dispose() {
      for (const binding of bindings) binding.ribbon.dispose()
      material.dispose()
    },
  }
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
