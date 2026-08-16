/**
 * 決定論キャプチャモード。
 *
 * スクリーンショット回帰テストは「同じ入力から同じピクセル」が前提になる。
 * 実時間、Math.random()、経過時間依存のアニメーションが混ざると成立しない。
 *
 * ?capture=1&script=bank-left&frame=600 で起動すると、実時間を使わず
 * 名前付き入力スクリプトを指定フレームまで再生して描画を止め、
 * captureReady を立てる。Playwright はこのフラグを待ってから撮る。
 */
export interface CaptureConfig {
  enabled: boolean
  /** 何ステップ進めた時点を撮るか */
  frame: number
  /** 再生する入力スクリプト名 */
  script: string
  preset: string
}

export const DEFAULT_SEED = 20260816

export function readCaptureConfig(search: string): CaptureConfig {
  const params = new URLSearchParams(search)
  return {
    enabled: params.get('capture') === '1',
    frame: clampInt(params.get('frame'), 0, 100_000, 240),
    script: params.get('script') ?? 'level',
    preset: params.get('preset') ?? 'high',
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

/** テストから読むためのフック。ここ以外から window を汚さない。 */
export interface TestHook {
  frame: number
  captureReady: boolean
  seed: number
  droppedSteps: number
  webglVersion: number
  /** 検証しやすいよう飛行状態も出す */
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
