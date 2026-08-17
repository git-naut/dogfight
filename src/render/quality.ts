/**
 * 品質プリセット。
 *
 * 描画の設定を足すときは、まずこの表に列を追加してから実装する。表に載らない
 * 設定項目を作らないと決めておくと、あとから「この環境だと重い」となったときに
 * 触る場所が1か所で済む。
 *
 * three に依存しない純粋なデータなので node 環境のテストで検証できる。
 */

export type PresetName = 'low' | 'medium' | 'high' | 'ultra'

export interface QualitySettings {
  /** 描画解像度の倍率。1.0 が等倍 */
  renderScale: number
  /** devicePixelRatio の上限 */
  maxPixelRatio: number
  smaa: boolean
  anisotropy: number

  /**
   * 雲のレイマーチを走らせる解像度の倍率。
   *
   * 当初の案では Low をビルボード、Medium をメッシュクラスタ、High 以上を
   * レイマーチとしていたが、雲の実装を3つ作ることになり工数に見合わない。
   * 1つのレイマーチで解像度とステップ数だけを段階にする。
   */
  cloudResolutionScale: number
  /** 主マーチの上限ステップ数 */
  cloudMaxSteps: number
  /** 太陽方向への二次マーチのステップ数 */
  cloudLightSteps: number
  /** ディテールノイズで輪郭を削るか */
  cloudDetail: boolean
  /** 地面へ雲影を落とすか */
  cloudGroundShadow: boolean

  /**
   * 地形パッチの一辺のセル数。
   *
   * CDLOD は同じパッチを InstancedMesh で並べる方式なので、この 1 つの値で
   * 全レベルの細かさが決まる。三角形数は パッチ枚数 × セル数² × 2。
   */
  terrainPatchCells: number
  /**
   * 地形の LOD の段数。
   *
   * レベル 0 が最も細かく、1 段ごとにセルが倍になる。段数で見える距離が
   * 決まり、n 段なら レベル0の範囲 × 2^(n-1) まで届く。
   */
  terrainLodLevels: number
  /** 地表の近距離の凹凸を法線の摂動で出すか */
  terrainDetailNormals: boolean
  /** 海面に太陽のスペキュラを乗せるか */
  waterSpecular: boolean

  /**
   * LOD の切り替え距離の倍率。
   *
   * 地形パッチのレベル 0 のセルの大きさに掛ける。大きくすると手前が細かく
   * なるかわりに、同じ段数で届く距離が伸びる。
   */
  lodDistanceScale: number

  // Phase 4 で機体の影を入れるときに効くようになる枠
  shadowCascades: number
}

export const PRESET_ORDER: readonly PresetName[] = ['low', 'medium', 'high', 'ultra']

export const DEFAULT_PRESET: PresetName = 'high'

export const QUALITY_PRESETS: Readonly<Record<PresetName, QualitySettings>> = {
  low: {
    renderScale: 0.6,
    maxPixelRatio: 1,
    smaa: false,
    anisotropy: 1,
    cloudResolutionScale: 0.125,
    cloudMaxSteps: 32,
    cloudLightSteps: 2,
    cloudDetail: false,
    cloudGroundShadow: false,
    terrainPatchCells: 16,
    terrainLodLevels: 5,
    terrainDetailNormals: false,
    waterSpecular: false,
    lodDistanceScale: 0.5,
    shadowCascades: 1,
  },
  medium: {
    renderScale: 0.8,
    maxPixelRatio: 1.5,
    smaa: true,
    anisotropy: 4,
    cloudResolutionScale: 0.25,
    cloudMaxSteps: 64,
    cloudLightSteps: 3,
    cloudDetail: true,
    cloudGroundShadow: true,
    terrainPatchCells: 24,
    terrainLodLevels: 6,
    terrainDetailNormals: true,
    waterSpecular: true,
    lodDistanceScale: 0.75,
    shadowCascades: 2,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 2,
    smaa: true,
    anisotropy: 8,
    // 実機（Intel Arc 140V）の実測で、1/4 解像度のとき雲パスは 2.7 ms、
    // フレーム全体で 5.2 ms / 16.7 ms だった。1/2 なら画素数 4 倍で
    // 雲 10.8 ms、合計 13 ms 前後に収まる
    cloudResolutionScale: 0.5,
    cloudMaxSteps: 256,
    cloudLightSteps: 4,
    cloudDetail: true,
    cloudGroundShadow: true,
    // 実測で 220 枚 × 32² × 2 = 45 万三角形。プレースホルダ機体は数百なので、
    // これがシーンのほぼ全部になる。Phase 4 の機体 9 機で 550k 前後を
    // 見込むと、合計は予算 1.5M の内側に収まる
    terrainPatchCells: 32,
    terrainLodLevels: 7,
    terrainDetailNormals: true,
    waterSpecular: true,
    lodDistanceScale: 1,
    shadowCascades: 3,
  },
  ultra: {
    renderScale: 1.25,
    maxPixelRatio: 2,
    smaa: true,
    anisotropy: 16,
    // High より上の段。実機で 60fps は狙わない位置づけ。
    // High の実測から外挿すると雲パスで 22 ms 前後になる（未実測）
    cloudResolutionScale: 1,
    cloudMaxSteps: 384,
    cloudLightSteps: 8,
    cloudDetail: true,
    cloudGroundShadow: true,
    // 48 だと三角形が 1.18M になり、機体のぶんが残らない。40 で 82 万
    terrainPatchCells: 40,
    // High と同じ 7 段。段数を増やすより手前を細かくするほうが効く
    terrainLodLevels: 7,
    terrainDetailNormals: true,
    waterSpecular: true,
    // 1.5 だと三角形が 2.19M になり、シーン予算 1.5M を単独で超える。
    // セル数を 48 へ上げたぶん、切り替え距離は控えめにする
    lodDistanceScale: 1.15,
    shadowCascades: 4,
  },
}

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_ORDER as readonly string[]).includes(value)
}

