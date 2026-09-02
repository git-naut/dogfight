import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  bool,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  int,
  max,
  min,
  mix,
  mod,
  normalize,
  pow,
  screenCoordinate,
  screenSize,
  select,
  smoothstep,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { createDensityNodes, type DensityInputs } from './densityNodes'
import {
  CLOUD_BOTTOM,
  CLOUD_TOP,
  DETAIL_FAR,
  DETAIL_NEAR,
  EMPTY_SKIP,
  EXIT_TRANSMITTANCE,
  EXTINCTION,
  LIGHT_FULL_DISTANCE,
  LIGHT_HALF_DISTANCE,
  LIGHT_MARCH_LIMIT,
  LIGHT_STEP_BASE,
  MARCH_LOOP_LIMIT,
  MULTI_SCATTER_OCTAVES,
  NEAR_STEP,
  SCATTER_ALBEDO,
  START_AMP,
  TAU_PI,
} from './geometry'

/**
 * 積雲のボリュメトリックレイマーチングを TSL で書く。
 *
 * `shaders/clouds.frag`（426 行）の写し。**式を 1 つずつ写す。**定数は
 * `geometry.ts` から取り、`tests/render/densityConstants.test.ts` が GLSL の
 * 本文と突き合わせる。
 *
 * 移植で当たった 4 つの違いは、すべて実測で確かめてから書いた。
 *
 * `Fn` の返り値を使わないと本体が生成されない。GLSL の `inout int samples`
 * は `setLayout` を付けない `Fn` で写せるが、**呼び出しの結果を捨てると
 * 加算そのものが消える。**`lightOpticalDepth` は光学的厚みを返すので成立する。
 *
 * `screenCoordinate.y` は上から数える。`gl_FragCoord.y` は下から。
 * `screenSize.y - 1 - y` で揃う。**放置すると Bayer のディザが上下反転する。**
 *
 * `BAYER_8X8[64]` の表はビット式に置き換えた。`x ^ y` と `y` の下位桁から
 * 1 ビットずつ交互に積むと元の表と一致する（総当たりで確かめた）。
 *
 * `probeMode` と `useDetail` は uniform ではなく JS の定数として畳む。
 * TSL は値を返す早期 return を持たないので、モードごとに別のノードを組む
 * ほうが素直になる。切り替えるときは材質を組み直す。
 */
export interface MarchInputs extends DensityInputs {
  /**
   * 深度バッファの生の値。**この画素のぶんだけ**を渡す。
   *
   * 遮るものが無い場面では `float(1)` を渡す。テクスチャから引くのは
   * 呼び出し側の仕事で、node 経路はレンダーターゲットのテクスチャを v 反転
   * して読むため、その約束をここへ持ち込まない
   */
  sceneDepth: Node<'float'>
  inverseProjectionMatrix: Node<'mat4'>
  inverseViewMatrix: Node<'mat4'>
  cameraPositionWorld: Node<'vec3'>
  cameraNear: Node<'float'>
  cameraFar: Node<'float'>
  /** ワールド座標。太陽へ向かう向き */
  sunDirection: Node<'vec3'>
  sunColor: Node<'vec3'>
  ambientColor: Node<'vec3'>
  /** 主マーチの上限 */
  maxSteps: Node<'int'>
  /** 光マーチのステップ数 */
  lightSteps: Node<'int'>
  /** 光マーチの歩幅の伸び率 */
  lightGrowth: Node<'float'>
  maxMarchDistance: Node<'float'>
  stepGrowthScale: Node<'float'>
  /** フレームごとの開始位置のずらし */
  startJitter: Node<'float'>
  /** 画素内のずらし */
  pixelJitter: Node<'vec2'>
  /** ディテールノイズを使うか。**JS の定数で畳む** */
  useDetail: boolean
}

/** 0 = 絵、1 = 密度サンプル数、2 = 歩数を使い切ったか */
export type MarchProbeMode = 0 | 1 | 2

/**
 * Bayer 8x8 の秩序ディザ。
 *
 * GLSL は 64 要素の `const float[]` を引いている。TSL に定数配列の添字が
 * ないので、同じ並びを出すビット式へ置き換えた。`x ^ y` と `y` の下位桁から
 * 1 ビットずつ交互に積む。**表と一致する形は総当たりで確かめた。**
 */
