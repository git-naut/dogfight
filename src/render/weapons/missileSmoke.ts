import * as THREE from 'three'
import { FIXED_DT } from '../../sim/loop'
import { SMOKE_LENGTH, SMOKE_STRIDE, type SmokeSource } from '../../sim/weapons/missile'
import { Ribbon, type RibbonParams, type RibbonSource } from '../ribbon'
import type { QualitySettings } from '../quality'

/**
 * ミサイルの煙。
 *
 * 履歴は sim が持つ（`Missile` の `TrailRing`）。ここは読んでリボンを張る
 * だけ。翼端渦と同じ理由で、描画側にバッファを置くとキャプチャモードで
 * 何も出ない（`sync` が 1 回しか走らない）。
 *
 * **near 面の終端は `Ribbon.update()` が必ず通す。**煙は発射した位置から
 * 前方へ伸びるので、自機がそのまま直進すると**カメラが煙の中を通る。**
 * リボンが near 面（`scene.ts` の 5 m）を越えるとラスタライザが切り、
 * 切り口の直線がそのまま画面に出る。Phase 4 の翼端渦で 2 度指摘された罠と
 * 同じ経路なので、対処も共通のものを使う（`ribbon.ts`）。
 *
 * 台本 `missile-near` がその見張り。
 */

/** 履歴 1 本ぶんの秒数。sim が SMOKE_STRIDE ステップごとに記録する */
const SECONDS_PER_POINT = SMOKE_STRIDE * FIXED_DT

/**
 * 根元の半幅 m。
 *
 * ロケットモータの排気は直径 0.127 m の弾体よりずっと太い。翼端渦
 * （半幅 0.6 m）より太く見えてよい。
 */
const SMOKE_HALF_WIDTH = 1.1

/**
 * 1 秒あたり何倍に広がるか、と広がりの上限。
 *
 * 排気は乱流で拡散する。翼端渦（0.35/秒・上限 4 倍）より速く太る。
 */
const SPREAD_PER_SECOND = 0.9
const SPREAD_LIMIT = 6

/**
 * 濃さの上限。
 *
 * **翼端渦で実測した性質がそのまま効く。**リボンは後方へ伸びるので追従
 * カメラからは長手方向に見え、1 本の視線が何区間も貫く。濃さを半分にしても
 * 見た目は半分にならない（重なった層の合成 1−(1−a)^n が飽和する）。
 * 渦の 0.09 より濃くするが、白い板にならない値を実測で決める。
 */
const SMOKE_OPACITY = 0.16

/** 消えるまでの秒数。ロケットの煙は数十秒残る */
const SMOKE_LIFETIME = 25

/** 減衰を始めるまでの割合。ここまでは濃さを保つ */
const SMOKE_DECAY_HOLD = 0.2

/** 途切れる手前を先細りさせる本数 */
const SMOKE_TAPER_POINTS = 24

/** 先細りで幅をどこまで絞るか */
const SMOKE_TAPER_WIDTH_FLOOR = 0.4

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

export interface MissileSmoke {
  readonly object: THREE.Object3D
  /**
   * 煙を張り直す。毎フレーム呼ぶ。
   *
   * @param sources ミサイルごとの履歴。飛んでいないものは点が 0 本
   * @param cameraPosition リボンを向ける先
   * @param cameraForward 視線方向の単位ベクトル。near 面の手前で終端するのに使う
   */
  update(
    sources: readonly SmokeSource[],
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
  ): void
  setQuality(quality: QualitySettings): void
  dispose(): void
}

const NOT_ENABLED: MissileSmoke = {
  object: new THREE.Group(),
  update() {},
  setQuality() {},
  dispose() {},
}

/**
 * 1 発ぶんの履歴を、リボンから見て点の列に見せる。
 *
 * 煙の濃さの判定をここで済ませるので、リボン側は物理を知らない。
 */
class SmokeRibbonSource implements RibbonSource {
  count = 0
  private source: SmokeSource | null = null

  bind(source: SmokeSource, count: number): void {
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

export function createMissileSmoke(
  capacity: number,
  quality: QualitySettings,
): MissileSmoke {
  let segments = quality.missileTrailSegments
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
  // 煙は機体の前後に伸びる。視錐台で捨てられると消える
  group.frustumCulled = false

  const ribbons = Array.from({ length: capacity }, () => new Ribbon(SMOKE_LENGTH))
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
        const available = source === undefined ? 0 : Math.min(source.trailLength, segments)
        if (source === undefined || available < 2) {
          ribbons[i]!.clear()
          continue
        }
        sources[i]!.bind(source, available)
        ribbons[i]!.update(sources[i]!, cameraView, SMOKE_PARAMS)
      }
    },

    setQuality(next) {
      segments = next.missileTrailSegments
      group.visible = segments > 0
    },

    dispose() {
      for (const ribbon of ribbons) ribbon.dispose()
      material.dispose()
    },
  }
}
