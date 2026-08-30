import { describe, it, expect } from 'vitest'
import {
  parseSettings,
  loadSettings,
  saveSettings,
  applyUrlOverrides,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  MIN_SENSITIVITY,
  MAX_SENSITIVITY,
  type Settings,
  type SettingsStorage,
} from '@hud/settings'

/**
 * 設定の永続化。
 *
 * **主題は「壊れた値で落ちないこと」。**`localStorage` の中身は前の
 * バージョンの残骸かもしれないし、人が手で書き換えているかもしれない。
 * 例外が外へ出るとゲームが起動しない。
 */

/** 覚えるだけの偽ストレージ */
function fakeStorage(initial: string | null = null): SettingsStorage & { value: string | null } {
  return {
    value: initial,
    getItem(key: string): string | null {
      return key === SETTINGS_KEY ? this.value : null
    },
    setItem(key: string, value: string): void {
      if (key === SETTINGS_KEY) this.value = value
    },
  }
}

/** 何をしても投げるストレージ。プライベートモードの再現 */
const throwingStorage: SettingsStorage = {
  getItem(): string | null {
    throw new DOMException('SecurityError')
  },
  setItem(): void {
    throw new DOMException('QuotaExceededError')
  },
}

describe('設定の読み書き', () => {
  it('何も保存されていなければ既定', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(fakeStorage())).toEqual(DEFAULT_SETTINGS)
  })

  it('保存したものが戻る', () => {
    const storage = fakeStorage()
    const wanted: Settings = {
      preset: 'low',
      volume: 0.2,
      mouseSensitivity: 2,
      hour: 6,
      controlMode: 'standard',
    }
    saveSettings(storage, wanted)
    expect(loadSettings(storage)).toEqual(wanted)
  })

  it('ストレージが無くても既定を返す', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('壊れた保存値', () => {
  it('JSON でなければ既定', () => {
    expect(parseSettings('{壊れている')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('')).toEqual(DEFAULT_SETTINGS)
  })

  it('オブジェクトでなければ既定', () => {
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('"文字列"')).toEqual(DEFAULT_SETTINGS)
    // 配列も typeof では 'object' になる
    expect(parseSettings('[1,2,3]')).toEqual(DEFAULT_SETTINGS)
  })

  it('項目ごとに倒す。1 つ壊れていても他は生きる', () => {
    const s = parseSettings(
      JSON.stringify({ preset: 'ultra', volume: 'うるさい', hour: 3 }),
    )
    expect(s.preset).toBe('ultra')
    expect(s.hour).toBe(3)
    expect(s.volume).toBe(DEFAULT_SETTINGS.volume)
  })

  it('知らないプリセット名は既定', () => {
    expect(parseSettings(JSON.stringify({ preset: 'extreme' })).preset).toBe(
      DEFAULT_SETTINGS.preset,
    )
  })

  it('知らない操作の型は既定', () => {
    expect(parseSettings(JSON.stringify({ controlMode: 'arcade' })).controlMode).toBe(
      DEFAULT_SETTINGS.controlMode,
    )
  })

  it('範囲の外は丸める', () => {
    const low = parseSettings(
      JSON.stringify({ volume: -5, hour: -1, mouseSensitivity: 0.001 }),
    )
    expect(low.volume).toBe(0)
    expect(low.hour).toBe(0)
    expect(low.mouseSensitivity).toBe(MIN_SENSITIVITY)

    const high = parseSettings(
      JSON.stringify({ volume: 99, hour: 99, mouseSensitivity: 1000 }),
    )
    expect(high.volume).toBe(1)
    expect(high.hour).toBe(24)
    expect(high.mouseSensitivity).toBe(MAX_SENSITIVITY)
  })

  it('NaN と Infinity は既定へ倒す', () => {
    // JSON に NaN は書けないので、そういう値が入る経路を文字列で作る
    const s = parseSettings('{"volume": null, "hour": true}')
    expect(s.volume).toBe(DEFAULT_SETTINGS.volume)
    expect(s.hour).toBe(DEFAULT_SETTINGS.hour)
  })

  /** **例外を外へ出さない。**出るとゲームが起動しない */
  it('ストレージが投げても落ちない', () => {
    expect(() => loadSettings(throwingStorage)).not.toThrow()
    expect(loadSettings(throwingStorage)).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(throwingStorage, DEFAULT_SETTINGS)).not.toThrow()
    expect(() => saveSettings(null, DEFAULT_SETTINGS)).not.toThrow()
  })
})

describe('URL の指定', () => {
  const saved: Settings = {
    preset: 'low',
    volume: 0.1,
    mouseSensitivity: 3,
    hour: 2,
    controlMode: 'standard',
  }

  it('書いていなければ保存値のまま', () => {
    expect(applyUrlOverrides(saved, '')).toEqual(saved)
    expect(applyUrlOverrides(saved, '?script=level')).toEqual(saved)
  })

  it('URL が保存値に勝つ', () => {
    const s = applyUrlOverrides(saved, '?preset=ultra&hour=18&control=expert')
    expect(s.preset).toBe('ultra')
    expect(s.hour).toBe(18)
    expect(s.controlMode).toBe('expert')
  })

  /** `?hour=0` を「指定なし」と取り違えない */
  it('0 の指定を拾う', () => {
    expect(applyUrlOverrides(saved, '?hour=0').hour).toBe(0)
  })

  /** 既存の `resolveControlMode` と同じ規則。知らない値は expert */
  it('知らない操作の型はエキスパートへ倒れる', () => {
    expect(applyUrlOverrides(saved, '?control=arcade').controlMode).toBe('expert')
  })

  /** 既存の `resolvePreset` と同じ規則。知らない値は既定 */
  it('知らないプリセット名は既定へ倒れる', () => {
    expect(applyUrlOverrides(saved, '?preset=extreme').preset).toBe(
      DEFAULT_SETTINGS.preset,
    )
  })

  it('音量と感度は URL から変えない', () => {
    // 設定画面だけで変える。URL の面を増やさない
    const s = applyUrlOverrides(saved, '?volume=1&mouseSensitivity=1')
    expect(s.volume).toBe(saved.volume)
    expect(s.mouseSensitivity).toBe(saved.mouseSensitivity)
  })

  it('元の設定を書き換えない', () => {
    const before = { ...saved }
    applyUrlOverrides(saved, '?preset=ultra')
    expect(saved).toEqual(before)
  })
})
