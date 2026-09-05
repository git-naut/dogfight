import {
  Fn,
  If,
  clamp,
  cos,
  dot,
  float,
  floor,
  ivec2,
  max,
  min,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  texture,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Texture } from 'three'
import { terrainHeightNode, terrainHeightNearestNode, type HeightFieldInputs } from './heightNodes'

/**
 * 地表と海面の色を TSL で書く。
 *
 * `shaders/terrainSurface.glsl` と `shaders/waterSurface.glsl` の写し。
 * **突き合わせる相手は 1 つ。**GLSL 側も断片シェーダではなく共有のチャンクを
 * 読むので、比べているのは同じ本体になる。
 *
 * `terrainAircraftShade` は移さない。node 経路では `shadow(light)` が
 * 係数を返すので、関数ごと消えて引数になる（段 15 と ADR 0010）。
 *
 * 枝を通ったかどうかは呼び出し側の `.toVar()` へ書き込む。GLSL の `out`
 * 引数にあたる形で、`marchNodes.ts` の `lightOpticalDepth` が `inout int`
 * を写したのと同じ作り（`setLayout` を付けない `Fn`）。
 */

export interface SurfaceInputs extends HeightFieldInputs {
  /** 焼いた法線。`DataTexture` なので v の裏返しは掛からない */
  terrainNormalMap: Texture
  /**
   * 雲影マップ。
   *
   * **焼く側で v を打ち消してある。**node 経路はレンダーターゲットを引くとき
   * v を裏返すので、焼くときに裏返しておけば GLSL と同じ uv で読める
   * （`cloudsNodePass.ts` の注記）
   */
  cloudShadowMap: Texture
  cloudShadowCenter: Node<'vec2'>
  cloudShadowExtent: Node<'float'>
  /** 0 で雲影を切る */
  cloudShadowEnabled: Node<'float'>
  sunDirectionWorld: Node<'vec3'>
  sunRadiance: Node<'vec3'>
  skyRadiance: Node<'vec3'>
}

/** 標高の境目をばらつかせる。等高線に見えないようにするため */
const BLEND_NOISE_SCALE = 900
/** 法線の摂動が効く距離 m。これより遠いと解像できず折り返しノイズになる */
const DETAIL_NEAR = 700
const DETAIL_FAR = 3000
/** 摂動の周期 m */
const DETAIL_SCALE = 34
/** 摂動の強さ。1.6 だと迷彩柄に見えた */
const DETAIL_STRENGTH = 0.22

/** 深い海の色。散乱で青緑に見える */
const DEEP_WATER = [0.015, 0.055, 0.085] as const
/** 浅瀬の色 */
const SHALLOW_WATER = [0.08, 0.22, 0.24] as const
/** 浅瀬と見なす深さ m */
const SHALLOW_DEPTH = 90
/** 白波が立つ深さ m */
const FOAM_DEPTH = 16

/** 拡散反射の 1/pi。three の BRDF_Lambert と同じ式にする */
const RECIPROCAL_PI = 0.3183098861837907

/**
 * 座標から引ける整数ハッシュ。
 *
 * `sin` は使わない（実装ごとに結果が変わる）。成分ごとにスカラで書くのは
 * `@types/three` の整数ビット演算が `uvec2` に型を付けないため
 * （`noiseNodes.ts` の `pcg3d` と同じ理由）
 */
const hash21 = Fn(([p]: [Node<'vec2'>]) => {
  const cell = ivec2(floor(p)).toVar()
  const ux = uint(cell.x.add(8192)).toVar()
  const uy = uint(cell.y.add(8192)).toVar()
  const h = ux.mul(uint(1664525)).add(uy.mul(uint(1013904223))).toVar()
  h.assign(h.bitXor(h.shiftRight(uint(16))))
  h.assign(h.mul(uint(2246822519)))
  h.assign(h.bitXor(h.shiftRight(uint(13))))
  return float(h).mul(2 ** -32)
}).setLayout({
  name: 'dogfightTerrainHash21',
  type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }],
})

const valueNoise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p).toVar()
  const f = p.sub(i).toVar()
  const w = f.mul(f).mul(float(3).sub(f.mul(2))).toVar()
  const a = hash21(i).toVar()
  const b = hash21(i.add(vec2(1, 0))).toVar()
  const c = hash21(i.add(vec2(0, 1))).toVar()
  const d = hash21(i.add(vec2(1, 1))).toVar()
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y)
}).setLayout({
  name: 'dogfightTerrainValueNoise',
  type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }],
})

