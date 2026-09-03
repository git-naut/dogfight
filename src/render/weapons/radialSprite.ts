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
