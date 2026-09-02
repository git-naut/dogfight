import {
  Fn,
  If,
  clamp,
  exp,
  float,
  floor,
  mix,
  smoothstep,
  texture,
  texture3D,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Texture } from 'three'
import {
  CLOUD_BOTTOM,
  CLOUD_TOP,
  COVER_BAND,
  DETAIL_SCALE,
  EXTINCTION,
  SHADOW_STEPS,
  SHAPE_SCALE,
  WEATHER_SCALE,
  WIND,
} from './geometry'
import { DETAIL_SIZE, SHAPE_SIZE } from './noise'

/**
 * 雲の密度と雲影を TSL で書く。
 *
 * `shaders/density.glsl` と `shaders/cloudShadow.frag` の写し。**式を 1 つずつ
 * 写す。**定数は `geometry.ts` から取り、`tests/render/densityConstants.test.ts`
 * が GLSL の本文と突き合わせる。
 *
 * GLSL 側は `ShaderChunk` へ登録して本体のマーチと影マップで共有していた。
 * TSL では普通の ES module の import になるので、グローバル登録の副作用と
 * `?raw` が消え、型が付き、Vite の依存グラフに乗る。
 */
export interface DensityInputs {
  shapeNoise: Texture
  detailNoise: Texture
  weatherMap: Texture
  /** sim のフレーム番号から導いた秒。実時間ではない */
  cloudTime: Node<'float'>
  /** 雲量 0..1 */
  coverage: Node<'float'>
}

/**
 * 三線形補間の折れ目を消してサンプルする。
 *
 * テクセル内の位置に smoothstep をかけてから引く。境界で微分が 0 になる
 */
function smoothSample3D(tex: Texture, uvw: Node<'vec3'>, size: number): Node<'vec4'> {
  const t = uvw.mul(size).sub(0.5)
  const base = floor(t)
  const raw = t.sub(base)
  const f = raw.mul(raw).mul(float(3).sub(raw.mul(2)))
  return texture3D(tex, base.add(f).add(0.5).div(size))
}

function cloudRemap(
  v: Node<'float'>,
  inMin: Node<'float'>,
  inMax: number,
  outMin: number,
  outMax: number,
): Node<'float'> {
  const span = float(inMax).sub(inMin)
  return float(outMin).add(v.sub(inMin).div(span.max(1e-6)).mul(outMax - outMin))
}