/** 焼いた法線。双三次で 4 回引くと 1 画素 64 タップになるので焼いてある */
export function terrainNormalNode(
  inputs: SurfaceInputs,
  worldXZ: Node<'vec2'>,
): Node<'vec3'> {
  const uvw = worldXZ.add(inputs.extent * 0.5).div(inputs.extent)
  return normalize(
    texture(inputs.terrainNormalMap, uvw).xyz.mul(2).sub(1),
  ) as unknown as Node<'vec3'>
}

/**
 * 雲影の明るさ 0..1。1 なら日向。
 *
 * 影マップは「(x, 0, z) から太陽へ向かう光線の透過率」を持っている。標高 h の
 * 点が欲しい値は、同じ光線を y=0 まで延ばした足元の値と一致する。
 *
 * TSL は値を返す早期 return を持たないので、既定値を入れた var を素通り
 * させる形で写す。通る経路は同じになる。
 */
export function terrainCloudShadeNode(
  inputs: SurfaceInputs,
  world: Node<'vec3'>,
): Node<'float'> {
  return Fn(() => {
    const result = float(1).toVar()

    If(inputs.cloudShadowEnabled.greaterThanEqual(0.5), () => {
      const sun = inputs.sunDirectionWorld
      const offset = sun.y
        .greaterThan(0.05)
        .select(sun.xz.mul(world.y.div(sun.y)), vec2(0, 0))
        .toVar()
      const uvw = world.xz
        .sub(offset)
        .sub(inputs.cloudShadowCenter)
        .div(inputs.cloudShadowExtent)
        .add(0.5)
        .toVar()

      const edge = min(uvw, float(1).sub(uvw)).toVar()
      const inside = smoothstep(0, 0.07, min(edge.x, edge.y)).toVar()
      If(inside.greaterThan(0), () => {
        const shade = texture(inputs.cloudShadowMap, clamp(uvw, 0, 1)).r.toVar()
        // 影でも真っ暗にはしない。空からの散乱光は雲があっても届く
        result.assign(mix(float(1), mix(float(0.42), float(1), shade), inside))
      })
    })

    return result
  })() as Node<'float'>
}

/**
 * 地表の色、または通った枝。
 *
 * **枝は `out` 引数では返せない。**GLSL は `out vec3 branches` で受けるが、
 * TSL で同じ形にすると枝が全部 0 になった。色を使わない呼び方をすると
 * 本体そのものが生成されないため（`docs/lessons.md` の「`Fn` の返り値を
 * 使わないと本体が生成されない」）。**JS の分岐で出すものを選ぶ。**
 * 生成時に決まるので実行時の分岐は残らない（段 16 の `OPAQUE_CORE` と同じ）。
 *
 * @param detailNormals 0 か 1。近距離の凹凸を法線の摂動で出すか
 * @param aircraftShade 機体の影の明るさ 0..1。node 経路は `shadow(light)`
 * @param branchMode    枝を返すか。R が摂動、G が雪、B が急斜面の岩
 */