function bayerDither(px: Node<'int'>, py: Node<'int'>): Node<'float'> {
  const x = px.bitAnd(7).toVar()
  const y = py.bitAnd(7).toVar()
  const v = x.bitXor(y).toVar()
  const index = v
    .bitAnd(1)
    .mul(32)
    .add(y.bitAnd(1).mul(16))
    .add(v.shiftRight(1).bitAnd(1).mul(8))
    .add(y.shiftRight(1).bitAnd(1).mul(4))
    .add(v.shiftRight(2).bitAnd(1).mul(2))
    .add(y.shiftRight(2).bitAnd(1))
  return float(index).mul(1 / 64)
}

/** Henyey-Greenstein 位相関数 */
const hg = Fn(([cosTheta, g]: [Node<'float'>, Node<'float'>]) => {
  const g2 = g.mul(g).toVar()
  const denom = float(1).add(g2).sub(g.mul(cosTheta).mul(2)).toVar()
  return float(1)
    .sub(g2)
    .div(float(4).mul(TAU_PI).mul(pow(max(denom, 1e-4), 1.5)))
}).setLayout({
  name: 'dogfightHg',
  type: 'float',
  inputs: [
    { name: 'cosTheta', type: 'float' },
    { name: 'g', type: 'float' },
  ],
})

/**
 * 前方散乱と後方散乱を混ぜた二重位相。
 *
 * 4π を掛けて「等方散乱を 1 とした相対値」に直してある
 */
const dualPhase = Fn(([cosTheta]: [Node<'float'>]) => {
  const p = hg(cosTheta, float(0.8))
    .mul(0.7)
    .add(hg(cosTheta, float(-0.2)).mul(0.3))
    .toVar()
  return p.mul(4).mul(TAU_PI)
}).setLayout({
  name: 'dogfightDualPhase',
  type: 'float',
  inputs: [{ name: 'cosTheta', type: 'float' }],
})

/**
 * 多重散乱の近似。
 *
 * GLSL は 3 回固定のループで、係数はすべて定数（1 / 0.5 / 0.25）。
 * JS で展開しても同じ算術になる
 */
function multiScatter(
  opticalDepth: Node<'float'>,
  cosTheta: Node<'float'>,
): Node<'vec3'> {
  const phaseFull = dualPhase(cosTheta)
  let sum: Node<'float'> | null = null
  let attenuation = 1
  let contribution = 1
  let anisotropy = 1

  for (let n = 0; n < MULTI_SCATTER_OCTAVES; n++) {
    const phase = mix(float(1), phaseFull, float(anisotropy))
    const term = float(contribution)
      .mul(phase)
      .mul(exp(opticalDepth.mul(attenuation).negate()))
    sum = sum === null ? term : sum.add(term)
    attenuation *= 0.5
    contribution *= 0.5
    anisotropy *= 0.5
  }
  return vec3(sum!)
}

