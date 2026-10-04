/**
 * HUD の画面に固定する要素の配置（段 31、計画書の段 28）。**純関数。three も DOM も触らない。**
 *
 * `hud.ts` は位置の式を描画の関数ごとに直書きしていた（`width * 0.18` など）。要素を
 * 足す前に器を作る。足すたびに重なりを目で検算するのでは間に合わない。
 *
 * ここに置くのは画面に固定する要素だけ。ピッチの梯子、飛行経路の印、機首の印、機銃の
 * 照準、ロックの箱は 3D の向きから投影して置くので、配置の器の外にある。
 *
 * **位置の式は `hud.ts` の元の式と同じ順で計算する。**順を変えると浮動小数点の丸めが
 * 動いて、基準画像が 1 画素ずれる。合格条件は基準画像が 1 画素も動かないこと。
 *
 * 外接の箱（`bounds`）は重なりの検査に使う。文字の幅は等幅の書体の字送りに、表示しうる
 * 最長の文字数を掛けて見積もる（`tests/hud/layout.test.ts`）
 */

/** 画面上の矩形。左上と大きさ、CSS 画素 */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** DLZ バーの高さと幅 画面画素。ロックボックスの右に縦に置く */
export const DLZ_BAR_HEIGHT = 150
export const DLZ_BAR_WIDTH = 7

/** ミサイル警告の輪の半径 画面画素 */
export const THREAT_RADIUS = 26

/** ミッション欄の行の間隔 画面画素（段 32） */
export const MISSION_LINE = 16

/** 兵装の一覧の行の間隔と、その左に描く自機の輪郭の大きさ・間 画面画素（段 33） */
export const ARMAMENT_LINE = 16
export const SILHOUETTE_SIZE = 44
export const SILHOUETTE_GAP = 14

/** 13px の等幅の字送り（0.6 em）と、11px の字送り */
export const FONT_ADVANCE = 7.8
export const SMALL_ADVANCE = 6.6

/**
 * 兵装の一覧のいちばん長い行（`GUN 1800`・`DMG 100%`、8 文字、13px）の幅。
 * 輪郭の位置（`hud.ts`）と外接の箱の両方がこれを使う
 */
export const ARMAMENT_TEXT_WIDTH = 8 * FONT_ADVANCE

/**
 * 照準の左右に置く SPEED と ALT の箱（段 36）。中身は 13px で最長 `SPEED 1200`・`ALT 40000`
 * の 10 文字、左右に 7 画素の余白。外側に増減の三角（幅 8、間 5）
 */
export const VALUE_BOX_WIDTH = 10 * FONT_ADVANCE + 14
export const VALUE_BOX_HEIGHT = 20
export const TREND_GAP = 5
export const TREND_WIDTH = 8

/** 縦の目盛り。速度（左）と高度（右） */
export interface VerticalTapeLayout {
  /** 目盛りの軸の x */
  readonly x: number
  readonly centerY: number
  readonly halfHeight: number
}

export interface HudLayout {
  readonly speedTape: VerticalTapeLayout
  readonly altitudeTape: VerticalTapeLayout
  readonly headingTape: { readonly centerX: number; readonly y: number; readonly halfWidth: number }
  readonly dlzBar: { readonly x: number; readonly bottom: number }
  readonly armament: { readonly x: number; readonly y: number }
  readonly mission: { readonly x: number; readonly y: number }
  readonly threat: { readonly cx: number; readonly cy: number; readonly radius: number }
  readonly readouts: { readonly x: number; readonly y: number }
  readonly agl: { readonly x: number; readonly y: number }
  readonly warnings: { readonly x: number; readonly y: number }
  /**
   * SPEED と ALT の箱（段 36）。中心の高さと、照準側の縁の x（SPEED は右の縁、ALT は左の縁）
   */
  readonly speedBox: { readonly innerX: number; readonly centerY: number }
  readonly altitudeBox: { readonly innerX: number; readonly centerY: number }
  /** レーダーの正方形。左上と一辺（段 34） */
  readonly radar: { readonly x: number; readonly y: number; readonly size: number }
  /** 各要素の外接の箱。重なりの検査に使う */
  readonly bounds: Readonly<Record<HudElement, Rect>>
}

/**
 * 重なりを検査する要素。**追従視点で描くものだけ。**縦の目盛りと方位の目盛りは段 36 で
 * 追従視点から外した（位置は `speedTape` などに残してある）ので、ここには入れない
 */
export type HudElement =
  | 'speedBox'
  | 'altitudeBox'
  | 'dlzBar'
  | 'armament'
  | 'mission'
  | 'threat'
  | 'readouts'
  | 'agl'
  | 'warnings'
  | 'radar'

/** 表示しうる最長の文字列の文字数。外接の箱の見積りに使う */
const LONGEST = {
  /** DLZ の最大射程（`12.3K`） */
  dlzLabel: 5,
  /** ミッションの撃墜の加点（`TARGET F-16 +1000`、3 行の中でいちばん長い）と敵の数（`ENEMY 8`） */
  target: 17,
  enemies: 7,
  /** 警告（`MISSILE x8`） */
  threatLabel: 10,
  /** 読み（`AOA -10.5`）と高度（`AGL 40000`） */
  readout: 9,
  agl: 9,
  /** 警告が全部並んだとき（`CRASH  STALL  G LIMIT  LOW`）。DMG は段 33 で右下へ移した */
  warnings: 26,
}

