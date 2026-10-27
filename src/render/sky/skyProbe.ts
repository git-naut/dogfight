/**
 * 自前の空の自己診断の固定の入力（段 S2a、`?skyprobe=1`）。
 *
 * GPU で焼いた LUT と天空光を読み戻し、CPU 参照（`reference.ts`）と比べる。
 * **ここが唯一の定義。**GPU の焼き手（`pipeline/node.ts`）と検査（node-path.spec）が
 * 同じ値を読む。three にも DOM にも依存しない。
 */

/**
 * 空の見え方と天空光を焼くときの太陽の天頂角の余弦。16 時（基準画像の 36 枚の時刻）の
 * 値で、`tests/render/skyTruth.test.ts` の正解の 16 時と同じ
 */
export const SKY_PROBE_SUN_MU = 0.534583678710939

/** 天空光を半球で足すときの刻み（CPU 参照の `skyIrradianceOverPi` の既定と同じ） */
export const SKY_PROBE_ZENITH_STEPS = 32
export const SKY_PROBE_AZIMUTH_STEPS = 64

/**
 * GPU と CPU の LUT の許容。**各色の LUT の最大値に対する差**で測る（ユーザーの決定、
 * 2026-10-26）。
 *
 * 最初は画素ごとの相対 1e-3 で合意していたが、多重散乱は最大値に対して赤 1.4e-3、
 * 太陽が地平線のすぐ下の帯（値が 1e-7〜3.6e-4 で、隣の画素と何桁も違う）では画素ごとに
 * 7.6e-3 ずれた。テクスチャの補間の精度は原因でない（自前の補間でも同じ値）。64 方向 ×
 * 20 歩を 32 ビットで足し上げる精度と見ている（推測）。光の強さとしての影響は、
 * LUT を通した天空光で 3.5e-4（そちらは 1e-3 で縛る）
 */
export const SKY_PROBE_LUT_TOLERANCE = 2e-3
/** 天空光（GPU と CPU）の許容（相対） */
export const SKY_PROBE_IRRADIANCE_TOLERANCE = 1e-3

/**
 * GPU で焼いた表（RGBA の float、読み戻しの並び）と CPU の表の差の最大を、各色の
 * CPU の表の最大値で割って返す。GPU の行 y は CPU の行 height - 1 - y に当たる
 * （焼くとき v を裏返すので）。`flip` を false にすると向きを取り違えたときの差が出る
 * （検査に歯があることの確認用）
 */
export function lutNormalizedError(
  gpu: ArrayLike<number>,
  cpu: { width: number; height: number; data: ArrayLike<number> },
  flip = true,
): number {
  let worst = 0
  for (let c = 0; c < 3; c++) {
    let max = 0
    for (let i = 0; i < cpu.width * cpu.height; i++) max = Math.max(max, Math.abs(cpu.data[i * 3 + c]!))
    let diff = 0
    for (let y = 0; y < cpu.height; y++) {
      const cy = flip ? cpu.height - 1 - y : y
      for (let x = 0; x < cpu.width; x++) {
        const g = gpu[(y * cpu.width + x) * 4 + c]!
        const r = cpu.data[(cy * cpu.width + x) * 3 + c]!
        diff = Math.max(diff, Math.abs(g - r))
      }
    }
    worst = Math.max(worst, diff / Math.max(max, 1e-30))
  }
  return worst
}

// ---- 段 S2b の自己診断 ----

/**
 * 照度の表を GPU で引く点の格子（横 16 × 縦 6）。表の画素の中心から外した所を引き、
 * 補間と表の行の向き（`DataTexture` は v を裏返さない）を見る
 */
export const IRRADIANCE_PROBE_WIDTH = 16
export const IRRADIANCE_PROBE_HEIGHT = 6
export function irradianceProbePoint(x: number, y: number): { sunMu: number; altitude: number } {
  const f = y / (IRRADIANCE_PROBE_HEIGHT - 1)
  return { sunMu: -0.35 + (1.33 * x) / (IRRADIANCE_PROBE_WIDTH - 1), altitude: 50 * f * f }
}

/**
 * 霞の LUT を焼くカメラ（高さ 2 km、水平から 10 度下を、太陽から方位 40 度ずらして見る）と
 * 太陽の向き（16 時、`tests/render/solar.test.ts` の takram の記録）。カメラの値は
 * 焼き手（`pipeline/node.ts`）が three の `PerspectiveCamera` で行列にして結果に載せる
 */
export const AERIAL_PROBE_CAMERA = {
  position: [0, 2000, 0] as const,
  /** 見る向き（ワールド） */
  forward: [Math.cos((-10 * Math.PI) / 180) * Math.cos(Math.PI / 4), Math.sin((-10 * Math.PI) / 180), Math.cos((-10 * Math.PI) / 180) * Math.sin(Math.PI / 4)] as const,
  fov: 60,
  aspect: 16 / 9,
  near: 5,
  far: 200_000,
}
export const AERIAL_PROBE_SUN = [0.091377761578, 0.534583678711, 0.840160934074] as const

/**
 * 画面の uv（左上が原点）からワールドの視線の向き。`skyNodes.ts` の `screenRayNode`
 * （three の `getViewPosition` の WebGPU の分岐）の写し。行列は列優先の 16 個
 */
export function screenRay(
  u: number,
  v: number,
  projectionInverse: ArrayLike<number>,
  cameraWorld: ArrayLike<number>,
): [number, number, number] {
  const m = projectionInverse
  const clip = [u * 2 - 1, (1 - v) * 2 - 1, 0.5, 1]
  const view = [0, 1, 2, 3].map((r) => m[r]! * clip[0]! + m[4 + r]! * clip[1]! + m[8 + r]! * clip[2]! + m[12 + r]! * clip[3]!)
  const p = [view[0]! / view[3]!, view[1]! / view[3]!, view[2]! / view[3]!]
  const l = Math.hypot(p[0]!, p[1]!, p[2]!)
  const d = [p[0]! / l, p[1]! / l, p[2]! / l]
  const w = cameraWorld
  const out = [0, 1, 2].map((r) => w[r]! * d[0]! + w[4 + r]! * d[1]! + w[8 + r]! * d[2]!)
  const lo = Math.hypot(out[0]!, out[1]!, out[2]!)
  return [out[0]! / lo, out[1]! / lo, out[2]! / lo]
}
