/**
 * HUD の画面に固定する要素の配置（段 31、計画書の段 28）。**純関数。three も DOM も触らない。**
 *
 * `hud.ts` は位置の式を描画の関数ごとに直書きしていた（`width * 0.18` など）。要素を
 * 足す前に器を作る。足すたびに重なりを目で検算するのでは間に合わない。
 *
 * ここに置くのは画面に固定する要素だけ。ピッチの梯子、飛行経路の印、機首の印、機銃の
 * 照準、ロックの箱は 3D の向きから投影して置くので、配置の器の外にある。
 *
 * **Phase 10 の段 B1 で、録画（ユーザーの ACE COMBAT 7 の講座の録画）の比率に合わせた。**
 * 大きさは録画の 1920x1080 の画素を基準に書き、縮尺 `scale = min(高さ/1080, 幅/1920)` を
 * 掛ける。位置は画面の割合で置く（2026-10-15 ユーザーの決定）。以前は CSS の画素で固定で、
 * 文字は 13px だった（1920x1080 で大文字が約 9.5 画素、録画は約 20 画素）。値の出典は
 * `~/.claude/plans/dogfight-ac7-ref/measure/l1_summary.json`（lesson 1 のコマ 144〜918 の
 * 中央値）と `l3_summary.json`（レーダー）。
 *
 * 外接の箱（`bounds`）は重なりの検査に使う。文字の幅は等幅の書体の字送り（0.6 em）に、
 * 表示しうる最長の文字数を掛けて見積もる（`tests/hud/layout.test.ts`）
 */

/** 画面上の矩形。左上と大きさ、CSS 画素 */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 大きさの基準にする画面（録画の大きさ） */
export const REFERENCE_WIDTH = 1920
export const REFERENCE_HEIGHT = 1080

/**
 * 以下の `_REF` は録画の 1920x1080 での画素。描くときに `scale` を掛ける。
 *
 * 文字は録画の大文字の高さに合わせる。**撮って測って決めた。**28 画素で撮ると GUN・TIME の行が
 * 18 画素、録画は 20〜22（動画のにじみ 1〜2 画素を含む）だったので 31 にした。SPEED・ALT の見出しは
 * 20 画素で 13、録画は 18 だったので 24
 */
export const FONT_REF = 31
export const LABEL_FONT_REF = 24
export const SMALL_FONT_REF = 18
/** 等幅の書体の字送り（em） */
export const ADVANCE_EM = 0.6

/** 線の太さ。録画のピッチの目盛りの芯が 2 画素 */
export const LINE_WIDTH_REF = 2

/**
 * 照準の上下の欄（段 B2）。録画は照準の上に CAUTION（y 425〜452）、下に STALL（y 628〜655）と
 * AUTO PILOT（x 895〜1025・y 630〜653）。枠の高さ 26、文字は 20 で左右に 7 の余白
 * （AUTO PILOT の 10 文字で幅 130 になる）
 */
export const STATUS_FONT_REF = 20
export const STATUS_BOX_HEIGHT_REF = 26
export const STATUS_PAD_REF = 7
/** 下の欄の 2 段目（脚とフックが同時に出るとき）の間隔 */
export const STATUS_LINE_REF = 32

/**
 * 結果の帯（段 B3）。録画の DESTROYED は x 756〜1165・y 454〜489（幅 410・高さ 36）。文字は帯の
 * 高さの 6 割ほど
 */
export const BANNER_WIDTH_REF = 410
export const BANNER_HEIGHT_REF = 36
export const BANNER_FONT_REF = 26

/**
 * ミッション欄。録画の TIME と SCORE は x 100、大文字の上端 52 と 89 で、行の間隔は約 37
 */
export const MISSION_LINE_REF = 37

/**
 * 兵装の一覧。録画は見出し（`GUN`）が x 1656 から左揃え、数が x 1821 で右揃え、
 * 行の間隔は約 35（GUN 708〜731、MSL 747〜772、…）。その下に自機の輪郭（中心 1698, 955）
 */
export const ARMAMENT_LINE_REF = 35
/**
 * 自機の輪郭の幅と高さ（段 C3、録画のコマ 600 で測った機体の部分 x 1636〜1759・y 882〜997）。
 * 段 C2 までは 100×100 だった
 */
export const SILHOUETTE_WIDTH_REF = 124
export const SILHOUETTE_HEIGHT_REF = 115
/**
 * 左右の発射機の印（段 C3）。録画は輪郭の左右に縦長のミサイルの形（幅 16・高さ 82、中心 x 1611.5 と
 * 1784、y 913〜995）。輪郭の中心からの横のずれ、中心の高さのずれ、印の大きさ
 */
