import * as THREE from 'three'
import { FIXED_DT } from '../sim/loop'
import {
  DAMAGE_SMOKE_LENGTH,
  DAMAGE_SMOKE_STRIDE,
  type DamageSmokeSource,
} from '../sim/damage'
import { Ribbon, type RibbonParams, type RibbonSource } from './ribbon'
import type { QualitySettings } from './quality'

/**
 * ダメージの煙。
 *
 * 履歴は sim が持つ（`DamageSmoke` の `TrailRing`）。ここは読んでリボンを
 * 張るだけ。翼端渦とミサイルの煙と同じ理由で、描画側にバッファを置くと
 * キャプチャモードで何も出ない（`sync` が 1 回しか走らない）。
 *
 * **near 面の終端は `Ribbon.update()` が必ず通す。**煙は敵機の後ろへ伸びる
 * ので、自機が敵の後ろにつくとカメラが煙の中を通る。翼端渦とミサイルの煙で
 * 2 度踏んだ経路なので、対処も共通のものを使う（`ribbon.ts`）。
 *
 * ミサイルの煙との違いは 3 つ。
 *
 * **細くて薄い。**ロケットモータの排気は直径 0.127 m の弾体よりずっと太いが、
 * 被弾した機体から出るのは燃料と作動油の煙で、排気口の径に近い。
 *
 * **長さが短い。**12.8 秒ぶん（384 本 × 4 ステップ）。ミサイルの 17 秒より
 * 短くしてある。薄いので遠い側は見えない。
 *
 * **濃さが履歴の点ごとに変わる。**傷が深くなるほど濃くなるので、後ろへ
 * 遡ると薄くなる。ミサイルの煙は燃焼中は一定。
 */

/** 履歴 1 本ぶんの秒数。sim が DAMAGE_SMOKE_STRIDE ステップごとに記録する */
const SECONDS_PER_POINT = DAMAGE_SMOKE_STRIDE * FIXED_DT

/**
 * 根元の半幅 m。
 *
 * 排気口の直径は F-16 で 1.1 m 前後（`.ac` の `NozzleRing` が Y −0.54..0.55）。
 * **排気口の径に合わせた 0.55 では細すぎた。**260 m で幅 2 画素しかなく、
 * 濃さを上げても線にしか見えない。被弾した機体から出る煙は排気口を出てすぐ
 * 広がるので、根元から太くする。
 */
const SMOKE_HALF_WIDTH = 1.2

/**
 * 1 秒あたり何倍に広がるか、と広がりの上限。
 *
 * ミサイルの排気（0.9/秒・上限 6 倍）より速い。ロケットの排気は高速で
 * 出るので周りの空気とすぐには混ざらないが、燃料の煙は乱流に乗る。
 */
const SPREAD_PER_SECOND = 1.2
const SPREAD_LIMIT = 8

/**
 * 濃さの上限。
 *
 * **翼端渦（0.09）やミサイルの煙（0.16）よりずっと大きい。**理由が 2 つある。
 *
 * リボンの alpha は幅方向に三角形の分布で、**中心線だけが最大値。**縁は 0 に
 * してある（硬い帯にしないため）。幅方向に平均すると半分になる。
 *
 * それに合成が線形空間で起き、そのあとトーンマッピングが圧縮する。露出 6 の
 * ACES 系なので、暗い色を重ねても表示値の差はそのまま出ない。
 *
 * 傷ついた敵を後方 260 m から見て、濃さを振って測った（`?dmgsmoke=0` との
 * 引き算）。
 *
 * | 濃さ | 画素 | 12 階調以上 | 最大 |
 * | 0.13 | 436 | 0 | 2 |
 * | 0.35 | 2,776 | 1 | 12 |
 * | 0.50 | 3,381 | 3 | 17 |
 * | 0.70 | 3,999 | 20 | 23 |
 * | 0.90 | 4,358 | 68 | 27 |
 *
 * 0.13 では絵に出ない（最大 2 階調）。0.9 で「煙を引いている」と読める。
 * 参考に、翼端渦は 1,335 画素・12 階調以上 7 画素・最大 29 階調。**面積は
 * 渦の 3 倍で、峰の高さは同じくらい。**
 */
const SMOKE_OPACITY = 0.9

