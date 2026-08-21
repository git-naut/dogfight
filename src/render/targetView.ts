import * as THREE from 'three'
import type { AircraftModel } from './aircraft/model'
import type { TargetSample } from '../sim/target'

/**
 * 標的機の表示。
 *
 * **glb は読み直さない。**`loadAircraftModel` をもう一度呼ぶと、パースと
 * テクスチャの復号がもう一度走り、ジオメトリとマテリアルが複製される。
 * 出すのは自機と同じ機体なので、読み込み済みのモデルを `clone()` で増やす。
 * three の `clone()` はジオメトリとマテリアルを参照で共有するので、増えるのは
 * ノードの器だけ。三角形は 1 機ぶん（18,634）が実際に描かれる回数だけ増える。
 *
 * **後始末は複製側でしない。**ジオメトリとマテリアルは元のモデルと同じ実体を
 * 指しているので、ここで dispose すると自機の機体まで壊れる。破棄は
 * `scene.ts` が元のモデルに対して 1 回だけ行う。
 *
 * 舵面は動かさない。標的は直進か定常旋回しかせず、定常旋回のバンクは中立の
 * 舵で保たれる。だから `createControlSurfaces` は通さない。
 *
 * 影も落とさない。遮蔽物を自機だけにする Phase 4 の判断を維持する
 * （`aircraftShadow` は機体 1 機を囲む正射影の箱 1 つで組んである）。
 */

export interface TargetViews {
  readonly object: THREE.Object3D
  /** 実際に作った複製の数。予算の確認に使う */
  readonly instanceCount: number
  /**
   * 標的の位置と姿勢を反映する。
   *
   * 渡された数だけ見せ、余りは隠す。複製は必要になった時点で作る。
   */
  update(samples: readonly TargetSample[]): void
  dispose(): void
}

export function createTargetViews(
  model: AircraftModel,
  capacity: number,
): TargetViews {
  const group = new THREE.Group()
  // 標的は視界の外にも出る。機体と同じく視錐台の判定を切る。
  // クリップは three が個々のメッシュで行い、追従カメラの至近では
  // 境界球の判定が外れて機体が消えることがある
  group.frustumCulled = false

  const instances: THREE.Object3D[] = []

  /** index 番目の複製。無ければ作る */
  function instance(index: number): THREE.Object3D {
    const existing = instances[index]
    if (existing !== undefined) return existing

    const clone = model.object.clone()
    clone.traverse((node) => {
      node.frustumCulled = false
    })
    clone.visible = false
    instances[index] = clone
    group.add(clone)
    return clone
  }

  return {
    object: group,

    get instanceCount() {
      return instances.length
    },

    update(samples) {
      const used = Math.min(samples.length, capacity)
      let shown = 0
      for (let i = 0; i < used; i++) {
        const sample = samples[i]!
        // 落ちた標的は描かない。sim 側は止まったままなので、そのまま出すと
        // 残骸が空中で固まって見える。落下と爆発は爆発の段で入れる
        if (!sample.alive) continue
        const node = instance(shown)
        node.position.set(sample.position.x, sample.position.y, sample.position.z)
        node.quaternion.set(
          sample.orientation.x,
          sample.orientation.y,
          sample.orientation.z,
          sample.orientation.w,
        )
        node.visible = true
        shown++
      }
      for (let i = shown; i < instances.length; i++) instances[i]!.visible = false
    },

    dispose() {
      // ジオメトリとマテリアルは元のモデルと共有。ここでは外すだけ
      group.clear()
      instances.length = 0
    },
  }
}
