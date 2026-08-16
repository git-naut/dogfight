import { resolvePreset, type PresetName } from './quality'
import { DEFAULT_HOUR } from './atmosphere'

/**
 * 決定論キャプチャモード。
 *
 * スクリーンショット回帰テストは「同じ入力から同じピクセル」が前提になる。
 * 実時間、Math.random()、経過時間依存のアニメーションが混ざると成立しない。
 * 太陽の位置も実時間の Date から決まるので、時刻を固定できるようにする。
 *
 * ?capture=1&script=bank-left&frame=600&hour=18 で起動すると、実時間を
 * 使わず名前付き入力スクリプトを指定フレームまで再生し、大気の LUT を
 * 読み終えてから 1 枚描いて止まり、captureReady を立てる。
 */
export interface CaptureConfig {
  enabled: boolean
  /** 何ステップ進めた時点を撮るか */
  frame: number
  /** 再生する入力スクリプト名 */
  script: string
  preset: PresetName
  /** 局所時刻 0〜24。12 が南中 */
  hour: number
  /** トーンマッピングの露出。未指定なら既定値 */
  exposure: number | null
  /** 雲量 0..1 */
  coverage: number
  /** 雲のレイマーチ解像度の上書き。実機で振って GPU 時間を測る用 */
  cloudScale: number | null
  /** 主マーチのステップ数の上書き */
  cloudSteps: number | null
}

export const DEFAULT_SEED = 20260816

/**
 * 既定の雲量。
 *
 * ノイズを Nyquist 内へ収めた際に塊が育つ方向へ変わったので、点在する
 * 見え方を保つために 0.35 から下げた。
 */
export const DEFAULT_COVERAGE = 0.3

export function readCaptureConfig(search: string): CaptureConfig {
  const params = new URLSearchParams(search)
  return {
    enabled: params.get('capture') === '1',
    frame: clampInt(params.get('frame'), 0, 100_000, 240),
    script: params.get('script') ?? 'level',
    preset: resolvePreset(params.get('preset')),
    hour: clampNumber(params.get('hour'), 0, 24, DEFAULT_HOUR),
    exposure: params.has('exposure')
      ? clampNumber(params.get('exposure'), 0.01, 1000, 1)
      : null,
    coverage: clampNumber(params.get('coverage'), 0, 1, DEFAULT_COVERAGE),
    cloudScale: params.has('cloudScale')
      ? clampNumber(params.get('cloudScale'), 0.05, 1, 0.25)
      : null,
    cloudSteps: params.has('cloudSteps')
      ? clampInt(params.get('cloudSteps'), 8, 256, 96)
      : null,
  }
}

export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1'
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampNumber(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === null) return fallback
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** テストから読むためのフック。ここ以外から window を汚さない。 */
export interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
  /** 大気の LUT を読み終えたか */
  atmosphereReady: boolean
  /** 太陽高度 rad。時刻を変えたことの検証に使う */
  sunElevation: number
  /** 雲ノイズの生成にかかったミリ秒 */
  noiseMs: number
  /** 雲ノイズの中身。min と max が同じなら生成に失敗している */
  noiseStats: { min: number; max: number; mean: number }
  /** GPU のフレーム時間 ms。計測できていなければ 0 */
  gpuFrameMs: number
  /** そのうち雲のパスが占める ms */
  gpuCloudMs: number
  gpuTimerSupported: boolean
  preset: PresetName
  hour: number
  // 飛行状態
  speed: number
  altitude: number
  angleOfAttack: number
  bank: number
  crashed: boolean
  script: string
}

declare global {
  interface Window {
    __dogfight?: TestHook
  }
}

export function installTestHook(initial: TestHook): TestHook {
  window.__dogfight = initial
  return initial
}
