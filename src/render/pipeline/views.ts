import type { Scene } from 'three'
import { createAircraftView, type AircraftView } from '../aircraftView'
import { loadAircraftModel, type AircraftModel } from '../aircraft/model'
import { loadCarrier, placeCarrier, type Carrier } from '../carrier'
import { createTargetViews, type TargetViews } from '../targetView'
import { createEnemyViews, type EnemyViews } from '../enemyView'
import { createDamageSmoke, type DamageSmokeView } from '../damageSmoke'
import { createTracers, type Tracers } from '../weapons/tracers'
import { createMissileViews, type MissileViews } from '../weapons/missileView'
import { createMissileSmoke, type MissileSmoke } from '../weapons/missileSmoke'
import { createFlares, type Flares } from '../weapons/flares'
import { FLARE_CAPACITY } from '../../sim/weapons/flare'
import { createExplosions, type Explosions } from '../weapons/explosions'
import { BULLET_POOL } from '../../sim/weapons/gun'
import { MISSILE_COUNT } from '../../sim/combat'
import { ENEMY_MISSILE_COUNT } from '../../sim/ai/fighter'
import { EXPLOSION_POOL } from '../../sim/effects'
import { createAircraftTrails, type AircraftTrails } from '../aircraft/trails'
import { createGlRadialSprite, type RadialSpriteFactory } from '../weapons/radialSprite'
import type { QualitySettings } from '../quality'
import { MAX_TARGETS, type SceneOptions } from './types'

/**
 * 場面に置く物。バックエンドに依存しない部分。
 *
 * **写しを 2 つ作らない。**GLSL 経路と node 経路で同じ物を 2 度書くと、
 * 突き合わせる相手が定まらなくなる。この repo は段 16 と段 17b で 2 度
 * 同じ形を踏んでいて、どちらも先に共有の場所へ出してから移植している。
 *
 * ここに置けるのは「材質の作り手を差せば経路を問わない物」だけ。地形と
 * 海面は共有ユニフォームと高さテクスチャに結び付いているのでこちらには
 * 入れない（`terrainMesh.ts` と `water.ts` が自分で継ぎ目を持つ）。
 *
 * 容量の定数もここが持つ。`MISSILE_CAPACITY` は自機ぶんと敵機ぶんの和で、
 * **足りないと飛んでいるミサイルが描かれない。**
 */
const MISSILE_CAPACITY = MISSILE_COUNT + MAX_TARGETS * ENEMY_MISSILE_COUNT

export interface SceneViews {
  readonly aircraftModel: AircraftModel
  readonly aircraft: AircraftView
  readonly targetViews: TargetViews
  readonly enemyModel: AircraftModel
  readonly enemyViews: EnemyViews
  readonly carrier: Carrier | null
  readonly tracers: Tracers
  readonly missileViews: MissileViews
  readonly missileSmoke: MissileSmoke
  readonly damageSmoke: DamageSmokeView
  readonly explosions: Explosions
  readonly flares: Flares
  readonly trails: AircraftTrails
  dispose(): void
}

export interface SceneViewsInput {
  scene: Scene
  quality: QualitySettings
  options: SceneOptions
  /**
   * 円形スプライトの作り手。
   *
   * **node 経路では TSL 版を差す。**`ShaderMaterial` は node 経路で黙って
   * 描かれない（例外は出ず、コンソールに 1 行出るだけ）
   */
  sprite?: RadialSpriteFactory
}

