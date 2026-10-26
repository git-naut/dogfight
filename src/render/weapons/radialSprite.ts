import type * as THREE from 'three'

/**
 * 中心から縁へ落ちる円形のスプライト。
 *
 * 爆発とフレアが同じものを使う。**もとは 2 つのファイルに写しで置いてあった。**
 * 段 16 で TSL へ移すとき、写しが 2 つあると突き合わせる相手が定まらないので
 * 正本を 1 つにした。`explosions.ts` 側は `#ifdef` を立てないので、
 * 振る舞いは以前と同じ（基準画像 42 枚が動かないことで確かめた）。
 *
 * テクスチャは使わない。UV の中心からの距離で切るだけ。
 */

/**
 * 芯を不透明にする境目。
 *
 * これを下回る画素は捨てる。**背景が透ける画素で深度を書いてはいけない。**
 * 書くと、その画素の背景が自分の距離の霞になって暗く沈み、縁のはっきりした
 * 暗い円が出る。理由は `docs/weapons.md`
 */
export const CORE_CUT = 0.5

/** これを下回る画素は捨てる。ほとんど見えないうえに深度と合成の費用は同じ */
export const ALPHA_CUT = 0.004

/*
 * 断片の式。段 S1 で GLSL 版の断片シェーダを捨てたので、ここに文で残す。
 * 正本は TSL 版（`spriteNodes.ts`）で、CPU 参照（`spriteProbe.ts` の
 * `spriteProbeExpected`）が同じ式を写す。
 *
 *   d = length(uv - 0.5) * 2              中心からの距離。1 で縁
 *   d > 1 なら捨てる
 *   a = pow(max(0, 1 - d), falloff) * opacity
 *   a < ALPHA_CUT なら捨てる
 *   芯（opaqueCore）: a < CORE_CUT なら捨て、色は (color, 1)
 *   それ以外: 色は (color, a)
 */

/**
 * 円形スプライトの材質。
 *
 * **値は setter で入れる。**node 版は `uniform()` のノードへ書くので、
 * 材質に `uniforms` の器が無い。呼ぶ側（爆発とフレア）が材質の中を知らずに
 * 済むように、色と不透明度の setter を材質と一緒に返す。段 17b で地形と
 * 海面に入れた材質ファクトリと同じ形。作り手は `spriteNodes.ts`（段 S1 で
 * GLSL 版を捨てた）。
 */
export interface RadialSpriteMaterial {
  readonly material: THREE.Material
  setColor(color: THREE.Color): void
  setOpacity(value: number): void
}

export interface RadialSpriteOptions {
  color: THREE.Color
  /** 大きいほど縁が締まる。火球は芯が明るいので大きく、煙は小さく */
  falloff: number
  additive: boolean
  /** 芯を不透明にして深度を書く。フレアの芯だけ true */
  opaqueCore?: boolean
}

export type RadialSpriteFactory = (options: RadialSpriteOptions) => RadialSpriteMaterial

/**
 * 材質から作り手へ戻る道。
 *
 * **ビルボードを置く側はメッシュしか持たない。**`mesh.material` から色と
 * 不透明度の setter を引けるようにしておく。node 版には `uniforms` が
 * 無いので、この道が要る。
 */
const handles = new WeakMap<THREE.Material, RadialSpriteMaterial>()

/** 材質を作り、戻る道を張る。爆発とフレアはこちらを呼ぶ */
export function makeRadialSprite(
  factory: RadialSpriteFactory,
  options: RadialSpriteOptions,
): RadialSpriteMaterial {
  const made = factory(options)
  handles.set(made.material, made)
  return made
}

/** `mesh.material` から作り手を引く。`makeRadialSprite` で作ったものだけ */
export function radialSpriteHandle(
  material: THREE.Material,
): RadialSpriteMaterial | undefined {
  return handles.get(material)
}