export const LAUNCHER_OFFSET_REF = 86.25
export const LAUNCHER_DY_REF = 14.5
export const LAUNCHER_WIDTH_REF = 16
export const LAUNCHER_HEIGHT_REF = 82

/**
 * SPEED と ALT の箱。録画は見出しが上、数字の箱が下の 2 段（SPEED 611〜700・y 500〜557）。
 * 数字の箱は高さ 35、照準側へ尖らせる。幅は録画の SPEED 90・ALT 109 の間の 100
 */
export const VALUE_BOX_WIDTH_REF = 100
export const VALUE_BOX_HEIGHT_REF = 35
/** 数字の箱の照準側の尖りの深さ */
export const VALUE_BOX_POINT_REF = 12
/** 見出しの基線から数字の箱の上端までの間 */
export const VALUE_LABEL_GAP_REF = 4

/**
 * 字の上下の中央を `centerY` に置く基線の y（段 D3、ユーザーの指示）。`ascent`・`descent` は実際の字形の
 * 基線から上端・下端までの長さ（`measureText` の `actualBoundingBox*`）。canvas の `textBaseline =
 * 'middle'` は書体の枠（em）の中央に置くので、数字は 1920x1080 で 2.5 画素上に寄っていた
 */
export function centeredBaseline(centerY: number, ascent: number, descent: number): number {
  return centerY + (ascent - descent) / 2
}

/**
 * 着艦の進入の計器（段 B7、ADR 0029）。録画に着艦は無いので、大きさと置き場所は照準のまわりの
 * 空きに合わせて決めた（推測）。ボールのセル 1 つの高さと幅、データムの腕の長さと間
 */
export const BALL_CELL_HEIGHT_REF = 12
export const BALL_CELL_WIDTH_REF = 14
export const DATUM_ARM_REF = 12
export const DATUM_GAP_REF = 2
/** 迎角の表示。ドーナツの半径と、上下の山形の幅と離れ */
export const AOA_RING_REF = 9
export const AOA_CHEVRON_REF = 12
export const AOA_CHEVRON_OFFSET_REF = 22
/** ラインナップの目盛り。片側の幅と、目印の高さ */
export const LINEUP_HALF_WIDTH_REF = 90
export const LINEUP_MARK_REF = 10

/** 縦の目盛り。速度（左）と高度（右） */
export interface VerticalTapeLayout {
  /** 目盛りの軸の x */
  readonly x: number
  readonly centerY: number
  readonly halfHeight: number
}

export interface HudLayout {
  /** 大きさの縮尺。`_REF` の値に掛ける */
  readonly scale: number
  readonly speedTape: VerticalTapeLayout
  readonly altitudeTape: VerticalTapeLayout
  readonly headingTape: { readonly centerX: number; readonly y: number; readonly halfWidth: number }
  /** 兵装の一覧。見出しの左端・数の右端・1 行目の基線 */
  readonly armament: { readonly labelX: number; readonly valueX: number; readonly y: number }
  /** 自機の輪郭の中心 */
  readonly silhouette: { readonly cx: number; readonly cy: number }
  readonly mission: { readonly x: number; readonly y: number }
  /** 照準の上の欄（CAUTION・MISSILE ALERT）と下の欄（STALL・脚など）の中心（段 B2） */
  readonly statusUpper: { readonly x: number; readonly y: number }
  readonly statusLower: { readonly x: number; readonly y: number }
  /** SHOOT の枠の中心（段 B3、録画は HUD の下の中央 x 920〜998・y 690〜714） */
  readonly shoot: { readonly x: number; readonly y: number }
  /**
   * SPEED と ALT の数字の箱。照準側の尖りの先の x と、箱の中心の高さ
   */
  readonly speedBox: { readonly innerX: number; readonly centerY: number }
  readonly altitudeBox: { readonly innerX: number; readonly centerY: number }
  /** レーダーの正方形。左上と一辺（段 34） */
  readonly radar: { readonly x: number; readonly y: number; readonly size: number }
  /**
   * 着艦の進入の計器の中心（段 B7）。迎角は照準の左（SPEED の箱との間）、ボールは照準の右
   * （ALT の箱との間）、ラインナップは SHOOT の下
   */
  readonly approachAoa: { readonly x: number; readonly y: number }
  readonly approachBall: { readonly x: number; readonly y: number }
  readonly approachLineup: { readonly x: number; readonly y: number }
  /** 各要素の外接の箱。重なりの検査に使う */
  readonly bounds: Readonly<Record<HudElement, Rect>>
}

