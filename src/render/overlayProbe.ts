import {
  GLSL3,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'

/**
 * 雲を大気へ差し込む合成を GLSL 版と TSL 版で突き合わせる。
 *
 * `AerialPerspectiveNode` に `overlay` が無い（持つのは `colorNode` /
 * `depthNode` / `normalNode` / `skyNode` / `shadowLengthNode` の 5 つ）。
 * **雲を差し込む口が消えるので、合成を自前で書く。**式は GLSL 版の
 * `aerialPerspectiveEffect.frag:283-289, 387-389` から写す。
 *
 * 写した 2 か所を `OVERLAY_EARLY_OUT_GLSL` と `OVERLAY_COMPOSITE_GLSL` に
 * 文字列で置いてある。**写しが 2 つあると相手が定まらない**（段 16）ので、
 * `tests/render/overlayProbe.test.ts` が `node_modules` の原本と照合する。
 * ライブラリを上げて式が変われば、そこが落ちる。
 *
 * 早期打ち切りは絵に出ない。`overlay.a == 1.0` の画素は、打ち切っても
 * 打ち切らなくても `base * (1 - 1) + overlay.rgb` で同じ値になる。
 * **バイトの比較では枝を通ったかどうかが見えない。**段 13・14・16 で 3 度
 * 踏んだ形なので、マーカーを焼いて画素数で数える口を最初から置く。
 */

/** 標本の格子の一辺。64x64 で 4,096 画素・16,384 バイト */
export const OVERLAY_PROBE_SIDE = 64
export const OVERLAY_PROBE_COUNT = OVERLAY_PROBE_SIDE * OVERLAY_PROBE_SIDE

/**
 * 不透明度が 1 に届く列。
 *
 * **境目を跨がせる。**ここから右の 17 列（1,088 画素）が早期打ち切りの枝を
 * 通り、左の 47 列（3,008 画素）が合成の枝を通る。片側だけの絵どうしを
 * 比べても、もう片方の写し間違いは出てこない。
 *
 * **1 に届かせるのに除算を当てにしない。**最初は `min(col / 47.0, 1.0)` と
 * 書いたが、SwiftShader は除算を逆数の乗算へ畳み込む。float32 で
 * `47 * fl(1/47) = 0.99999994` になり、列 47 の 64 画素が早期打ち切りの枝を
 * 通らなかった（実測 1,024 対 期待 1,088）。列の比較で 1 を作る。
 *
 * 本番はこの心配がない。雲は 8 ビットか半精度のレンダーターゲットから
 * 来るので、完全不透明の画素は厳密に 1.0 で読める
 */
export const OVERLAY_PROBE_FULL_COLUMN = 47

/** 早期打ち切りを通る画素数。マーカーの期待値 */
export const OVERLAY_PROBE_EARLY_COUNT =
  (OVERLAY_PROBE_SIDE - OVERLAY_PROBE_FULL_COLUMN) * OVERLAY_PROBE_SIDE

/** 合成を通る画素数 */
export const OVERLAY_PROBE_LATE_COUNT =
  OVERLAY_PROBE_COUNT - OVERLAY_PROBE_EARLY_COUNT

/** 下地の色の比。大気が返す放射輝度の代わり。3 成分が別々に通ることを見る */
export const OVERLAY_PROBE_BASE_RATIO = { r: 0.85, g: 0.55, b: 0.2 } as const

/**
 * 雲の色の比。
 *
 * **前乗算にしてある。**合成が `+ overlay.rgb` で足すだけなので、
 * `overlay.rgb * overlay.a` と書き間違えると a の 2 乗になって出る
 */
export const OVERLAY_PROBE_CLOUD_RATIO = { r: 0.2, g: 0.65, b: 0.95 } as const

/** 下地の不透明度。合成の枝が返すアルファ */
export const OVERLAY_PROBE_BASE_ALPHA = 1

/**
 * takram の断片シェーダから写した早期打ち切り。
 *
 * `aerialPerspectiveEffect.frag:285`。原本との照合は
 * `tests/render/overlayProbe.test.ts`
 */
export const OVERLAY_EARLY_OUT_GLSL = 'if (overlay.a == 1.0) {'

/**
 * takram の断片シェーダから写した合成。
 *
 * `aerialPerspectiveEffect.frag:315` と `:388` の 2 か所に同じ行がある
 */
export const OVERLAY_COMPOSITE_GLSL =
  'outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;'

export interface OverlayProbeSample {
  /** 大気が返す色の代わり */
  base: { r: number; g: number; b: number; a: number }
  /** 雲。rgb は前乗算 */
  overlay: { r: number; g: number; b: number; a: number }
}

/**
 * 標本の位置から入力を出す。GPU 側も同じ式で導く。
 *
 * 列が不透明度、行が明るさを決める。**列 47 から右がちょうど 1.0。**
 * 除算では作らない（`OVERLAY_PROBE_FULL_COLUMN` の注記）
 */
export function overlayProbeSample(col: number, row: number): OverlayProbeSample {
  const a =
    col >= OVERLAY_PROBE_FULL_COLUMN ? 1 : col / OVERLAY_PROBE_FULL_COLUMN
  const u = row / (OVERLAY_PROBE_SIDE - 1)
  return {
    base: {
      r: OVERLAY_PROBE_BASE_RATIO.r * u,
      g: OVERLAY_PROBE_BASE_RATIO.g * u,
      b: OVERLAY_PROBE_BASE_RATIO.b * u,
      a: OVERLAY_PROBE_BASE_ALPHA,
    },
    overlay: {
      r: OVERLAY_PROBE_CLOUD_RATIO.r * a * (1 - u),
      g: OVERLAY_PROBE_CLOUD_RATIO.g * a * (1 - u),
      b: OVERLAY_PROBE_CLOUD_RATIO.b * a * (1 - u),
      a,
    },
  }
}

/** 0..1 を 8 ビットへ。レンダーターゲットの書き込みと同じ丸め */
function toByte(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * 255)
}