export async function createSceneViews(input: SceneViewsInput): Promise<SceneViews> {
  const { scene, quality, options } = input
  const sprite = input.sprite ?? createGlRadialSprite

  // glb を読むのはここ 1 回だけ。自機と標的機が同じモデルを共有する。
  // 2 回読むとパースとテクスチャの復号が 2 度走り、実体が複製される
  const aircraftModel: AircraftModel = await loadAircraftModel(options.aircraftUrl)
  const aircraft: AircraftView = createAircraftView(aircraftModel)
  aircraft.object.visible = options.showAircraft ?? true
  scene.add(aircraft.object)

  // 標的機。複製は必要になった時点で作る。Phase 6 のミッションが敵 8 機なので
  // 器はそこまで用意しておく
  const targetViews: TargetViews = createTargetViews(aircraftModel, MAX_TARGETS)
  targetViews.object.visible = options.showTargets ?? true
  scene.add(targetViews.object)

  // 敵機。自機とは別の機体（F-16）なので glb も別。**敵味方が別の形になる
  // ので、ロックボックスが出ていなくても見分けられる**
  const enemyModel: AircraftModel = await loadAircraftModel(options.enemyUrl)
  const enemyViews: EnemyViews = createEnemyViews(enemyModel, MAX_TARGETS)
  enemyViews.object.visible = options.showEnemies ?? true
  scene.add(enemyViews.object)

  /**
   * 空母。**台本が要求したときだけ読む。**
   *
   * 実測で 2,644 三角形（シーン予算 1.5M の 0.18%）、glb 189 KB。
   * 動かないので視錐台の判定は残す
   */
  const carrier: Carrier | null =
    options.carrierUrl !== undefined ? await loadCarrier(options.carrierUrl) : null
  if (carrier !== null) {
    const at = options.carrier ?? { x: 0, z: 0, heading: 0 }
    placeCarrier(carrier, at.x, at.z, at.heading)
    scene.add(carrier.object)
  }

  // 曳光弾。5 発に 1 発なので線分は 55 本ぶん確保すれば足りるが、
  // プールと同じ大きさにしておけば割合を変えても壊れない
  const tracers: Tracers = createTracers(BULLET_POOL)
  tracers.object.visible = options.showTracers ?? true
  scene.add(tracers.object)

  // ミサイルの本体と煙
  // **敵のミサイルぶんも要る。**容量が足りないと、飛んでいるのに描かれない
  const missileViews: MissileViews = createMissileViews(MISSILE_CAPACITY)
  missileViews.object.visible = options.showMissiles ?? true
  scene.add(missileViews.object)
  const missileSmoke: MissileSmoke = createMissileSmoke(MISSILE_CAPACITY, quality)
  missileSmoke.object.visible = options.showSmoke ?? true
  scene.add(missileSmoke.object)

  // ダメージの煙。敵機ごとに 1 本
  const damageSmoke: DamageSmokeView = createDamageSmoke(MAX_TARGETS, quality)
  damageSmoke.object.visible = options.showDamageSmoke ?? true
  scene.add(damageSmoke.object)

  // 爆発。同時に生きるのは撃墜が重なったときくらいなので 8 個
  const explosions: Explosions = createExplosions(EXPLOSION_POOL, quality, sprite)
  explosions.object.visible = options.showExplosions ?? true
  scene.add(explosions.object)

  // フレア。積んでいる数ぶんの器を作る。同時に燃えるのはもっと少ないが、
  // 器を増やさないので使い回しで足りる
  // 自機ぶん + 敵 8 機ぶん。同時に燃えるのはずっと少ないが、器を使い回す
  const flares: Flares = createFlares(FLARE_CAPACITY * (1 + MAX_TARGETS), quality, sprite)
  flares.object.visible = options.showFlares ?? true
  scene.add(flares.object)

  // コントレイルと翼端渦。履歴は sim が持つので、ここは読んで張るだけ
  const trails: AircraftTrails = createAircraftTrails(quality)
  trails.object.visible = options.showTrails ?? true
  scene.add(trails.object)

  return {
    aircraftModel,
    aircraft,
    targetViews,
    enemyModel,
    enemyViews,
    carrier,
    tracers,
    missileViews,
    missileSmoke,
    damageSmoke,
    explosions,
    flares,
    trails,

    dispose() {
      explosions.dispose()
      // **もとの `webgl.ts` はフレアを破棄していなかった。**`dispose()` は
      // 実装されているのに呼ばれておらず、板のジオメトリと材質が残る。
      // 抜き出すついでに直した（絵は動かない。破棄は終了時にしか走らない）
      flares.dispose()
      missileSmoke.dispose()
      damageSmoke.dispose()
      missileViews.dispose()
      tracers.dispose()
      targetViews.dispose()
      enemyViews.dispose()
      aircraft.dispose()
      // ジオメトリとマテリアルの実体はモデルが持つ。自機と標的で共有して
      // いるので、破棄はここで 1 回だけ
      aircraftModel.dispose()
      enemyModel.dispose()
      trails.dispose()
    },
  }
}
