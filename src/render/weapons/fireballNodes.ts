import { Discard, Fn, float, length, max, mix, mx_fractal_noise_float, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import { DoubleSide, NormalBlending, type Material } from 'three'
import { BALL_INSET, SHAPE_AMPLITUDE } from './fireballShape'

/**
 * 火の玉の板（段 29、node 経路）。
 *
 * **円形スプライトでは黒煙の縁が作れなかった。**中心から外へ滑らかに薄くなる
 * だけの板は、なだらかにすると薄い灰色のにじみ、平らにすると輪郭の切れた灰色の
 * 円盤になった。参考画像の縁は、火の玉の輪郭に沿った不規則な暗い帯。
 *
 * 1 枚の板の中で、中心から外へ 明るい橙 → 暗い赤 → 黒い煤 と色を変え、輪郭と
 * 色の境目をノイズで揺らす。**熱（`heat`）が下がると火の領域が縮み**、全体が
 * 煤の色へ移って黒い煙の塊になる。形は爆発ごとの種（`seed`）と経過秒（`age`）で
 * うねる。経過秒はフレーム番号から出すので決定論は保たれる。
 *
 * 白く飛んだ芯は、この板の上に加算の円形スプライトを重ねる（`explosions.ts`）。
 * GLSL 経路は WebGPU が無いときの退避路なので、従来の円形スプライトのまま
 */

/** 火の中心の色。**露出前の値。**露出 6 倍で白に近い橙へ飛ぶ */
export const FIRE_HOT_COLOR = { r: 2.4, g: 0.9, b: 0.22 }
/** 火の外側の暗い赤 */
export const FIRE_COOL_COLOR = { r: 0.35, g: 0.045, b: 0.012 }
/** 煤の色。**色味を持たせない**（判定道具は色味の強い谷を火と読む） */
export const SOOT_COLOR = { r: 0.012, g: 0.011, b: 0.01 }
/**
 * 冷めた煙の色。暗い灰茶。**熱が 0 に向かうにつれて煤からこの色へ移る。**
 *
 * 煤のままだと、0.5 秒以降の煙が重たい黒い塊として残った。色味は判定道具の
 * 上限（0.15）の内側に収める
 */
export const SMOKE_AGED_COLOR = { r: 0.05, g: 0.046, b: 0.043 }
/** 冷めた煙の不透明度。空をわずかに透かす */
export const SMOKE_AGED_OPACITY = 0.8
/**
 * 火の領域が板に占める割合の上限。**外周に煤の帯の場所を空ける。**
 *
 * 0.72 では火が輪郭の消え際まで届き、熱いうちは黒い縁が出なかった
 */
export const FIRE_EXTENT = 0.5

export interface FireballState {
  /** 不透明度 0..1 */
  opacity: number
  /** 熱 0..1。1 で火が板の 6 割を占め（外周は煤の帯）、0 で全体が冷めた煙 */
  heat: number
  /** 爆発ごとの種。形を変える */
  seed: number
  /** 経過秒。形のうねり */
  age: number
}

export interface FireballSprite {
  material: Material
  setState(state: FireballState): void
}

export type FireballSpriteFactory = () => FireballSprite

export function createNodeFireballSprite(): FireballSprite {
  const opacity = uniform(0)
  const heat = uniform(1)
  const seed = uniform(0)
  const age = uniform(0)

  const rgba = Fn(() => {
    const p = uv().sub(0.5).toVar()
    const d = length(p).mul(2).toVar()
    // 輪郭のうねり。低い周波数で大きく揺らす
    const shape = mx_fractal_noise_float(
      vec3(p.mul(2.4), seed.add(age.mul(0.6))),
      3,
      2,
      0.5,
    ).toVar()
    // **輪郭を板の内側に収める。**`d + ノイズ` のままだと、ノイズが負の所で輪郭が
    // 板の端（d = 1）の外まで伸び、四角い縁でまっすぐ切れた（段 29b の基準画像
    // `hud-mission-failed`）。距離を `BALL_INSET` 倍して、ノイズが −1 でも板の中で閉じる
    const edge = d.mul(BALL_INSET).add(shape.mul(SHAPE_AMPLITUDE)).toVar()
    Discard(edge.greaterThan(1).or(d.greaterThan(1)))
    // 色の境目のうねり。細かく揺らして煤の帯を不規則にする
    const grain = mx_fractal_noise_float(vec3(p.mul(7.0), seed.mul(1.7).add(age.mul(1.1))), 2, 2, 0.5)
    const fireRadius = max(heat.mul(FIRE_EXTENT), float(0.02)).toVar()
    const inner = edge.add(grain.mul(0.12)).toVar()
    const fire = mix(
      vec3(FIRE_HOT_COLOR.r, FIRE_HOT_COLOR.g, FIRE_HOT_COLOR.b),
      vec3(FIRE_COOL_COLOR.r, FIRE_COOL_COLOR.g, FIRE_COOL_COLOR.b),
      smoothstep(float(0), fireRadius, inner),
    )
    const soot = smoothstep(fireRadius.sub(0.06), fireRadius.add(0.08), inner)
    // 冷めるほど煤は灰茶へ明るくなり、空を透かす
    const cooled = float(1).sub(heat)
    const sootColor = mix(
      vec3(SOOT_COLOR.r, SOOT_COLOR.g, SOOT_COLOR.b),
      vec3(SMOKE_AGED_COLOR.r, SMOKE_AGED_COLOR.g, SMOKE_AGED_COLOR.b),
      cooled,
    )
    const color = mix(fire, sootColor, soot)
    // 縁はノイズで揺れた輪郭の手前で柔らかく消す。**煤の帯（0.62〜0.8）を残す**
    const body = mix(float(1), float(SMOKE_AGED_OPACITY), soot.mul(cooled))
    // 板の端の手前でも消す。ノイズが −1 を割る所の保険
    const a = float(1)
      .sub(smoothstep(0.82, 1.0, edge))
      .mul(float(1).sub(smoothstep(0.9, 1.0, d)))
      .mul(body)
      .mul(opacity)
    return vec4(color, a)
  })()

  const material = new MeshBasicNodeMaterial()
  material.colorNode = (rgba as unknown as { rgb: Node<'vec3'> }).rgb
  material.opacityNode = (rgba as unknown as { a: Node<'float'> }).a
  material.transparent = true
  material.blending = NormalBlending
  material.depthWrite = false
  material.side = DoubleSide

  return {
    material,
    setState(state) {
      opacity.value = state.opacity
      heat.value = state.heat
      seed.value = state.seed
      age.value = state.age
    },
  }
}