export function terrainSurfaceNode(
  inputs: SurfaceInputs,
  world: Node<'vec3'>,
  cameraPos: Node<'vec3'>,
  detailNormals: Node<'float'>,
  aircraftShade: Node<'float'>,
  branchMode = false,
): Node<'vec4'> {
  const impl = Fn(
    ([w, camera, useDetail, shadeIn]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
    ]) => {
      const normal = terrainNormalNode(inputs, w.xz).toVar()
      const toCamera = w.distance(camera).toVar()
      // 枝は成分ごとに持つ。**var の swizzle へは代入しない**
      const detailFlag = float(0).toVar()
      const snowFlag = float(0).toVar()
      const rockFlag = float(0).toVar()

      // 近距離だけ法線を揺らす。解像できない距離で細かい起伏を拾っても
      // 折り返しノイズにしかならない
      If(useDetail.greaterThanEqual(0.5), () => {
        const strength = float(1)
          .sub(smoothstep(DETAIL_NEAR, DETAIL_FAR, toCamera))
          .toVar()
        If(strength.greaterThan(0.01), () => {
          detailFlag.assign(1)
          const p = w.xz.div(DETAIL_SCALE).toVar()
          const e = 0.5
          const nx = valueNoise(p.add(vec2(e, 0)))
            .sub(valueNoise(p.sub(vec2(e, 0))))
            .toVar()
          const nz = valueNoise(p.add(vec2(0, e)))
            .sub(valueNoise(p.sub(vec2(0, e))))
            .toVar()
          // 二段目。周波数を上げて振幅を半分にする
          const q = p.mul(2.7).toVar()
          nx.addAssign(
            valueNoise(q.add(vec2(e, 0))).sub(valueNoise(q.sub(vec2(e, 0)))).mul(0.5),
          )
          nz.addAssign(
            valueNoise(q.add(vec2(0, e))).sub(valueNoise(q.sub(vec2(0, e)))).mul(0.5),
          )
          normal.assign(
            normalize(
              normal.add(vec3(nx, 0, nz).mul(DETAIL_STRENGTH).mul(strength)),
            ),
          )
        })
      })

      // 傾斜。1 が平ら、0 が垂直
      const flatness = clamp(normal.y, 0, 1).toVar()

      // 境目をばらつかせる。まっすぐだと等高線に見える
      const wobble = valueNoise(w.xz.div(BLEND_NOISE_SCALE)).sub(0.5).mul(190).toVar()
      const h = w.y.add(wobble).toVar()

      const sand = vec3(0.62, 0.56, 0.42)
      const grass = vec3(0.2, 0.3, 0.15)
      // 0.31 だと夕方に岩肌が白っぽく飛んだ
      const rock = vec3(0.22, 0.21, 0.19)
      const snowColor = vec3(0.86, 0.88, 0.92)

      const albedo = vec3(sand).toVar()
      albedo.assign(mix(albedo, grass, smoothstep(20, 140, h)))
      albedo.assign(mix(albedo, rock, smoothstep(700, 1400, h)))
      // 雪は緩い面に積もる。標高だけで決めると稜線に白い点が散る
      const snow = smoothstep(2000, 2180, h).mul(smoothstep(0.62, 0.82, flatness)).toVar()
      albedo.assign(mix(albedo, snowColor, snow))
      If(snow.greaterThan(0), () => {
        snowFlag.assign(1)
      })

      // 急斜面は標高によらず岩
      const rockMix = smoothstep(0.52, 0.8, flatness).toVar()
      albedo.assign(mix(rock, albedo, rockMix))
      If(rockMix.lessThan(1), () => {
        rockFlag.assign(1)
      })

      // 色そのものを少しばらつかせる
      const mottle = valueNoise(w.xz.div(130))
        .add(valueNoise(w.xz.div(41)).mul(0.5))
        .toVar()
      const mottleFade = float(1)
        .sub(smoothstep(DETAIL_NEAR, DETAIL_FAR * 2, toCamera))
        .toVar()
      albedo.mulAssign(
        float(1).add(mottle.div(1.5).sub(0.5).mul(0.22).mul(mottleFade)),
      )

      const shade = terrainCloudShadeNode(inputs, w).mul(shadeIn).toVar()
      const lambert = max(dot(normal, inputs.sunDirectionWorld), 0).toVar()

      if (branchMode) return vec4(detailFlag, snowFlag, rockFlag, 1)

      return vec4(
        albedo.mul(
          inputs.sunRadiance
            .mul(lambert)
            .mul(shade)
            .mul(RECIPROCAL_PI)
            .add(inputs.skyRadiance),
        ),
        1,
      )
    },
  )
  return impl(world, cameraPos, detailNormals, aircraftShade) as unknown as Node<'vec4'>
}

/**
 * 波の法線。遠くでは細かい波を解像できないので落とす。
 *
 * 掛けたかどうかを 4 つ目の枝として返す。**`Fn` の引数で書き戻す**
 * （閉包では戻らない。`terrainSurfaceColorNode` の注記）
 */
const waterWaveNormalNode = Fn(
  ([worldXZ, toCamera, waveTime, applied]: [
    Node<'vec2'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
  ]) => {
    const strength = float(1).sub(smoothstep(2000, 12000, toCamera)).toVar()
    const result = vec3(0, 1, 0).toVar()
    applied.assign(0)

    If(strength.greaterThanEqual(0.01), () => {
      applied.assign(1)
      // 波長と向きの違う 3 本。同じ向きだと縞に見える
      const a = vec2(0.86, 0.51)
      const b = vec2(-0.42, 0.91)
      const c = vec2(0.62, -0.78)

      const pa = dot(worldXZ, a).div(47).add(waveTime.mul(0.9)).toVar()
      const pb = dot(worldXZ, b).div(29).add(waveTime.mul(1.31)).toVar()
      const pc = dot(worldXZ, c).div(71).sub(waveTime.mul(0.6)).toVar()

      const slope = a
        .mul(cos(pa))
        .mul(0.03)
        .add(b.mul(cos(pb)).mul(0.022))
        .add(c.mul(cos(pc)).mul(0.016))
        .toVar()

      result.assign(
        normalize(
          vec3(slope.x.negate().mul(strength), 1, slope.y.negate().mul(strength)),
        ),
      )
    })

    return result
  },
)

