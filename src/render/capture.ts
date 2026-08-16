/**
 * 決定論キャプチャモード。
 *
 * スクリーンショット回帰テストは「同じ入力から同じピクセル」が前提になる。
 * 実時間、Math.random()、経過時間依存のアニメーションが混ざると成立しない。
 *
 * ?capture=1&frame=600&seed=42&preset=high で起動すると、実時間を使わず
 * 指定フレームまでシムを進めて描画を止め、captureReady を立てる。
 * Playwright はこのフラグを待ってから撮る。
 */
export interface CaptureConfig {
  enabled: boolean
  /** 何ステップ進めた時点を撮るか */
  frame: number
  seed: number
  preset: string
}

export const DEFAULT_SEED = 20260816

export function readCaptureConfig(search: string): CaptureConfig {
  const params = new URLSearchParams(search)
  const enabled = params.get('capture') === '1'
  return {
    enabled,
    frame: clampInt(params.get('frame'), 0, 100_000, 240),
    seed: clampInt(params.get('seed'), 0, 0xffffffff, DEFAULT_SEED),
    preset: params.get('preset') ?? 'high',
  }
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

/** テストから読むためのフック。ここ以外から window を汚さない。 */
export interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
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
