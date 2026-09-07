import * as THREE from 'three'

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

export const RADIAL_SPRITE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * `OPAQUE_CORE` を立てると芯だけを不透明で描き、縁を捨てる。
 *
 * `CORE_CUT` も define で渡す。リポジトリで唯一の `defines` の使い方で、
 * TSL では生成時の分岐（`Fn` を 2 つ作って呼び分ける）になる
 */
export const RADIAL_SPRITE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFalloff;
  varying vec2 vUv;
  void main() {
    // 中心からの距離。0.5 で縁
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = pow(max(0.0, 1.0 - d), uFalloff) * uOpacity;
    if (a < 0.004) discard;
    #ifdef OPAQUE_CORE
    // 芯は不透明にして深度を書く。縁は捨てる。
    // **背景が透ける画素で深度を書いてはいけない。**書くと、その画素の
    // 背景が自分の距離の霞になって暗く沈み、縁のはっきりした暗い円が出る
    if (a < CORE_CUT) discard;
    gl_FragColor = vec4(uColor, 1.0);
    #else
    gl_FragColor = vec4(uColor, a);
    #endif
  }
`

/**
 * 円形スプライトの材質。
 *
 * **GLSL 版と node 版で口を揃える。**GLSL 版は `uniforms` の器へ書き、
 * node 版は `uniform()` のノードへ書くので、値の入れ方が違う。呼ぶ側
 * （爆発とフレア）がどちらかを知らずに済むように、色と不透明度の setter を
 * 材質と一緒に返す。段 17b で地形と海面に入れた材質ファクトリと同じ形。
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
 * GLSL 版。既定はこちら。
 *
 * **色は複製して入れる。**参照のまま入れるとスロット全部が同じ器を指し、
 * 1 つの色を書き換えた瞬間に全部が同じ色になる（`flares.ts` が踏んだ形）。
 */
export function createGlRadialSprite(options: RadialSpriteOptions): RadialSpriteMaterial {
  const opaqueCore = options.opaqueCore ?? false
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: options.color.clone() },
      uOpacity: { value: 0 },
      uFalloff: { value: options.falloff },
    },
    vertexShader: RADIAL_SPRITE_VERTEX,
    fragmentShader: RADIAL_SPRITE_FRAGMENT,
    transparent: true,
    blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    // 不透明な芯だけ深度を書く。理由は `CORE_CUT` の節（`docs/weapons.md`）
    depthWrite: opaqueCore,
    ...(opaqueCore
      ? { defines: { OPAQUE_CORE: '1', CORE_CUT: CORE_CUT.toFixed(2) } }
      : {}),
    side: THREE.DoubleSide,
  })
  return {
    material,
    setColor(color) {
      ;(material.uniforms['uColor']!.value as THREE.Color).copy(color)
    },
    setOpacity(value) {
      material.uniforms['uOpacity']!.value = value
    },
  }
}

/**
 * 材質から作り手へ戻る道。
 *
 * **ビルボードを置く側はメッシュしか持たない。**`mesh.material` から色と
 * 不透明度の setter を引けるようにしておく。GLSL 版は `uniforms` を直に
 * 触れたが、node 版には `uniforms` が無いので、この道が要る。
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