/**
 * 海面の色、または通った枝。
 *
 * 出すものを JS の分岐で選ぶ理由は `terrainSurfaceNode` の注記と同じ。
 *
 * @param waterSpecular 0 か 1。太陽のスペキュラを乗せるか
 * @param branchMode    枝を返すか。R が 1 タップ、G が双三次、B が白波、A が波
 */
export function waterSurfaceNode(
  inputs: SurfaceInputs,
  world: Node<'vec3'>,
  cameraPos: Node<'vec3'>,
  waveTime: Node<'float'>,
  waterSpecular: Node<'float'>,
  aircraftShade: Node<'float'>,
  branchMode = false,
): Node<'vec4'> {
  const impl = Fn(
    ([w, camera, time, useSpecular, shadeIn]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
    ]) => {
      const toCamera = w.distance(camera).toVar()
      const waveFlag = float(0).toVar()
      const tapFlag = float(0).toVar()
      const bicubicFlag = float(0).toVar()
      const foamFlag = float(0).toVar()
      const normal = waterWaveNormalNode(w.xz, toCamera, time, waveFlag).toVar()

      // まず 1 タップで粗く見て、浅瀬にも白波にも掛からない深さなら双三次を
      // 引かない。海面の板は水平線まで覆うので、ここを 16 タップで払うと
      // 画面のほとんどでその費用が乗る
      const coarse = terrainHeightNearestNode(inputs, w.xz).toVar()
      const depth = float(0).toVar()
      If(coarse.lessThan(-(SHALLOW_DEPTH + 160)), () => {
        depth.assign(coarse.negate())
        tapFlag.assign(1)
      }).Else(() => {
        depth.assign(max(terrainHeightNode(inputs, w.xz).negate(), 0))
        bicubicFlag.assign(1)
      })

      const body = mix(
        vec3(SHALLOW_WATER[0], SHALLOW_WATER[1], SHALLOW_WATER[2]),
        vec3(DEEP_WATER[0], DEEP_WATER[1], DEEP_WATER[2]),
        smoothstep(0, SHALLOW_DEPTH, depth),
      ).toVar()

      const view = normalize(camera.sub(w)).toVar()
      // Schlick 近似。水の垂直入射反射率は 0.02
      const cosTheta = max(dot(view, normal), 0).toVar()
      const fresnel = float(0.02).add(pow(float(1).sub(cosTheta), 5).mul(0.98)).toVar()

      const shade = terrainCloudShadeNode(inputs, w).mul(shadeIn).toVar()

      // 空の反射。天空光をそのまま使う
      const reflected = inputs.skyRadiance.mul(3).toVar()

      const color = mix(
        body.mul(inputs.skyRadiance.add(inputs.sunRadiance.mul(0.12).mul(shade))),
        reflected,
        fresnel,
      ).toVar()

      // 白波。深さで強さを決め、波の位相で濃淡を付ける
      const foam = float(1).sub(smoothstep(0, FOAM_DEPTH, depth)).toVar()
      If(foam.greaterThan(0), () => {
        foamFlag.assign(1)
        const band = float(0.5)
          .add(sin(dot(w.xz, vec2(0.86, 0.51)).div(23).add(time.mul(1.7))).mul(0.5))
          .toVar()
        const amount = foam.mul(foam).mul(float(0.3).add(band.mul(0.7))).toVar()
        const foamColor = inputs.sunRadiance
          .mul(0.3)
          .mul(shade)
          .add(inputs.skyRadiance.mul(3))
          .toVar()
        color.assign(mix(color, foamColor, amount.mul(0.85)))
      })

      If(useSpecular.greaterThanEqual(0.5), () => {
        // 太陽の映り込み。海面の高度感を作る要素なので落とさない
        const halfway = normalize(view.add(inputs.sunDirectionWorld)).toVar()
        const specular = pow(max(dot(normal, halfway), 0), 900).toVar()
        // 2.5 だと低空で真下が白く飛んだ
        color.addAssign(inputs.sunRadiance.mul(specular).mul(0.9).mul(shade))
      })

      if (branchMode) return vec4(tapFlag, bicubicFlag, foamFlag, waveFlag)
      return vec4(color, 1)
    },
  )
  return impl(
    world,
    cameraPos,
    waveTime,
    waterSpecular,
    aircraftShade,
  ) as unknown as Node<'vec4'>
}
