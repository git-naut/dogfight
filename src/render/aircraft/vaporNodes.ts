import { DoubleSide } from 'three'
import { Fn, cos, float, mix, mx_fractal_noise_float, sin, smoothstep, uniform, uv, vec3 } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import { VAPOR, type VaporMaterial } from './vaporCone'

/**
 * ベイパーコーンの材質（段 30f の手直し、node 経路）。**雲や靄のように揺らす。**
 *
 * 頂点の色で濃さを置いた最初の版は、縁がきれいな円に写って違和感があった
 * （ユーザーの指摘、2026-10-01）。実物の凝結は機体の周りの圧力の揺らぎで崩れ、
 * 縁はちぎれて、膜の中にも濃淡の塊がある。
 *
 * - 粗いノイズで濃さの分布の境目（長さ方向）をずらし、縁を不規則にする
 * - 細かいノイズで塊のむらを付ける
 * - 模様は機首側から主翼側へ流す（空気が機体に沿って後ろへ流れる向き）
 *
 * 円周の角度は円柱の座標（cos, sin）に直してノイズを引くので、継ぎ目が出ない。
 * 時刻はフレーム番号から出すので、キャプチャの絵は決定論のまま
 */

/** 模様が流れる速さ。長さ（先 0、底 1）を 1 秒に何回分流れるか */
export const VAPOR_FLOW = 1.6
/** 縁のずれの大きさ。長さに対する割合 */
export const VAPOR_EDGE_WOBBLE = 0.25

export function createNodeVaporMaterial(): VaporMaterial {
  const strength = uniform(0)
  const time = uniform(0)

  const alpha = Fn(() => {
    const coord = uv()
    const angle = coord.x.mul(Math.PI * 2)
    const flow = coord.y.sub(time.mul(VAPOR_FLOW))
    // 円柱の座標。円周の継ぎ目を出さない
    const p = vec3(cos(angle).mul(1.6), sin(angle).mul(1.6), flow.mul(3))
    // 粗いノイズで縁をずらす
    const coarse = mx_fractal_noise_float(p, 3, 2, 0.5)
    const t = coord.y.add(coarse.mul(VAPOR_EDGE_WOBBLE))
    // **円錐の底の手前で必ず 0 に落とす。**板の縁（底の輪）は円なので、そこで切れると
    // 外周がきれいな円に写る。外周はノイズでずれた境目だけで決める
    const rim = float(1).sub(smoothstep(0.88, 1, coord.y))
    const profile = smoothstep(0.4, 0.75, t).mul(float(1).sub(smoothstep(0.72, 0.95, t))).mul(rim)
    // 細かいノイズで塊のむら。薄い所も 0 にはしない（膜が穴だらけにならない）
    // **濃淡は浅く。**深くすると迷彩の模様に見えた
    const fine = mx_fractal_noise_float(p.mul(2.2).add(vec3(5.3, 1.7, 0)), 3, 2, 0.5)
    const puff = mix(float(0.35), float(1), smoothstep(-0.4, 0.5, fine))
    return profile.mul(puff).mul(strength).mul(VAPOR.opacity)
  })()

  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec3(1, 1, 1) as unknown as Node<'vec3'>
  material.opacityNode = alpha as unknown as Node<'float'>
  material.transparent = true
  material.depthWrite = false
  material.side = DoubleSide

  return {
    material,
    setState(value, seconds) {
      strength.value = value
      time.value = seconds
    },
  }
}
