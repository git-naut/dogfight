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

/** 13px の等幅の字送り（0.6 em）と、11px の字送り */
export const FONT_ADVANCE = 7.8
export const SMALL_ADVANCE = 6.6

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
  /** 各要素の外接の箱。重なりの検査に使う */
  readonly bounds: Readonly<Record<HudElement, Rect>>
}

export type HudElement =
  | 'speedTape'
  | 'altitudeTape'
  | 'headingTape'
  | 'dlzBar'
  | 'armament'
  | 'mission'
  | 'threat'
  | 'readouts'
  | 'agl'
  | 'warnings'

/** 表示しうる最長の文字列の文字数。外接の箱の見積りに使う */
const LONGEST = {
  /** 速度の目盛りの数字（`1200`）と高度の目盛りの数字（`40000`） */
  speedLabel: 4,
  altitudeLabel: 5,
  /** DLZ の最大射程（`12.3K`） */
  dlzLabel: 5,
  /** 兵装（`GUN 1800`） */
  armament: 8,
  /** ミッションの撃墜の加点（`TARGET F-16 +1000`、3 行の中でいちばん長い）と敵の数（`ENEMY 8`） */
  target: 17,
  enemies: 7,
  /** 警告（`MISSILE x8`） */
  threatLabel: 10,
  /** 読み（`AOA -10.5`）と高度（`AGL 40000`） */
  readout: 9,
  agl: 9,
  /** 警告が全部並んだとき（`CRASH  STALL  G LIMIT  LOW  DMG 100%`） */
  warnings: 36,
}

export function computeLayout(width: number, height: number): HudLayout {
  const speedTape = { x: width * 0.18, centerY: height * 0.5, halfHeight: height * 0.22 }
  const altitudeTape = { x: width * 0.82, centerY: height * 0.5, halfHeight: height * 0.22 }
  const headingTape = { centerX: width * 0.5, y: height * 0.11, halfWidth: width * 0.2 }
  const dlzBar = { x: width * 0.66, bottom: height * 0.5 + DLZ_BAR_HEIGHT / 2 }
  const armament = { x: width * 0.5, y: height * 0.9 }
  const mission = { x: width * 0.06, y: height * 0.08 }
  const threat = { cx: width * 0.3, cy: height * 0.3, radius: THREAT_RADIUS }
  const readouts = { x: width * 0.18, y: height * 0.78 }
  const agl = { x: width * 0.82, y: height * 0.78 }
  const warnings = { x: width * 0.5, y: height * 0.7 }

  // 外接の箱。縦の目盛りは軸の外側に現在値の箱（幅 62 + 間 2）、内側に目盛り（12）と
  // 数字（4 空けて）。縦は目盛りの範囲と、数字の半分の高さ
  const tapeTop = speedTape.centerY - speedTape.halfHeight - 6
  const tapeHeight = speedTape.halfHeight * 2 + 12
  const bounds: Record<HudElement, Rect> = {
    speedTape: {
      x: speedTape.x - 64,
      y: tapeTop,
      w: 64 + 16 + LONGEST.speedLabel * SMALL_ADVANCE,
      h: tapeHeight,
    },
    altitudeTape: {
      x: altitudeTape.x - 16 - LONGEST.altitudeLabel * SMALL_ADVANCE,
      y: tapeTop,
      w: 16 + LONGEST.altitudeLabel * SMALL_ADVANCE + 64,
      h: tapeHeight,
    },
    // 方位の目盛り。上に現在値（下端が y − 28、13px）、下に数字（上端が y + 4、11px）
    headingTape: {
      x: headingTape.centerX - headingTape.halfWidth - 10,
      y: headingTape.y - 28 - 13,
      w: headingTape.halfWidth * 2 + 20,
      h: 28 + 13 + 4 + 11,
    },
    // DLZ。帯の左へ 5 はみ出す現在距離の線、右へ文字（帯 + 8 から）
    dlzBar: {
      x: dlzBar.x - 5,
      y: dlzBar.bottom - DLZ_BAR_HEIGHT - 8,
      w: 5 + DLZ_BAR_WIDTH + 8 + LONGEST.dlzLabel * SMALL_ADVANCE,
      h: DLZ_BAR_HEIGHT + 10,
    },
    // 兵装。幅 120 の弾数の帯（y + 6）と、その下の数字（基線 y + 24）
    armament: { x: armament.x - 60, y: armament.y + 6, w: 120, h: 21 },
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
    bounds,
  }
}
