import { isPresetName, resolvePreset, DEFAULT_PRESET, type PresetName } from '../render/quality'
import { resolveControlMode } from '../render/capture'
import { DEFAULT_HOUR } from '../render/atmosphere'
import { isControlMode, type ControlMode } from '../sim/assist'

/**
 * 設定の値と永続化。
 *
 * **DOM を触らない。**`result.ts` と同じ分け方で、組み立てと保存だけを持つ。
 * DOM は `settingsPanel.ts`。node でテストできる。
 *
 * **壊れた値で落ちないことが要件。**`localStorage` の中身は前のバージョンの
 * 残骸かもしれないし、人が手で書き換えているかもしれない。`JSON.parse` の
 * 例外、型の不一致、範囲外、ストレージ自体が使えない場合（プライベート
 * モードでは `getItem` が throw する）を全部飲み込んで既定へ倒す。
 * `resolvePreset` と同じ作法。
 */

/** 保存する項目 */
export interface Settings {
  /** 品質プリセット */
  readonly preset: PresetName
  /** 効果音の音量 0..1。段 9 で使う */
  readonly volume: number
  /** マウス視点の感度。既定を 1 とした倍率 */
  readonly mouseSensitivity: number
  /** 時刻 0..24。太陽高度が変わる */
  readonly hour: number
  /** 操作の型 */
  readonly controlMode: ControlMode
}

/**
 * 感度の下限と上限。
 *
 * 素の感度は 1 px あたり 0.005 rad（`mouseLook.ts`）。画面幅 1,280 px を
 * 端から端まで引いて 6.4 rad = 367 度で、1 回のドラッグで一周する。
 * 4 倍だと 4 分の 1 の移動で一周し、0.25 倍だと一周に 4 回引くことになる。
 * この外側は使いものにならないので許さない。
 */
export const MIN_SENSITIVITY = 0.25
export const MAX_SENSITIVITY = 4

/** 既定値。何も保存されていないときに使う */
export const DEFAULT_SETTINGS: Settings = {
  preset: DEFAULT_PRESET,
  volume: 0.7,
  mouseSensitivity: 1,
  hour: DEFAULT_HOUR,
  controlMode: 'expert',
}

/** `localStorage` の鍵。名前を変えると保存済みの設定が捨てられる */
export const SETTINGS_KEY = 'dogfight.settings'

/**
 * 読み書きの窓口。
 *
 * `localStorage` がそのまま当てはまる形にしてある。テストは偽物を渡す。
 */
export interface SettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 数を範囲に収める。有限でなければ既定へ倒す */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < min ? min : value > max ? max : value
}

/**
 * 保存された JSON から設定を組み立てる。
 *
 * **項目ごとに倒す。**1 つ壊れていても他は生かす。全部捨てると、設定を
 * 1 つ足したときに古い保存が丸ごと消える。
 */
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_SETTINGS
  }
  // 配列も `typeof` では 'object' なので弾く
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_SETTINGS
  }

  const o = parsed as Record<string, unknown>
  return {
    preset: isPresetName(o.preset) ? o.preset : DEFAULT_SETTINGS.preset,
    volume: clampNumber(o.volume, 0, 1, DEFAULT_SETTINGS.volume),
    mouseSensitivity: clampNumber(
      o.mouseSensitivity,
      MIN_SENSITIVITY,
      MAX_SENSITIVITY,
      DEFAULT_SETTINGS.mouseSensitivity,
    ),
    hour: clampNumber(o.hour, 0, 24, DEFAULT_SETTINGS.hour),
    controlMode:
      typeof o.controlMode === 'string' && isControlMode(o.controlMode)
        ? o.controlMode
        : DEFAULT_SETTINGS.controlMode,
  }
}

/**
 * 保存された設定を読む。
 *
 * **ストレージが使えなくても落ちない。**プライベートモードや、site data を
 * 拒否する設定では `getItem` そのものが例外を投げる。
 */
export function loadSettings(storage: SettingsStorage | null): Settings {
  if (storage === null) return DEFAULT_SETTINGS
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY))
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * 設定を保存する。
 *
 * 書けなくても黙って諦める。**保存できないことでゲームが止まってはいけない。**
 * 容量超過（`QuotaExceededError`）でも例外は外へ出さない。
 */
export function saveSettings(storage: SettingsStorage | null, settings: Settings): void {
  if (storage === null) return
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // 保存できないだけ。設定はこのセッションでは効いている
  }
}

/**
 * URL の指定を設定に重ねる。
 *
 * **URL が勝つ。**`?preset=low` を付けて開いたなら、保存値ではなくそれを
 * 使う。キャプチャモードと開発中の指定が保存値に負けると、URL で条件を
 * 固定して比べることができなくなる。
 *
 * 書いていない項目は保存値のまま。`has()` で見るので `?hour=0` のような
 * 0 の指定も拾える。
 */
export function applyUrlOverrides(settings: Settings, search: string): Settings {
  const params = new URLSearchParams(search)
  const next = { ...settings }

  // **解釈は既存の関数に任せる。**`?control=arcade` を expert へ倒す規則を
  // ここに書き写すと、片方だけ直したときに E2E が素通りする
  if (params.has('preset')) next.preset = resolvePreset(params.get('preset'))
  if (params.has('control')) next.controlMode = resolveControlMode(search)
  if (params.has('hour')) {
    next.hour = clampNumber(Number(params.get('hour')), 0, 24, next.hour)
  }
  return next
}