/**
 * 重なりを検査する要素。**追従視点で描くものだけ。**縦の目盛りと方位の目盛りは段 36 で
 * 追従視点から外した（位置は `speedTape` などに残してある）ので、ここには入れない。
 * DLZ の帯と対地高度（AGL）は段 B1 でやめた（録画に無い、ユーザーの決定）
 */
export type HudElement =
  | 'speedBox'
  | 'altitudeBox'
  | 'armament'
  | 'mission'
  | 'statusUpper'
  | 'statusLower'
  | 'shoot'
  | 'banner'
  | 'radar'
  | 'approachAoa'
  | 'approachBall'
  | 'approachLineup'

/** 表示しうる最長の文字列の文字数。外接の箱の見積りに使う */
const LONGEST = {
  /** ミッションの撃墜の加点（`TARGET F-16 +1000`、3 行の中でいちばん長い）と敵の数（`ENEMY 8`） */
  target: 17,
  enemies: 7,
  /** 上の欄（`MISSILE ALERT`） */
  statusUpper: 13,
  /** 下の欄（`GEAR TRANSIT`） */
  statusLower: 12,
}

/** 大きさの縮尺。録画の 1920x1080 を 1 とし、高さと幅の小さいほうに合わせる */
export function hudScale(width: number, height: number): number {
  return Math.min(height / REFERENCE_HEIGHT, width / REFERENCE_WIDTH)
}