/**
 * CPU で組んだ期待値。
 *
 * **両側が同じ写し間違いをしたときの受け皿。**GLSL 版と TSL 版は同じ
 * 原本から同じ人が写すので、バイト一致だけでは「2 つとも間違っている」を
 * 通してしまう。丸めの分かれ目があるので階調 1 の許容を置いて使う
 */
export function overlayProbeExpected(): number[] {
  const out: number[] = []
  for (let row = 0; row < OVERLAY_PROBE_SIDE; row++) {
    for (let col = 0; col < OVERLAY_PROBE_SIDE; col++) {
      const { base, overlay } = overlayProbeSample(col, row)
      if (overlay.a === 1) {
        out.push(toByte(overlay.r), toByte(overlay.g), toByte(overlay.b), toByte(overlay.a))
        continue
      }
      const k = 1 - overlay.a
      out.push(
        toByte(base.r * k + overlay.r),
        toByte(base.g * k + overlay.g),
        toByte(base.b * k + overlay.b),
        toByte(base.a),
      )
    }
  }
  return out
}

/**
 * マーカーの絵から枝ごとの画素数を数える。
 *
 * 早期打ち切りが赤、合成が緑。**どちらでもない画素を別に数える。**
 * 0 でなければ枝の書き分けそのものが壊れている
 */
export function overlayMarkerCounts(bytes: ArrayLike<number>): {
  early: number
  late: number
  other: number
} {
  let early = 0
  let late = 0
  let other = 0
  for (let i = 0; i < bytes.length / 4; i++) {
    const r = bytes[i * 4]!
    const g = bytes[i * 4 + 1]!
    if (r === 255 && g === 0) early++
    else if (r === 0 && g === 255) late++
    else other++
  }
  return { early, late, other }
}

/**
 * GLSL 版を 1 枚焼いて読み戻す。
 *
 * @param marker 枝のマーカーを出すか。false なら合成の結果を出す
 */
export function renderOverlayProbe(renderer: WebGLRenderer, marker: boolean): number[] {
  const side = OVERLAY_PROBE_SIDE
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { marker: { value: marker ? 1 : 0 } },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    // 早期打ち切りは takram では `return` で抜ける。ここは 1 枚の絵に
    // 両方の枝を出すので if/else へ組み替えてある。**合成の行そのものは
    // 写したまま置く**（`OVERLAY_COMPOSITE_GLSL` が原本と照合される）
    fragmentShader: /* glsl */ `
      uniform float marker;
      in vec2 vUv;
      out vec4 fragColor;
      const float SIDE = ${side}.0;
      const float FULL = ${OVERLAY_PROBE_FULL_COLUMN}.0;
      void main() {
        float col = floor(vUv.x * SIDE);
        float row = floor(vUv.y * SIDE);
        // **除算で 1 を作らない。**逆数の乗算へ畳み込まれると 47/47 が
        // 0.99999994 になり、境目の 1 列が枝を通らない（実測）
        float a = col >= FULL ? 1.0 : col / FULL;
        float u = row / (SIDE - 1.0);
        vec4 overlay = vec4(
          vec3(${OVERLAY_PROBE_CLOUD_RATIO.r}, ${OVERLAY_PROBE_CLOUD_RATIO.g}, ${OVERLAY_PROBE_CLOUD_RATIO.b}) * a * (1.0 - u),
          a
        );
        vec4 outputColor = vec4(
          vec3(${OVERLAY_PROBE_BASE_RATIO.r}, ${OVERLAY_PROBE_BASE_RATIO.g}, ${OVERLAY_PROBE_BASE_RATIO.b}) * u,
          ${OVERLAY_PROBE_BASE_ALPHA}.0
        );
        if (overlay.a == 1.0) {
          fragColor = marker > 0.5 ? vec4(1.0, 0.0, 0.0, 1.0) : overlay;
        } else {
          outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;
          fragColor = marker > 0.5 ? vec4(0.0, 1.0, 0.0, 1.0) : outputColor;
        }
      }
    `,
    depthTest: false,
    depthWrite: false,
  })

  const scene = new Scene()
  const geometry = new PlaneGeometry(2, 2)
  scene.add(new Mesh(geometry, material))
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const target = new WebGLRenderTarget(side, side, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const previous = renderer.getRenderTarget()
  const buffer = new Uint8Array(side * side * 4)
  try {
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, side, side, buffer)
  } finally {
    renderer.setRenderTarget(previous)
    geometry.dispose()
    material.dispose()
    target.dispose()
  }
  return [...buffer]
}
