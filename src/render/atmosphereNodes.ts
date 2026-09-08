import { vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { IlluminanceProvider } from './terrain/surfaceNodes'

/**
 * 大気の LUT から照度を引く道具。
 *
 * **ワールド座標をそのまま渡せない。**大気は ECEF の単位空間で解かれて
 * いるので、`matrixWorldToECEF` を掛けて `worldToUnit` で縮める。高度の
 * 補正が有効なときは `altitudeCorrectionECEF` を足す。この 3 段を忘れると
 * 例外は出ないまま値が桁ごとずれる。
 *
 * **機体と同じ式になる。**`AtmosphereLightNode` は間接に
 * `getIndirectIlluminance` を使い、直達は太陽放射照度に透過率と
 * `max(N・L, 0)` を掛ける。`getSplitIlluminance` はその 2 つを 1 度に
 * 返す（`getSplitIrradiance` が同じ式で組んでいる）ので、地形と機体の光が
 * 同じ式で決まる。
 *
 * **写しを 2 つ作らない。**プローブと本番の場面で同じ写し替えを 2 度書くと、
 * 片方だけ直したときに気づけない（段 20a-2-3）。
 *
 * 大気のモジュールは引数で受ける。`@takram/three-atmosphere/webgpu` は
 * node 経路でしか使わないので、静的に import すると既定の経路の束にも
 * 入ってしまう。呼ぶ側が動的に読んだものを渡す。
 */
type AtmosphereWebgpu = typeof import('@takram/three-atmosphere/webgpu')

/** `AtmosphereContext` のうち、写し替えに要る面だけ */
export interface AtmosphereContextLike {
  parametersNode: unknown
  matrixWorldToECEF: unknown
  correctAltitude: boolean
  altitudeCorrectionECEF: unknown
  sunDirectionECEF: unknown
}

/** 余弦を含む照度と含まない照度。名前で引く形は takram の struct に合わせる */
interface SplitIlluminance {
  get(name: string): Node<'vec3'>
}

export interface AtmosphereNodes {
  /** ワールドの点を大気の単位空間へ写す */
  toUnit(world: Node<'vec3'>): Node<'vec3'>
  /** 法線ぶんの余弦を含む照度。地形と海面のライティングが読む */
  illuminance: IlluminanceProvider
  /**
   * 余弦を含まない側の照度。
   *
   * 雲は法線を持たないので、太陽の見かけの明るさにこちらを使う
   */
  scalarIlluminance(world: Node<'vec3'>): SplitIlluminance
}

export function createAtmosphereNodes(
  atmos: AtmosphereWebgpu,
  context: AtmosphereContextLike,
): AtmosphereNodes {
  const worldToUnit = (context.parametersNode as { worldToUnit: Node<'float'> }).worldToUnit
  const toECEF = context.matrixWorldToECEF as Node<'mat4'>
  const sunDirectionECEF = context.sunDirectionECEF as Node<'vec3'>

  function toUnit(world: Node<'vec3'>): Node<'vec3'> {
    let positionECEF = toECEF.mul(vec4(world, 1)).xyz
    if (context.correctAltitude) {
      positionECEF = positionECEF.add(context.altitudeCorrectionECEF as Node<'vec3'>)
    }
    return positionECEF.mul(worldToUnit)
  }

  return {
    toUnit,

    illuminance(world, normal) {
      // 法線は向きなので w = 0。位置と同じ行列で回すが平行移動は乗らない
      const normalECEF = toECEF.mul(vec4(normal, 0)).xyz
      const split = atmos.getSplitIlluminance(
        toUnit(world) as never,
        normalECEF as never,
        sunDirectionECEF as never,
      ) as unknown as SplitIlluminance
      return { direct: split.get('direct'), indirect: split.get('indirect') }
    },

    scalarIlluminance(world) {
      return atmos.getSplitScalarIlluminance(
        toUnit(world) as never,
        sunDirectionECEF as never,
      ) as unknown as SplitIlluminance
    },
  }
}