/** 消えるまでの秒数。燃料の煙はロケットの煙より早く散る */
const SMOKE_LIFETIME = 10

/** 減衰を始めるまでの割合。ここまでは濃さを保つ */
const SMOKE_DECAY_HOLD = 0.15

/** 途切れる手前を先細りさせる本数 */
const SMOKE_TAPER_POINTS = 20

/** 先細りで幅をどこまで絞るか */
const SMOKE_TAPER_WIDTH_FLOOR = 0.35

const SMOKE_PARAMS: RibbonParams = {
  halfWidth: SMOKE_HALF_WIDTH,
  spreadPerSecond: SPREAD_PER_SECOND,
  spreadLimit: SPREAD_LIMIT,
  lifetime: SMOKE_LIFETIME,
  secondsPerPoint: SECONDS_PER_POINT,
  decayHold: SMOKE_DECAY_HOLD,
  taperPoints: SMOKE_TAPER_POINTS,
  taperWidthFloor: SMOKE_TAPER_WIDTH_FLOOR,
}

export interface DamageSmokeView {
  readonly object: THREE.Object3D
  /**
   * 煙を張り直す。毎フレーム呼ぶ。
   *
   * @param sources 敵機ごとの履歴。傷ついていない機は濃さ 0 の点が並ぶ
   * @param cameraPosition リボンを向ける先
   * @param cameraForward 視線方向の単位ベクトル。near 面の手前で終端するのに使う
   */
  update(
    sources: readonly DamageSmokeSource[],
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: DamageSmokeView = {
  object: new THREE.Group(),
  update() {},
  setQuality() {},
  dispose() {},
}

/**
 * 1 機ぶんの履歴を、リボンから見て点の列に見せる。
 *
 * 濃さの判定をここで済ませるので、リボン側は物理を知らない。
 */
class SmokeRibbonSource implements RibbonSource {
  count = 0
  private source: DamageSmokeSource | null = null

  bind(source: DamageSmokeSource, count: number): void {
    this.source = source
    this.count = count
  }

  positionAt(index: number, out: THREE.Vector3): void {
    const p = this.source!.trailPoint(index).position
    out.set(p.x, p.y, p.z)
  }

  strengthAt(index: number): number {
    return this.source!.trailPoint(index).smoke * SMOKE_OPACITY
  }
}

export function createDamageSmoke(
  capacity: number,
  quality: QualitySettings,
): DamageSmokeView {
  let segments = quality.damageSmokeSegments
  if (segments === 0) return NOT_ENABLED

  const material = new THREE.MeshBasicMaterial({
    // **燃料と作動油の煙は黒っぽい。**ミサイルの白い排気（0xffffff）と
    // 見分けが付くようにする。暗い色は空を背に置くとよく見え、地形を背に
    // すると沈む。値は絵で確かめて決める
    color: 0x4a4a4a,
    transparent: true,
    // 奥行きは書かない。リボンどうしが順序で欠けるのを避ける
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: true,
  })

  const group = new THREE.Group()
  // 煙は機体の後ろへ伸びる。視錐台で捨てられると消える
  group.frustumCulled = false

  const ribbons = Array.from(
    { length: capacity },
    () => new Ribbon(DAMAGE_SMOKE_LENGTH),
  )
  const sources = Array.from({ length: capacity }, () => new SmokeRibbonSource())
  for (const ribbon of ribbons) {
    const mesh = new THREE.Mesh(ribbon.geometry, material)
    mesh.frustumCulled = false
    group.add(mesh)
  }

  const cameraView = {
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(),
  }

  return {
    object: group,

    update(list, cameraPosition, cameraForward) {
      cameraView.position.copy(cameraPosition)
      cameraView.forward.copy(cameraForward)

      for (let i = 0; i < ribbons.length; i++) {
        const source = list[i]
        const available =
          source === undefined ? 0 : Math.min(source.trailLength, segments)
        if (source === undefined || available < 2) {
          ribbons[i]!.clear()
          continue
        }
        sources[i]!.bind(source, available)
        ribbons[i]!.update(sources[i]!, cameraView, SMOKE_PARAMS)
      }
    },

    setQuality(next) {
      segments = next.damageSmokeSegments
      group.visible = segments > 0
    },

    dispose() {
      for (const ribbon of ribbons) ribbon.dispose()
      material.dispose()
    },
  }
}
