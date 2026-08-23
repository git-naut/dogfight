import * as THREE from 'three'
import type { AircraftModel } from './aircraft/model'
import { createControlSurfaces, type ControlSurfaces } from './aircraft/surfaces'
import type { AircraftSample } from '../sim/aircraft'

/**
 * 敵機の表示。
 *
 * 中身は FlightGear FGAddon の F-16（GPLv2+、作者は `assets/CREDITS.md`）。
 * 自機の F/A-18C とは別の glb なので、`scene.ts` が 2 本目として読む。
 *
 * **標的機との違いは舵面が動くこと。**標的機（`targetView.ts`）は直進か
 * 定常旋回しかせず、定常旋回のバンクは中立の舵で保たれるので舵を動かさない。
 * 敵機は `Aircraft` を持ち、飛行モデルが舵面の位置を返してくるので、機ごとに
 * 別の舵角を反映する。だから複製ごとに `ControlSurfaces` を持つ。
 *
 * **glb は読み直さない。**複製は `clone()` で作る。three の `clone()` は
 * ジオメトリとマテリアルを参照で共有するので、増えるのはノードの器だけ。
 * 三角形は 1 機ぶん（18,042）が実際に描かれる回数だけ増える。
 *
 * **後始末は複製側でしない。**ジオメトリとマテリアルは元のモデルと同じ実体を
 * 指しているので、ここで dispose すると元のモデルまで壊れる。破棄は
 * `scene.ts` が元のモデルに対して 1 回だけ行う。
 *
 * 影も落とさない。遮蔽物を自機だけにする Phase 4 の判断を維持する
 * （`aircraftShadow` は機体 1 機を囲む正射影の箱 1 つで組んである）。
 */

/** この値を超えたらアフターバーナーの炎を出す。自機と同じ閾値 */
const AUGMENTATION_THROTTLE = 0.85

export interface EnemyViews {
  readonly object: THREE.Object3D
  /** 実際に作った複製の数。予算の確認に使う */
  readonly instanceCount: number
  /** 1 機あたりの三角形数 */
  readonly trianglesPerAircraft: number
  /** 複製 1 機ぶんの動かせた舵面の枚数 */
  readonly surfaceCount: number
  /**
   * 敵機の位置と姿勢と舵面を反映する。
   *
   * 渡された数だけ見せ、余りは隠す。複製は必要になった時点で作る。
   */
  update(samples: readonly AircraftSample[]): void
  dispose(): void
}

/** 複製 1 機。器と、その機だけの舵面と炎を持つ */
interface Instance {
  object: THREE.Object3D
  surfaces: ControlSurfaces
  externalFlame: THREE.Object3D | null
}

export function createEnemyViews(model: AircraftModel, capacity: number): EnemyViews {
  const group = new THREE.Group()
  // 敵は視界の外にも出る。機体と同じく視錐台の判定を切る。
  // クリップは three が個々のメッシュで行い、追従カメラの至近では
  // 境界球の判定が外れて機体が消えることがある
  group.frustumCulled = false

  const instances: Instance[] = []

  /** index 番目の複製。無ければ作る */
  function instance(index: number): Instance {
    const existing = instances[index]
    if (existing !== undefined) return existing

    const object = model.object.clone()
    object.traverse((node) => {
      node.frustumCulled = false
    })
    object.visible = false

    // 舵面のノードは複製の中から名前で引く。元のモデルの `surfaces` を
    // 渡すと全機が同じノードを回してしまう
    const nodes = new Map<string, THREE.Object3D>()
    for (const hinge of model.hinges) {
      const node = object.getObjectByName(hinge.node)
      if (node !== undefined) nodes.set(hinge.node, node)
    }

    const externalFlame = object.getObjectByName('ExternalFlame') ?? null
    if (externalFlame !== null) externalFlame.visible = false

    const created: Instance = {
      object,
      surfaces: createControlSurfaces(nodes, model.hinges),
      externalFlame,
    }
    instances[index] = created
    group.add(object)
    return created
  }

  function setThrottle(target: Instance, value: number): void {
    if (target.externalFlame === null) return
    const t = Math.min(1, Math.max(0, value))
    const lit = t > AUGMENTATION_THROTTLE
    target.externalFlame.visible = lit
    if (lit) {
      const strength = (t - AUGMENTATION_THROTTLE) / (1 - AUGMENTATION_THROTTLE)
      target.externalFlame.scale.set(1, 1, 0.55 + strength * 0.45)
    }
  }

  return {
    object: group,
    trianglesPerAircraft: model.triangles,

    get instanceCount() {
      return instances.length
    },

    get surfaceCount() {
      return instances[0]?.surfaces.count ?? 0
    },

    update(samples) {
      const used = Math.min(samples.length, capacity)
      let shown = 0
      for (let i = 0; i < used; i++) {
        const sample = samples[i]!
        // 墜落した敵は描かない。sim 側は止まったままなので、そのまま出すと
        // 残骸が空中で固まって見える
        if (sample.crashed) continue
        const target = instance(shown)
        target.object.position.set(
          sample.position.x,
          sample.position.y,
          sample.position.z,
        )
        target.object.quaternion.set(
          sample.orientation.x,
          sample.orientation.y,
          sample.orientation.z,
          sample.orientation.w,
        )
        target.surfaces.update(sample.elevator, sample.aileron, sample.rudder)
        setThrottle(target, sample.throttle)
        target.object.visible = true
        shown++
      }
      for (let i = shown; i < instances.length; i++) {
        instances[i]!.object.visible = false
      }
    },

    dispose() {
      // ジオメトリとマテリアルは元のモデルと共有。ここでは外すだけ
      group.clear()
      instances.length = 0
    },
  }
}