export function cloudMarchFragmentNode(
  inputs: MarchInputs,
  probeMode: MarchProbeMode = 0,
): Node<'vec4'> {
  const { sampleCloudDensity } = createDensityNodes(inputs)

  /**
   * 太陽方向へマーチして光学的厚みを測る。
   *
   * `samples` は GLSL の `inout int`。**`setLayout` を付けない `Fn`** に
   * すると呼び出し側の `.toVar()` を直に触れる。three 自身が `mx_floorfrac`
   * で同じ形を使っている
   */
  const lightOpticalDepth = Fn(
    ([origin, steps, samples]: [Node<'vec3'>, Node<'int'>, Node<'int'>]) => {
      const totalDensity = float(0).toVar()
      const stepSize = float(LIGHT_STEP_BASE).toVar()
      const p = vec3(origin).toVar()

      Loop(
        { start: int(0), end: int(LIGHT_MARCH_LIMIT), type: 'int', condition: '<' },
        ({ i }) => {
          If(i.greaterThanEqual(steps), () => {
            Break()
          })
          p.addAssign(inputs.sunDirection.mul(stepSize))
          If(p.y.greaterThan(CLOUD_TOP).or(p.y.lessThan(CLOUD_BOTTOM)), () => {
            Break()
          })
          // 光マーチではディテールを見ない。効果が薄いわりに高くつく
          totalDensity.addAssign(sampleCloudDensity(p, float(0)).mul(stepSize))
          samples.addAssign(1)
          stepSize.mulAssign(inputs.lightGrowth)
        },
      )

      return totalDensity.mul(EXTINCTION)
    },
  )

  /** 深度バッファの値からカメラまでの距離 m を出す */
  const linearDistance = (
    depth: Node<'float'>,
    rayDirection: Node<'vec3'>,
  ): Node<'float'> => {
    // 空なら遮るものがない。1e9 を素通りさせる形で早期 return を写す
    const result = float(1e9).toVar()
    If(depth.lessThan(1), () => {
      const ndc = depth.mul(2).sub(1).toVar()
      const viewZ = float(2)
        .mul(inputs.cameraNear)
        .mul(inputs.cameraFar)
        .div(
          inputs.cameraFar
            .add(inputs.cameraNear)
            .sub(ndc.mul(inputs.cameraFar.sub(inputs.cameraNear))),
        )
        .toVar()
      // `-normalize(vec3(inverseViewMatrix[2]))` と同じ。列 2 は基底ベクトル
      // を掛けて取り出す
      const forward = normalize(
        inputs.inverseViewMatrix.mul(vec4(0, 0, 1, 0)).xyz,
      ).negate()
      result.assign(viewZ.div(max(dot(rayDirection, forward), 1e-4)))
    })
    return result
  }

  return Fn(() => {
    // 画素の UV からワールド空間のレイを作る。フレームごとに画素内でずらす
    const pixelUv = uv().add(inputs.pixelJitter).toVar()
    const clip = vec4(pixelUv.mul(2).sub(1), -1, 1)
    const viewPos = inputs.inverseProjectionMatrix.mul(clip).toVar()
    viewPos.divAssign(viewPos.w)
    const rayDirection = normalize(
      inputs.inverseViewMatrix.mul(vec4(viewPos.xyz, 0)).xyz,
    ).toVar()

    const sceneDistance = linearDistance(inputs.sceneDepth, rayDirection).toVar()

    // スラブとの交差
    const originY = inputs.cameraPositionWorld.y.toVar()
    const dirY = rayDirection.y.toVar()
    const inside = originY
      .greaterThanEqual(CLOUD_BOTTOM)
      .and(originY.lessThanEqual(CLOUD_TOP))

    // 空の画素の既定値。probe モードでは 1 を返して「歩いていない」を表す
    const result = vec4(0, 0, 0, probeMode > 0 ? 1 : 0).toVar()
    const start = float(0).toVar()
    const end = float(0).toVar()
    const hit = bool(false).toVar()

    If(abs(dirY).lessThan(1e-6), () => {
      If(inside, () => {
        start.assign(0)
        end.assign(sceneDistance)
        hit.assign(bool(true))
      })
    }).Else(() => {
      const toBottom = float(CLOUD_BOTTOM).sub(originY).div(dirY).toVar()
      const toTop = float(CLOUD_TOP).sub(originY).div(dirY).toVar()
      start.assign(max(min(toBottom, toTop), 0))
      end.assign(min(max(toBottom, toTop), sceneDistance))
      hit.assign(bool(true))
    })

    If(hit, () => {
      end.assign(min(end, inputs.maxMarchDistance))

      If(end.greaterThan(start), () => {
        const baseStep = float(NEAR_STEP).toVar()
        // Bayer の並びにフレームごとの位相を足す。空間だけで散らすと、同じ
        // 誤差が毎フレーム同じ場所に出るので時間方向に平均しても消えない。
        // **`screenCoordinate.y` は上から数える。**`gl_FragCoord.y` に合わせる
        const px = int(screenCoordinate.x).toVar()
        const py = int(screenSize.y).sub(1).sub(int(screenCoordinate.y)).toVar()
        const offset = fract(bayerDither(px, py).add(inputs.startJitter)).toVar()

        const cosTheta = dot(rayDirection, inputs.sunDirection).toVar()

        const scattered = vec3(0).toVar()
        const transmittance = float(1).toVar()
        const samples = int(0).toVar()

        const t = start.add(baseStep.mul(offset).mul(START_AMP)).toVar()
        // 密度ゼロの区間は大股で飛ばす。空振りに時間を使わない
        const consecutiveEmpty = int(0).toVar()
        const lastWasSkip = bool(false).toVar()
        const exhausted = bool(false).toVar()

        Loop(
          { start: int(0), end: int(MARCH_LOOP_LIMIT), type: 'int', condition: '<' },
          ({ i }) => {
            If(
              t.greaterThanEqual(end).or(transmittance.lessThan(EXIT_TRANSMITTANCE)),
              () => {
                Break()
              },
            )
            // 歩数を使い切って止まると、止まる位置が空振りの歩数で決まるため
            // カメラの移動で前後する。遠くの雲が現れたり消えたりして見える
            If(i.greaterThanEqual(inputs.maxSteps), () => {
              exhausted.assign(bool(true))
              Break()
            })

            const stepSize = baseStep
              .mul(float(1).add(t.div(inputs.stepGrowthScale)))
              .toVar()

            const p = inputs.cameraPositionWorld.add(rayDirection.mul(t)).toVar()
            // 解像できる距離でだけディテールを効かせる
            const detailStrength = inputs.useDetail
              ? float(1).sub(smoothstep(DETAIL_NEAR, DETAIL_FAR, t))
              : float(0)
            const density = sampleCloudDensity(p, detailStrength).toVar()
            samples.addAssign(1)

            If(density.greaterThan(0), () => {
              // 大股で飛び越した直後なら戻して細かい歩幅で入り直す。
              // 戻さないと雲への進入面が大股の刻みに丸められる
              If(lastWasSkip, () => {
                t.subAssign(stepSize.mul(EMPTY_SKIP - 1))
                lastWasSkip.assign(bool(false))
                consecutiveEmpty.assign(-3)
                Continue()
              })
              consecutiveEmpty.assign(0)
              lastWasSkip.assign(bool(false))

              // 遠方では自己遮蔽の細かさが見えないので段数を落とす。
              // 値が滑らかに変わるので段差にならない
              const lightN = select(
                t.lessThan(LIGHT_FULL_DISTANCE),
                inputs.lightSteps,
                select(
                  t.lessThan(LIGHT_HALF_DISTANCE),
                  inputs.lightSteps.add(1).div(2),
                  int(2),
                ),
              ).toVar()
              const tauToSun = lightOpticalDepth(p, lightN, samples).toVar()

              // powder 項。密度そのものから作る。歩幅をメートルで掛けると
              // 1 歩で飽和して常に 1 になり、意味を失う
              const powderTerm = float(1).sub(exp(density.mul(-4))).toVar()

              const luminance = inputs.sunColor
                .mul(multiScatter(tauToSun, cosTheta))
                .mul(powderTerm)
                .mul(SCATTER_ALBEDO)
                .add(inputs.ambientColor)
                .toVar()

              // 区間内の吸収を解析的に積む。段ごとに足すより滑らかになる
              const stepT = exp(density.mul(stepSize).mul(-EXTINCTION)).toVar()
              scattered.addAssign(
                transmittance.mul(float(1).sub(stepT)).mul(luminance),
              )
              transmittance.mulAssign(stepT)

              t.addAssign(stepSize)
            }).Else(() => {
              consecutiveEmpty.addAssign(1)
              // 空振りが続いたら歩幅を伸ばす。雲の縁を跨いで飛び越さないよう、
              // 1 歩は様子を見てから加速する
              const skip = consecutiveEmpty.greaterThan(1).toVar()
              t.addAssign(stepSize.mul(select(skip, float(EMPTY_SKIP), float(1))))
              lastWasSkip.assign(skip)
            })
          },
        )

        if (probeMode === 1) {
          // 整数のまま 8bit 二つに分ける。v/255 は UNORM の丸めで厳密に戻る
          // GLSL は `float(min(samples, 65535))`。整数の上限は 2^24 まで
          // 浮動小数でも厳密なので、変換してから挟んでも同じ値になる
          const c = min(float(samples), float(65535)).toVar()
          result.assign(
            vec4(floor(c.div(256)).div(255), mod(c, 256).div(255), 0, 1),
          )
        } else if (probeMode === 2) {
          result.assign(vec4(0, select(exhausted, float(1), float(0)), 0, 1))
        } else {
          const alpha = clamp(float(1).sub(transmittance), 0, 1)
          // overlay は乗算済みアルファで合成される
          result.assign(vec4(scattered, alpha))
        }
      })
    })

    return result
  })()
}