export function computeLayout(width: number, height: number): HudLayout {
  const speedTape = { x: width * 0.18, centerY: height * 0.5, halfHeight: height * 0.22 }
  const altitudeTape = { x: width * 0.82, centerY: height * 0.5, halfHeight: height * 0.22 }
  const headingTape = { centerX: width * 0.5, y: height * 0.11, halfWidth: width * 0.2 }
  // DLZ バーは段 36 で 0.66 から 0.74 へ移した。照準の右に置いた ALT の箱とぶつかるため。
  // 高度の目盛り（0.82）が追従視点から消えて、右側が空いた
  const dlzBar = { x: width * 0.74, bottom: height * 0.5 + DLZ_BAR_HEIGHT / 2 }
  // 兵装の一覧は右下（段 33、参考画像に合わせた）。x は文字の右端、y は 1 行目の基線
  const armament = { x: width * 0.94, y: height * 0.8 }
  const mission = { x: width * 0.06, y: height * 0.08 }
  const threat = { cx: width * 0.3, cy: height * 0.3, radius: THREAT_RADIUS }
  const readouts = { x: width * 0.18, y: height * 0.78 }
  const agl = { x: width * 0.82, y: height * 0.78 }
  const warnings = { x: width * 0.5, y: height * 0.7 }
  // SPEED と ALT の箱は照準の左右（段 36、参考画像に合わせた）。中心から幅の 12% 離す
  const speedBox = { innerX: width * 0.5 - width * 0.12, centerY: height * 0.5 }
  const altitudeBox = { innerX: width * 0.5 + width * 0.12, centerY: height * 0.5 }
  // レーダーは左下（段 34、参考画像に合わせた）。一辺は短い辺の 22%、下端は高さの 97%
  const radarSize = Math.min(width, height) * 0.22
  const radar = { x: width * 0.03, y: height * 0.97 - radarSize, size: radarSize }

  // 外接の箱。追従視点で描くものだけ（`HudElement`）
  const bounds: Record<HudElement, Rect> = {
    // SPEED の箱。外側（左）に増減の三角
    speedBox: {
      x: speedBox.innerX - VALUE_BOX_WIDTH - TREND_GAP - TREND_WIDTH,
      y: speedBox.centerY - VALUE_BOX_HEIGHT / 2,
      w: VALUE_BOX_WIDTH + TREND_GAP + TREND_WIDTH,
      h: VALUE_BOX_HEIGHT,
    },
    // ALT の箱。外側（右）に増減の三角
    altitudeBox: {
      x: altitudeBox.innerX,
      y: altitudeBox.centerY - VALUE_BOX_HEIGHT / 2,
      w: VALUE_BOX_WIDTH + TREND_GAP + TREND_WIDTH,
      h: VALUE_BOX_HEIGHT,
    },
    // DLZ。帯の左へ 5 はみ出す現在距離の線、右へ文字（帯 + 8 から）
    dlzBar: {
      x: dlzBar.x - 5,
      y: dlzBar.bottom - DLZ_BAR_HEIGHT - 8,
      w: 5 + DLZ_BAR_WIDTH + 8 + LONGEST.dlzLabel * SMALL_ADVANCE,
      h: DLZ_BAR_HEIGHT + 10,
    },
    // 兵装。右揃えの 4 行（13px、基線 y から 16 ずつ）と、その左の自機の輪郭
    armament: {
      x: armament.x - ARMAMENT_TEXT_WIDTH - SILHOUETTE_GAP - SILHOUETTE_SIZE,
      y: armament.y - 11,
      w: ARMAMENT_TEXT_WIDTH + SILHOUETTE_GAP + SILHOUETTE_SIZE,
      h: 11 + ARMAMENT_LINE * 3 + 3,
    },
    // ミッション。TIME / SCORE / TARGET（13px、基線 y から 16 ずつ）と敵の数（11px、4 行目）
    mission: {
      x: mission.x,
      y: mission.y - 11,
      w: Math.max(LONGEST.target * FONT_ADVANCE, LONGEST.enemies * SMALL_ADVANCE),
      h: 11 + MISSION_LINE * 3 + 3,
    },
    // ミサイル警告。輪（半径 26）と向きの三角（輪 + 10）、上に文字（中央 cy − 48）
    threat: {
      x: threat.cx - (LONGEST.threatLabel * FONT_ADVANCE) / 2,
      y: threat.cy - threat.radius - 22 - 7,
      w: LONGEST.threatLabel * FONT_ADVANCE,
      h: threat.radius * 2 + 22 + 7 + 10,
    },
    // 読み。3 行（基線 y、y + 16、y + 32）、左揃え
    readouts: { x: readouts.x, y: readouts.y - 9, w: LONGEST.readout * SMALL_ADVANCE, h: 9 + 32 + 3 },
    // 高度。右揃え、基線 y
    agl: { x: agl.x - LONGEST.agl * SMALL_ADVANCE, y: agl.y - 9, w: LONGEST.agl * SMALL_ADVANCE, h: 12 },
    // 警告。中央揃え、13px、基線 y
    warnings: {
      x: warnings.x - (LONGEST.warnings * FONT_ADVANCE) / 2,
      y: warnings.y - 10,
      w: LONGEST.warnings * FONT_ADVANCE,
      h: 13,
    },
    // レーダー。方位の文字も正方形の内側に描く
    radar: { x: radar.x, y: radar.y, w: radar.size, h: radar.size },
  }

  return {
    speedTape,
    altitudeTape,
    headingTape,
    dlzBar,
    armament,
    mission,
    threat,
    readouts,
    agl,
    warnings,
    speedBox,
    altitudeBox,
    radar,
    bounds,
  }
}