export function computeLayout(width: number, height: number): HudLayout {
  const s = hudScale(width, height)
  const font = FONT_REF * s
  const label = LABEL_FONT_REF * s
  const small = SMALL_FONT_REF * s

  const speedTape = { x: width * 0.18, centerY: height * 0.5, halfHeight: height * 0.22 }
  const altitudeTape = { x: width * 0.82, centerY: height * 0.5, halfHeight: height * 0.22 }
  const headingTape = { centerX: width * 0.5, y: height * 0.11, halfWidth: width * 0.2 }

  // 兵装（録画: 見出し x 1656、数の右端 x 1821、GUN の大文字の下端 731）
  const armament = { labelX: width * (1656 / 1920), valueX: width * (1821 / 1920), y: height * (731 / 1080) }
  // 輪郭の中心（録画の機体の部分 1698, 939.5。段 C2 までは下の 2 発を含めた 955 だった）
  const silhouette = { cx: width * (1698 / 1920), cy: height * (939.5 / 1080) }
  // ミッション（録画: x 100、TIME の大文字の下端 75）
  const mission = { x: width * (100 / 1920), y: height * (75 / 1080) }
  // 照準の上下の欄（録画: CAUTION の枠の中心 y 438.5、STALL の枠の中心 y 641.5）
  const statusUpper = { x: width * 0.5, y: height * (438.5 / 1080) }
  const statusLower = { x: width * 0.5, y: height * (641.5 / 1080) }
  const shoot = { x: width * 0.5, y: height * (702 / 1080) }
  // SPEED と ALT の数字の箱（録画: SPEED の右端 700、ALT の左端 1216、数字の箱は y 522〜557）
  const speedBox = { innerX: width * (700 / 1920), centerY: height * (539.5 / 1080) }
  const altitudeBox = { innerX: width * (1216 / 1920), centerY: height * (539.5 / 1080) }
  // レーダー（録画: 枠 x 100〜399、y 724〜1025）。一辺は縮尺で、左端と下端は画面の割合
  const radarSize = 300 * s
  const radar = { x: width * (100 / 1920), y: height * (1025 / 1080) - radarSize, size: radarSize }
  // 着艦の進入の計器（段 B7）。照準は画面の中央。ボールは結果の帯の右端と ALT の箱の尖りの間に
  // 収まる x。ラインナップは機体の排気口より下（Phase 10 の宿題 3、ユーザーの決定）。段 B7 では
  // 照準の下の欄と SHOOT の下（735/1080）に置いたが、主翼の後ろの縁と胴体に重なって読みにくかった
  const approachAoa = { x: width * (780 / 1920), y: height * 0.5 }
  const approachBall = { x: width * (1190 / 1920), y: height * 0.5 }
  const approachLineup = { x: width * 0.5, y: height * (900 / 1080) }
  const ballHalfW = (BALL_CELL_WIDTH_REF / 2 + DATUM_GAP_REF + DATUM_ARM_REF) * s
  const ballHalfH = (BALL_CELL_HEIGHT_REF * 6) * s
  const aoaHalfH = (AOA_CHEVRON_OFFSET_REF + AOA_CHEVRON_REF / 2) * s

  const boxW = VALUE_BOX_WIDTH_REF * s
  const boxH = VALUE_BOX_HEIGHT_REF * s
  // 見出しの大文字の上端から数字の箱の下端まで
  const valueTop = boxH / 2 + VALUE_LABEL_GAP_REF * s + label

  // 外接の箱。追従視点で描くものだけ（`HudElement`）
  const bounds: Record<HudElement, Rect> = {
    // SPEED。増減の三角は段 B2 でやめた（録画に無い、ユーザーの決定）
    speedBox: {
      x: speedBox.innerX - boxW,
      y: speedBox.centerY - valueTop,
      w: boxW,
      h: valueTop + boxH / 2,
    },
    altitudeBox: {
      x: altitudeBox.innerX,
      y: altitudeBox.centerY - valueTop,
      w: boxW,
      h: valueTop + boxH / 2,
    },
    // 兵装。4 行（GUN・MSL・FLR・DMG）と、その下の自機の輪郭
    armament: {
      x: Math.min(armament.labelX, silhouette.cx - (LAUNCHER_OFFSET_REF + LAUNCHER_WIDTH_REF / 2) * s),
      y: armament.y - font,
      w:
        Math.max(armament.valueX, silhouette.cx + (LAUNCHER_OFFSET_REF + LAUNCHER_WIDTH_REF / 2) * s) -
        Math.min(armament.labelX, silhouette.cx - (LAUNCHER_OFFSET_REF + LAUNCHER_WIDTH_REF / 2) * s),
      h: silhouette.cy + (SILHOUETTE_HEIGHT_REF * s) / 2 - (armament.y - font),
    },
    // ミッション。TIME / SCORE / TARGET と敵の数（4 行目、小さい字）
    mission: {
      x: mission.x,
      y: mission.y - font,
      w: Math.max(LONGEST.target * font * ADVANCE_EM, LONGEST.enemies * small * ADVANCE_EM),
      h: font + MISSION_LINE_REF * s * 3 + small * 0.3,
    },
    // 照準の上の欄。枠つきの 1 行
    statusUpper: statusBox(statusUpper, LONGEST.statusUpper, s),
    // 照準の下の欄。脚とフックが同時に出ると 2 段になる
    statusLower: {
      ...statusBox(statusLower, LONGEST.statusLower, s),
      h: STATUS_BOX_HEIGHT_REF * s + STATUS_LINE_REF * s,
    },
    // SHOOT。枠つきの 1 行
    shoot: statusBox(shoot, 5, s),
    // 結果の帯。照準の上（録画の中心 y 471.5）
    banner: {
      x: width * 0.5 - (BANNER_WIDTH_REF * s) / 2,
      y: height * (471.5 / 1080) - (BANNER_HEIGHT_REF * s) / 2,
      w: BANNER_WIDTH_REF * s,
      h: BANNER_HEIGHT_REF * s,
    },
    // レーダー。方位の文字も正方形の内側に描く
    radar: { x: radar.x, y: radar.y, w: radar.size, h: radar.size },
    // 着艦の進入の計器（段 B7）
    approachAoa: {
      x: approachAoa.x - (AOA_CHEVRON_REF / 2 + LINE_WIDTH_REF) * s,
      y: approachAoa.y - aoaHalfH,
      w: (AOA_CHEVRON_REF + LINE_WIDTH_REF * 2) * s,
      h: aoaHalfH * 2,
    },
    approachBall: { x: approachBall.x - ballHalfW, y: approachBall.y - ballHalfH, w: ballHalfW * 2, h: ballHalfH * 2 },
    approachLineup: {
      x: approachLineup.x - (LINEUP_HALF_WIDTH_REF + LINE_WIDTH_REF) * s,
      y: approachLineup.y - LINEUP_MARK_REF * s,
      w: (LINEUP_HALF_WIDTH_REF + LINE_WIDTH_REF) * 2 * s,
      h: LINEUP_MARK_REF * 2 * s,
    },
  }

  return {
    scale: s,
    speedTape,
    altitudeTape,
    headingTape,
    armament,
    silhouette,
    mission,
    statusUpper,
    statusLower,
    shoot,
    speedBox,
    altitudeBox,
    radar,
    approachAoa,
    approachBall,
    approachLineup,
    bounds,
  }
}

/** 照準の上下の欄の枠。中心と最長の文字数から */
function statusBox(center: { x: number; y: number }, chars: number, s: number): Rect {
  const w = (chars * STATUS_FONT_REF * ADVANCE_EM + STATUS_PAD_REF * 2) * s
  const h = STATUS_BOX_HEIGHT_REF * s
  return { x: center.x - w / 2, y: center.y - h / 2, w, h }
}