/** 雲の密度を返すノードを作る */
export function createDensityNodes(inputs: DensityInputs) {
  const wind = vec3(WIND.x, WIND.y, WIND.z)

  const sampleCloudDensity = Fn(
    ([p, detailStrength]: [Node<'vec3'>, Node<'float'>]) => {
      // **早期 return は使えない。**TSL の `Return()` は値を返さない
      // （`expression('return')`）。GLSL が 0 を返す枝を、結果の var を
      // 0 のまま素通りさせる入れ子の `If` で写す。通る経路は同じになる
      const result = float(0).toVar()

      const h = clamp(p.y.sub(CLOUD_BOTTOM).div(CLOUD_TOP - CLOUD_BOTTOM), 0, 1).toVar()
      const drift = wind.mul(inputs.cloudTime).toVar()

      // どこに雲が湧くか。しきい値はここだけで掛ける
      const weather = texture(
        inputs.weatherMap,
        p.xz.add(drift.xz).div(WEATHER_SCALE),
      ).rgb.toVar()
      const threshold = float(1).sub(inputs.coverage).toVar()
      const cover = smoothstep(threshold, threshold.add(COVER_BAND), weather.r).toVar()

      If(cover.greaterThan(0.001), () => {
        // 高度方向の勾配。雲頂の高さは気象マップでばらつかせる
        const topLimit = mix(float(0.35), float(1), weather.g).toVar()
        const gradient = smoothstep(0, 0.1, h)
          .mul(smoothstep(topLimit, topLimit.mul(0.35), h))
          .toVar()

        If(gradient.greaterThan(0.001), () => {
          // 塊の形。低周波の Perlin-Worley を高周波の Worley で削る
          const shape = smoothSample3D(
            inputs.shapeNoise,
            p.add(drift).div(SHAPE_SCALE),
            SHAPE_SIZE,
          ).toVar()
          const fbm = shape.g.mul(0.625).add(shape.b.mul(0.25)).add(shape.a.mul(0.125))
          const base = cloudRemap(shape.r, fbm.sub(1), 1, 0, 1).toVar()

          // 塊を削り出す
          const shaped = cloudRemap(
            base,
            mix(float(1), float(0.45), cover),
            1,
            0,
            1,
          ).toVar()

          If(shaped.greaterThan(0), () => {
            // GLSL はここで `density <= 0` も見るが、`shaped > 0` かつ
            // `gradient > 0.001` なら必ず正になるので枝は増やさない
            const density = shaped.mul(gradient).toVar()

            If(detailStrength.greaterThan(0.01), () => {
              const detail = smoothSample3D(
                inputs.detailNoise,
                p.add(drift.mul(2)).div(DETAIL_SCALE),
                DETAIL_SIZE,
              ).rgb.toVar()
              const d = detail.r
                .mul(0.625)
                .add(detail.g.mul(0.25))
                .add(detail.b.mul(0.125))
              // 雲底は細かくちぎれ、雲頂はふわっと丸くなる
              const erosion = mix(d, float(1).sub(d), clamp(h.mul(4), 0, 1))
              const eroded = cloudRemap(density, erosion.mul(0.45), 1, 0, 1)
              density.assign(mix(density, eroded.max(0), detailStrength))
            })

            result.assign(clamp(density, 0, 1))
          })
        })
      })

      return result
    },
  )

  return { sampleCloudDensity }
}

/**
 * 雲影マップ 1 枚ぶんの色を返すノード。
 *
 * 真上から見た正方形の領域について、地表の各点から太陽方向へマーチし、
 * 雲層を抜けるまでの光学的厚みを積む。出力は透過率
 */
export function cloudShadowFragmentNode(
  inputs: DensityInputs,
  uv: Node<'vec2'>,
  shadowCenter: Node<'vec2'>,
  shadowExtent: Node<'float'>,
  sunDirection: Node<'vec3'>,
): Node<'vec4'> {
  const { sampleCloudDensity } = createDensityNodes(inputs)

  return Fn(() => {
    // 太陽が地平線より下なら影を論じる意味がない。日向で埋める
    const result = vec4(1).toVar()

    // テクセルの中心が受け持つ地表の点
    const worldXZ = shadowCenter.add(uv.sub(0.5).mul(shadowExtent)).toVar()
    const groundPoint = vec3(worldXZ.x, 0, worldXZ.y).toVar()

    If(sunDirection.y.greaterThan(0.02), () => {
      // 地表から雲層へ入るまで一気に進み、そこから雲頂まで刻む
      const toBottom = float(CLOUD_BOTTOM).sub(groundPoint.y).div(sunDirection.y).toVar()
      const toTop = float(CLOUD_TOP).sub(groundPoint.y).div(sunDirection.y).toVar()
      const stepSize = toTop.sub(toBottom).div(SHADOW_STEPS).toVar()

      const totalDensity = float(0).toVar()
      // 歩数は JS の定数なので展開する。GLSL 側も同じ形に展開される
      for (let i = 0; i < SHADOW_STEPS; i++) {
        const t = toBottom.add(stepSize.mul(i + 0.5))
        const p = groundPoint.add(sunDirection.mul(t))
        // 影ではディテールを見ない。輪郭の細かさは地面では判別できない
        totalDensity.addAssign(sampleCloudDensity(p, float(0)).mul(stepSize))
      }

      const transmittance = exp(totalDensity.mul(-EXTINCTION))
      result.assign(vec4(vec3(transmittance), 1))
    })

    return result
  })()
}