/** 不正な名前は既定へ倒す。クエリ文字列から直接受けるので緩く扱う。 */
export function resolvePreset(value: string | null | undefined): PresetName {
  return isPresetName(value) ? value : DEFAULT_PRESET
}

export function getQuality(name: PresetName): QualitySettings {
  return QUALITY_PRESETS[name]
}

/**
 * 雲の設定だけを上書きする。
 *
 * 実機で解像度とステップ数を振って GPU 時間を測るための入口。
 * `?cloudScale=` と `?cloudSteps=` から渡す。
 */
export interface CloudOverride {
  resolutionScale?: number
  maxSteps?: number
  lightSteps?: number
}

export function applyCloudOverride(
  base: QualitySettings,
  override: CloudOverride,
): QualitySettings {
  return {
    ...base,
    ...(override.resolutionScale !== undefined
      ? { cloudResolutionScale: override.resolutionScale }
      : {}),
    ...(override.maxSteps !== undefined ? { cloudMaxSteps: override.maxSteps } : {}),
    ...(override.lightSteps !== undefined
      ? { cloudLightSteps: override.lightSteps }
      : {}),
  }
}

/** 1段下のプリセット。最下段なら null。 */
export function lowerPreset(name: PresetName): PresetName | null {
  const index = PRESET_ORDER.indexOf(name)
  return index > 0 ? PRESET_ORDER[index - 1]! : null
}

/**
 * フレームレートを見て品質を落とす判断をする。
 *
 * 一瞬の落ち込みで降格すると、プリセットが上下して絵がちらつく。一定時間
 * 連続で下回ったときだけ動かし、降格後はしばらく様子を見る。
 *
 * 実時間に依存するのでキャプチャモードでは使わない。動くと絵が変わって
 * スクリーンショット回帰が壊れる。
 */
export class PerformanceGovernor {
  private belowSeconds = 0
  private cooldownSeconds = 0

  constructor(
    /** この fps を下回り続けたら降格する */
    private readonly targetFps = 55,
    /** 何秒連続で下回ったら動かすか */
    private readonly sustainSeconds = 3,
    /** 降格後、次の判断までの待ち時間 */
    private readonly cooldown = 5,
  ) {}

  /**
   * param dt 前フレームからの経過秒
   * param current 現在のプリセット
   * returns 降格すべきなら次のプリセット名、そのままなら null
   */
  update(dt: number, current: PresetName): PresetName | null {
    if (!Number.isFinite(dt) || dt <= 0) return null

    if (this.cooldownSeconds > 0) {
      this.cooldownSeconds -= dt
      return null
    }

    const fps = 1 / dt
    if (fps >= this.targetFps) {
      this.belowSeconds = 0
      return null
    }

    this.belowSeconds += dt
    if (this.belowSeconds < this.sustainSeconds) return null

    const next = lowerPreset(current)
    this.belowSeconds = 0
    if (next === null) return null

    this.cooldownSeconds = this.cooldown
    return next
  }

  reset(): void {
    this.belowSeconds = 0
    this.cooldownSeconds = 0
  }
}
