import type { AircraftSample } from '../sim/aircraft'
import { Vec3 } from '../sim/vec3'
import type { LockState } from '../sim/weapons/lock'
import {
  createScreenPoint,
  directionFromAzimuthElevation,
  headingOf,
  projectDirection,
  projectPoint,
  type Mat4,
  type ScreenPoint,
} from './project'
import {
  computeReadout,
  createHudReadout,
  formatScore,
  formatTimer,
  gearLabel,
  hookLabel,
  upperStatusText,
  type HudReadout,
} from './readout'
import type { MissileThreat } from '../sim/weapons/warning'
import type { LandingResult } from '../sim/arrestor'
import { BALL_CELLS, DATUM_CELL, YELLOW_CELLS, type ApproachGuide } from '../sim/approachGuide'
import { landingNoticeText, lineupMarkOffset } from './approach'
import { killBannerText } from './banner'
import {
  ALERT,
  ALERT_RED,
  APPROACH_RED,
  APPROACH_YELLOW,
  BANNER_FILL,
  BANNER_TEXT,
  LOCK_PINK,
  MAIN,
  MAIN_DIM,
  MISSILE_RED,
  MISSILE_RED_DIM,
  RADAR_DOT,
  RADAR_FILL,
  RADAR_FRAME,
  RADAR_LINE,
  RADAR_LINE_DIM,
  RADAR_TARGET,
  TEXT_SHADE,
  TEXT_SHADE_WIDTH_REF,
  TARGET_WHITE,
  WARN,
} from './palette'
import { LAUNCHER_SHAPE, rgbaText, silhouetteColor } from './armament'
import type { Launcher } from '../sim/combat'
import { RADAR_OUTER_RING, RADAR_OWN_Y, RADAR_RINGS, radarBearing, radarPoint, radarRange } from './radar'
import { offscreenDirection } from './arrow'
import {
  computeLayout,
  ARMAMENT_LINE_REF,
  FONT_REF,
  LABEL_FONT_REF,
  LINE_WIDTH_REF,
  MISSION_LINE_REF,
  SILHOUETTE_HEIGHT_REF,
  SILHOUETTE_WIDTH_REF,
  LAUNCHER_DY_REF,
  LAUNCHER_HEIGHT_REF,
  LAUNCHER_OFFSET_REF,
  SMALL_FONT_REF,
  STATUS_BOX_HEIGHT_REF,
  STATUS_FONT_REF,
  STATUS_LINE_REF,
  STATUS_PAD_REF,
  BANNER_FONT_REF,
  VALUE_BOX_HEIGHT_REF,
  VALUE_BOX_POINT_REF,
  VALUE_BOX_WIDTH_REF,
  VALUE_LABEL_GAP_REF,
  centeredBaseline,
  AOA_CHEVRON_OFFSET_REF,
  AOA_CHEVRON_REF,
  AOA_RING_REF,
  BALL_CELL_HEIGHT_REF,
  BALL_CELL_WIDTH_REF,
  DATUM_ARM_REF,
  DATUM_GAP_REF,
  LINEUP_HALF_WIDTH_REF,
  LINEUP_MARK_REF,
  type HudLayout,
  type VerticalTapeLayout,
} from './layout'

/**
 * ヘッドアップディスプレイ。
 *
 * `#hud` の中に 2D canvas を重ねる。**3D の中には描かない。**composer の外に
 * 置けば、HUD の緑がトーンマッピングを通らず純色のまま出る。レンダースケールを
 * 下げても文字が滲まない。GPU の費用もかからない。
 *
 * ピッチラダーと水平線とフライトパスマーカーは**外の世界に重なる**（conformal）。
 * 世界の方向を投影して描くので、カメラのロールと画角がそのまま効く。追従カメラは
 * 機体のロールに遅れて追うので、ラダーもその遅れのまま傾く。
 *
 * 描く値はすべて sim の状態と行列から決まる。実時間に触らないので、
 * キャプチャモードでも同じフレーム番号から同じ絵が出る。
 *
 * **この HUD が要る理由は絵で測って分かった。**追従カメラの垂直画角は速度
 * 250 m/s で 66.4 度あり、190 m の機体でも実測 28 x 10 画素にしかならない。
 * 交戦距離の相手は肉眼では見つけられない。
 */

/**
 * 主線。**録画の芯の色に寄せた（段 B1）。**録画の線は暗い背景（RGB 83,129,87）で芯が
 * RGB 179,232,181、明るい空で白に近い。白に近い淡い緑を 8 割の濃さで重ねると、暗い背景で
 * RGB 189,230,193 になる。周りに広がる光りは無い（芯 2 画素、両脇は背景より暗い）ので付けない
 */
const GREEN = MAIN
/** 補助線。目盛りの細かいほう */
const GREEN_DIM = MAIN_DIM
/**
 * **ミサイル警告のあいだの HUD の色（段 B2）。**録画は警告のあいだ HUD 全体が赤みのあるピンクに替わる。
 *
 * 録画の線は暗い背景でも雲の上でも背景より明るくなる（スクリーンの重ね方の振る舞い）。最初は
 * それに合わせて `#hud` をスクリーンで重ねたが、明るい空の上ではほとんど読めなかった。ユーザーが
 * 4 つの候補を並べた図から「通常の重ね方・半透明 45%」を選んだ（2026-10-16）。明るい空では
 * 背景より暗い赤、暗い背景では明るい赤になる
 */
const RED = MISSILE_RED
const RED_DIM = MISSILE_RED_DIM
/**
 * 着艦の進入の計器の色（段 B7）。IFLOLS の上 10 セルの黄と下 2 セルの赤、迎角のドーナツの黄と
 * 速すぎの赤（Jungemann 2000、PDF 24・67 頁）。遅すぎは緑で、HUD の緑（`primary`）で描く
 */
const BALL_YELLOW = APPROACH_YELLOW
const BALL_RED = APPROACH_RED
// 色は `palette.ts` の表から取る（段 D3）。経緯（段 B2・B3・B5 の録画の値、帯の文字を抜くのをやめた理由）は
// 表の注記と ADR 0023・0024・0027・0031
/** 点滅の周期と、点いている長さ（フレーム）。録画は 6 コマ点いて 6 コマ消える（30fps、0.4 秒周期） */
const BLINK_PERIOD_FRAMES = 48
const BLINK_ON_FRAMES = 24

/** 書体。大きさは縮尺で決める（`applySize`） */
const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * 機銃の照準の円の半径・中の小さな丸の半径・中の短い線の長さ（段 D4、録画の 1920x1080 の画素）。
 * 録画の円は半径 42〜49 画素（lesson 4 で 42 前後、lesson 5 で 49 前後）。段 D3 までは半径 24 画素だった
 */
const RETICLE_RADIUS_REF = 44
/**
 * 照準の形（段 D6、録画のコマ 19996 を半径ごと・角度ごとに数えた）。外の丸は半径 40〜49 に画素があり、
 * 線は太い（4）。目盛りは同じ長さで丸の外 2〜6。中心は小さな点。録画の内側の円弧（半径 27〜31、画面の上
 * から右回りに下まで）は、ユーザーの決定で描かない
 */
const RETICLE_LINE_REF = 4
const RETICLE_TICK_FROM_REF = 2
const RETICLE_TICK_TO_REF = 6
const RETICLE_DOT_REF = 1.5
/** 画面の中央の −○− の印（段 D6、録画の lesson 1 のコマ 60・1490） */
const FPM_RADIUS_REF = 7.5
const FPM_HALF_SPAN_REF = 25.5
const FPM_TAIL_REF = 7.5

/**
 * 目標の箱とロックの印（段 B3、録画の 1920x1080 の画素）。録画はロック前の白い四角が約 33 画素、
 * ロックした赤いひし形が約 35 画素（lesson 4 のコマ 11700 と 11760）
 */
const TARGET_BOX_HALF_REF = 16.5
const LOCK_DIAMOND_HALF_REF = 17.5
/** ロックしたときの四角の半分（段 D6、録画のコマ 20020 で約 42 画素） */
const LOCK_SQUARE_HALF_REF = 21
/**
 * 画面の外の相手を指す矢印を置く半径。画面の短い辺に対する割合（段 35）。
 *
 * 0.28 では真後ろを指す矢印が自機のノズルの間に重なり、炎とまぎれた（missile-warning）。
 * 0.4 で機体の下に出る。上向きは方位の目盛りの高さに来るが、段 36 で追従視点から消す
 */
const ARROW_RADIUS = 0.4
const arrowScratch = { x: 0, y: 0 }

/**
 * レーダーの色（段 B5、録画に合わせた）。録画は枠と線が緑（RGB 95,193,90）、地は半透明の暗い緑で、
 * 前の扇の内側に細かい点の模様がある。目標（TGT）は赤い丸に A（RGB 205,94,77）
 */
/**
 * 地。録画は背景（RGB 166,166,152）の上で 71,107,59。半透明を重ねる式で解くと、この色と濃さで 3 色とも
 * 合う（濃さの解は R 0.65・G 0.69・B 0.70）。最初に置いた 0.38 では灰色がかって薄かった
 */
/** 扇の内側の点の間隔（録画の 1920x1080 の画素） */
const RADAR_DOT_STEP_REF = 6
/** レーダーの方位の文字 */
const RADAR_LABELS: readonly [string, number][] = [
  ['N', 0],
  ['E', Math.PI / 2],
  ['S', Math.PI],
  ['W', (Math.PI * 3) / 2],
]
const radarScratch = { x: 0, y: 0 }
const radarPointScratch = { x: 0, y: 0, clamped: false }
const radarScratchPoint = { x: 0, y: 0, clamped: false }

/**
 * 自機（F/A-18E）を上から見た輪郭。機首が上、大きさ 1 の箱の中の (x, y) の並び（段 33）。
 * 翼・水平尾翼・機首を角で拾った粗い形で、損傷の図にだけ使う
 */
const SILHOUETTE = [
  0, -0.5, 0.06, -0.3, 0.08, -0.05, 0.5, 0.12, 0.5, 0.2, 0.1, 0.16, 0.1, 0.3, 0.26, 0.42, 0.26,
  0.48, 0.07, 0.46, 0.05, 0.5, -0.05, 0.5, -0.07, 0.46, -0.26, 0.48, -0.26, 0.42, -0.1, 0.3, -0.1,
  0.16, -0.5, 0.2, -0.5, 0.12, -0.08, -0.05, -0.06, -0.3,
]

const DEG = Math.PI / 180

/** 輪郭の中の塗りの濃さ（段 C3）。録画の輪郭は中も薄く光る */
const SILHOUETTE_FILL_ALPHA = 0.3

/**
 * ピッチラダーの刻み 度。
 *
 * 10 度刻みは実機の HUD と同じ。5 度刻みにすると、画角 66.4 度の画面に
 * 27 本入って線だらけになる。
 */
const LADDER_STEP = 10
/** ラダーを出す最大の仰角 度 */
const LADDER_LIMIT = 80
/** ラダー 1 本の方位方向の半幅 度 */
const LADDER_HALF_SPAN = 5
/** 中央の空き 度。フライトパスマーカーを隠さないため */
const LADDER_HALF_GAP = 1.8
/** 1 本を何分割して折れ線にするか。等仰角の線は厳密には曲線 */
const LADDER_SEGMENTS = 4
/** 水平線の半幅 度。画面を横切る長さにする */
const HORIZON_HALF_SPAN = 40
const HORIZON_SEGMENTS = 16

/** 速度目盛り。細かい刻みと数字を出す刻み kt */
const SPEED_MINOR = 20
const SPEED_MAJOR = 100
/** 目盛りの上下に見せる範囲 kt */
const SPEED_RANGE = 150

/** 高度目盛り ft */
const ALTITUDE_MINOR = 200
const ALTITUDE_MAJOR = 1000
const ALTITUDE_RANGE = 3000

/** 方位目盛り 度 */
const HEADING_MINOR = 5
const HEADING_MAJOR = 30
const HEADING_RANGE = 30



/**
 * 武装の状態。
 *
 * `AircraftSample` には載せない。飛行の状態ではないし、DLZ と残ミサイルを
 * 足すときにここへ増やしていける。
 */
export interface HudArmament {
  /** 機銃の残弾 */
  rounds: number
  /** ミサイルの残り（段 33） */
  missiles: number
  /**
   * レーダーに載せる相手（段 34）。先頭の `contactCount` 件だけを読む。
   * 器は使い回す（毎フレーム配列を作らない）
   */
  contacts: HudContact[]
  contactCount: number
  /**
   * 空母（段 37、計画書の段 31）。レーダーに載せる。台本に空母が無ければ null。
   * 位置は世界座標 m、向きは方位 rad（北 0、右回り）
   */
  carrier: { x: number; z: number; heading: number } | null
  /** シーカーの捕捉 */
  lock: HudLock
  /** 残りのフレア */
  flares: number
  /**
   * ミサイル警告。
   *
   * **方位を出す。**有無だけでは、どちらへ逃げるか決められない。
   * `src/sim/weapons/warning.ts` が測った値をそのまま渡す。
   */
  threat: MissileThreat
  /**
   * ミッション。走っていなければ null。
   *
   * **出ていないときは 1 画素も変えない。**基準画像 42 枚のうち 40 枚は
   * ミッションのない台本で撮ってある。`drawThreat` と同じ作法
   */
  mission: HudMission | null
  /**
   * 自機の弾かミサイルが最後に当たったフレームと、最後に撃墜したフレーム（段 B3、結果の帯）。
   * `World.frame` の数え方。まだ無ければ −1
   */
  hits: { lastHit: number; lastKill: number }
  /**
   * 自機へ向かって飛んでいる敵のミサイル（段 B5、レーダーに赤い線で描く）。先頭の `count` 件だけを
   * 読む。位置と速度は世界座標の水平の成分 m・m/s
   */
  incoming: { count: number; points: { x: number; z: number; vx: number; vz: number }[] }
  /** 左右の発射機（段 C3、`Combat.launchers`）。0 が左。兵装の欄の印に出す */
  launchers: readonly Launcher[]
  /** 機銃の照準の吸い付き（段 D4、`Combat.gunSnapped`・`gunLead.future`）。吸い付いていれば照準を未来位置に置く */
  gun: { snapped: boolean; future: { x: number; y: number; z: number } }
  /** 着艦の進入の計器の値（段 B7、`World.approach`）。空母の無い台本では null */
  approach: ApproachGuide | null
  /** 結果の帯に出し続ける着艦の結果（段 B7、`World.landingNotice`）。無ければ null */
  landingNotice: LandingResult | null
}

/**
 * レーダーと目標の箱に載せる相手（段 34・35）。位置は世界座標 m で、描画と同じ補間した位置
 */
export interface HudContact {
  x: number
  y: number
  z: number
  /** 敵は四角（警告色）、標的機は菱形 */
  kind: 'enemy' | 'target'
  /** 機名。目標の箱の下に出す（`F-16`・`DRONE`） */
  designation: string
  /** シーカーが捕まえている相手。目標の箱は描かず、ロックボックスに任せる */
  locked: boolean
}

/** ミッションの表示に要る値 */
export interface HudMission {
  /** 残り時間 フレーム */
  remainingFrames: number
  /** 生きている敵の数 */
  enemiesAlive: number
  /**
   * 決着。`running` のあいだは時計が緑、決着したら止める。
   *
   * 文字列で受ける。**`hud/` は sim を import しない**（`readout.ts` と
   * `project.ts` が守っている境界）
   */
  outcome: string
  /** 合計の点数（段 32） */
  score: number
  /**
   * 撃墜の加点の表示。撃墜から 3 秒のあいだだけ入り、それ以外は null（段 32）。
   * 消える時刻は sim が決める（`ScoreLog.latest`）
   */
  kill: { designation: string; points: number } | null
}

export interface HudLock {
  state: LockState
  /** 目標の世界座標。state が none のときは読まない */
  readonly position: Vec3
  /** 距離 m */
  range: number
  /** 接近速度 m/s。正が接近 */
  closingSpeed: number
  /** 捕捉の進み 0..1 */
  progress: number
  /** DLZ。3 つの半径 m。ロックしていなければすべて 0 */
  dlz: { rMax: number; rNe: number; rMin: number }
}

export function createHudLock(): HudLock {
  return {
    state: 'none',
    position: new Vec3(),
    range: 0,
    closingSpeed: 0,
    progress: 0,
    dlz: { rMax: 0, rNe: 0, rMin: 0 },
  }
}

export interface Hud {
  /** 直近の update で作った数値。E2E とデバッグから読む */
  readonly readout: HudReadout
  /** フライトパスマーカーが画面に入っているか */
  readonly flightPathOnScreen: boolean
  /** ガンレティクルが画面に入っているか */
  readonly gunReticleOnScreen: boolean
  /** ロックボックスが画面に入っているか */
  readonly lockBoxOnScreen: boolean
  /** ミサイル警告で HUD を赤にしているか（段 B2） */
  readonly alertRed: boolean
  /** 照準の上の欄の文字（`MISSILE ALERT`・`CAUTION`、無ければ空）。点滅で消えているコマでも入る */
  readonly statusUpper: string
  /** 上の欄がこのコマで点いているか */
  readonly statusBlinkOn: boolean
  /** 照準の下の欄の文字。2 段なら ` / ` でつなぐ */
  readonly statusLower: string
  /** 結果の帯の文字（`HIT`・`DESTROYED`、無ければ空）（段 B3） */
  readonly banner: string
  /** いまのレーダーの縮尺 m。いちばん外の円の半径が表す距離（段 B5） */
  readonly radarRange: number
  /** SHOOT を出しているか（段 35） */
  readonly shootShown: boolean
  /** 目標の箱を描いた数（段 35） */
  readonly targetBoxCount: number
  /** 画面の外の相手を指す矢印を出しているか（段 35） */
  readonly arrowShown: boolean
  /** 機銃の照準が敵の未来位置に吸い付いているか（段 D4） */
  readonly gunSnapped: boolean
  /** 着艦の進入の計器を出しているか（段 B7） */
  readonly approachShown: boolean
  resize(width: number, height: number, devicePixelRatio: number): void
  /**
   * 1 枚描き直す。
   *
   * @param viewProjection カメラのビュー射影行列。列優先 16 要素
   */
  update(sample: AircraftSample, armament: HudArmament, viewProjection: Mat4, frame: number): void
  dispose(): void
}

/**
 * 計器の出し方（段 36）。
 *
 * `chase` は追従視点の HUD（参考画像の Ace Combat 7 に合わせた）。ピッチの梯子・方位の目盛り・
 * 縦の目盛りを描かず、照準の左右に SPEED と ALT の箱を置く。`full` は段 35 までの計器で、
 * 操縦席など別の視点を足すときのために残す。**いまはどの経路も `chase` を使う**
 */
export type HudInstruments = 'chase' | 'full'

export function createHud(host: HTMLElement, instruments: HudInstruments = 'chase'): Hud {
  const canvas = document.createElement('canvas')
  canvas.className = 'hud-canvas'
  host.append(canvas)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('HUD の 2D コンテキストが取れない')

  const readout = createHudReadout()

  let width = 1280
  let height = 720
  let dpr = 1
  let onScreen = false
  let layout: HudLayout = computeLayout(width, height)
  /**
   * 縮尺（段 B1）。`s` は録画の 1920x1080 を 1 とする（`layout.scale`）。`u` は録画で測って
   * いない部品（照準の十字・ロックの箱・矢印など）に掛ける縮尺で、以前の CSS 画素の見た目を
   * 1280x720（表示倍率 150% の全画面）で保つ。段 B3 で録画の値に置き換える
   */
  let s = layout.scale
  let u = s * 1.5
  let lineWidth = LINE_WIDTH_REF * s
  let font = `${FONT_REF * s}px ${FONT_FAMILY}`
  let labelFont = `${LABEL_FONT_REF * s}px ${FONT_FAMILY}`
  let smallFont = `${SMALL_FONT_REF * s}px ${FONT_FAMILY}`
  let statusFont = `${STATUS_FONT_REF * s}px ${FONT_FAMILY}`
  let bannerFont = `${BANNER_FONT_REF * s}px ${FONT_FAMILY}`
  /** いま使う主線と補助線の色。ミサイル警告のあいだは赤（段 B2） */
  let primary = GREEN
  let dim = GREEN_DIM
  let alertRed = false
  /** 上下の欄の警告の文字の色。警告のあいだは濃い赤 */
  let alert = ALERT
  let statusUpperText = ''
  let statusLowerText = ''
  let statusBlinkOn = false
  let bannerText = ''
  /** いまのレーダーの縮尺 m（段 B5） */
  let radarRangeShown = 0
  /** レーダーの扇の内側の点の模様。大きさが変わったときに作り直す */
  let radarDots: CanvasPattern | null = null
  let reticleOnScreen = false
  let lockOnScreen = false
  let shootShown = false
  let targetBoxCount = 0
  let arrowShown = false
  let gunSnappedShown = false
  let approachShown = false


  // ガンレティクルの位置。使い回す
  const impact = new Vec3()

  // 使い回す。毎フレーム作らない
  const a = createScreenPoint()
  const b = createScreenPoint()
  const dir = { x: 0, y: 0, z: 0 }
  const points: ScreenPoint[] = Array.from(
    { length: HORIZON_SEGMENTS + 1 },
    createScreenPoint,
  )

  function applySize(): void {
    // 画面に固定する要素の位置は器が決める（段 31）
    layout = computeLayout(width, height)
    s = layout.scale
    u = s * 1.5
    lineWidth = LINE_WIDTH_REF * s
    font = `${FONT_REF * s}px ${FONT_FAMILY}`
    labelFont = `${LABEL_FONT_REF * s}px ${FONT_FAMILY}`
    smallFont = `${SMALL_FONT_REF * s}px ${FONT_FAMILY}`
    statusFont = `${STATUS_FONT_REF * s}px ${FONT_FAMILY}`
    bannerFont = `${BANNER_FONT_REF * s}px ${FONT_FAMILY}`
    radarDots = makeRadarDots()
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }

  /**
   * レーダーの点の模様を 1 回だけ作る。描くたびに点を打たず、模様で 1 回塗る（軽さのため）。
   * 模様の 1 マスは CSS 画素の間隔に DPR を掛けた実画素で作る（キャンバスは DPR 倍で描いている）
   */
  function makeRadarDots(): CanvasPattern | null {
    const step = Math.max(2, Math.round(RADAR_DOT_STEP_REF * s * dpr))
    const tile = document.createElement('canvas')
    tile.width = step
    tile.height = step
    const t = tile.getContext('2d')
    if (t === null) return null
    t.fillStyle = RADAR_DOT
    const dot = Math.max(1, Math.round(dpr))
    t.fillRect(0, 0, dot, dot)
    const pattern = ctx!.createPattern(tile, 'repeat')
    // キャンバスは setTransform(dpr) で描くので、模様は 1/dpr に縮めて実画素の間隔に戻す
    pattern?.setTransform(new DOMMatrix().scale(1 / dpr))
    return pattern
  }

  /** 方位と仰角で決まる方向を投影する */
  function project(
    m: Mat4,
    azimuth: number,
    elevation: number,
    out: ScreenPoint,
  ): ScreenPoint {
    directionFromAzimuthElevation(azimuth, elevation, dir)
    return projectDirection(m, dir.x, dir.y, dir.z, width, height, out)
  }

  /**
   * 等仰角の線を折れ線で引く。
   *
   * 等仰角の軌跡は厳密には円錐曲線なので、両端を直線で結ぶと高い仰角でずれる。
   * 分割して折れ線にする。**カメラの後ろへ回った点は捨てる。**同次除算で
   * 符号が反転し、画面の反対側へ折り返した位置が出るので、そのまま結ぶと
   * 画面を横切る嘘の線が引かれる。
   */
  function polyline(
    m: Mat4,
    elevation: number,
    fromAzimuth: number,
    toAzimuth: number,
    segments: number,
  ): void {
    let started = false
    ctx!.beginPath()
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      const az = fromAzimuth + (toAzimuth - fromAzimuth) * t
      const p = project(m, az, elevation, points[i]!)
      if (!p.inFront) {
        started = false
        continue
      }
      if (started) ctx!.lineTo(p.x, p.y)
      else {
        ctx!.moveTo(p.x, p.y)
        started = true
      }
    }
    ctx!.stroke()
  }

  /** 2 点を結ぶ。どちらかが後ろなら描かない */
  function segment(p: ScreenPoint, q: ScreenPoint): void {
    if (!p.inFront || !q.inFront) return
    ctx!.beginPath()
    ctx!.moveTo(p.x, p.y)
    ctx!.lineTo(q.x, q.y)
    ctx!.stroke()
  }

  /**
   * ラダーの傾きに合わせて数字を置く。
   *
   * **回転角はラダーの向きであって、外向きの向きではない。**外向きで取ると
   * 左側だけ 180 度回って数字が鏡文字になる（30 が 0E に見える）。最初に
   * そう書いていて、撮った絵で気づいた。左右どちらの側でも「左の点から
   * 右の点へ」の向きを使えば、文字は常に正立する。
   *
   * @param at 数字を置く点（ラダーの外端）
   * @param towards ラダーのもう一方の点（内端）
   * @param side -1 が画面の左、+1 が右
   */
  function rungLabel(
    text: string,
    at: ScreenPoint,
    towards: ScreenPoint,
    side: number,
  ): void {
    if (!at.inFront || !towards.inFront) return
    const angle =
      side > 0
        ? Math.atan2(at.y - towards.y, at.x - towards.x)
        : Math.atan2(towards.y - at.y, towards.x - at.x)
    ctx!.save()
    ctx!.translate(at.x, at.y)
    ctx!.rotate(angle)
    ctx!.textAlign = side > 0 ? 'left' : 'right'
    ctx!.textBaseline = 'middle'
    ctx!.fillText(text, side > 0 ? 8 : -8, 0)
    ctx!.restore()
  }

  function drawLadder(m: Mat4, heading: number): void {
    ctx!.strokeStyle = primary
    ctx!.fillStyle = primary
    ctx!.font = smallFont

    for (let pitch = -LADDER_LIMIT; pitch <= LADDER_LIMIT; pitch += LADDER_STEP) {
      const elevation = pitch * DEG
      if (pitch === 0) {
        ctx!.lineWidth = lineWidth * 1.3
        ctx!.setLineDash([])
        polyline(
          m,
          0,
          heading - HORIZON_HALF_SPAN * DEG,
          heading + HORIZON_HALF_SPAN * DEG,
          HORIZON_SEGMENTS,
        )
        continue
      }

      ctx!.lineWidth = lineWidth
      // 降下側は破線。実機の HUD と同じ約束で、上下を一目で見分けられる
      ctx!.setLineDash(pitch < 0 ? [6, 5] : [])

      for (const side of [-1, 1]) {
        const inner = heading + side * LADDER_HALF_GAP * DEG
        const outer = heading + side * LADDER_HALF_SPAN * DEG
        polyline(m, elevation, inner, outer, LADDER_SEGMENTS)

        // 端の爪は水平線の側へ向ける。どちらが空でどちらが地面か分かる
        ctx!.setLineDash([])
        const tip = project(m, outer, elevation, a)
        const towardHorizon = project(m, outer, elevation - Math.sign(pitch) * 1.6 * DEG, b)
        segment(tip, towardHorizon)

        const innerPoint = project(m, inner, elevation, points[0]!)
        rungLabel(String(Math.abs(pitch)), tip, innerPoint, side)
        ctx!.setLineDash(pitch < 0 ? [6, 5] : [])
      }
    }
    ctx!.setLineDash([])
  }

  /** 縦の目盛り。速度と高度で共有する */
  function drawVerticalTape(
    tape: VerticalTapeLayout,
    value: number,
    minor: number,
    major: number,
    range: number,
    label: string,
    alignRight: boolean,
  ): void {
    const { x, halfHeight, centerY } = tape
    const perUnit = halfHeight / range
    const dirSign = alignRight ? -1 : 1

    ctx!.strokeStyle = dim
    ctx!.lineWidth = 1
    ctx!.beginPath()
    ctx!.moveTo(x, centerY - halfHeight)
    ctx!.lineTo(x, centerY + halfHeight)
    ctx!.stroke()

    const first = Math.ceil((value - range) / minor) * minor
    ctx!.font = smallFont
    ctx!.textBaseline = 'middle'
    ctx!.textAlign = alignRight ? 'right' : 'left'

    for (let v = first; v <= value + range; v += minor) {
      const y = centerY - (v - value) * perUnit
      const isMajor = Math.abs(v % major) < minor * 0.5
      const len = isMajor ? 12 : 6
      ctx!.strokeStyle = isMajor ? primary : dim
      ctx!.beginPath()
      ctx!.moveTo(x, y)
      ctx!.lineTo(x + dirSign * len, y)
      ctx!.stroke()
      if (isMajor) {
        ctx!.fillStyle = dim
        ctx!.fillText(String(Math.round(v)), x + dirSign * (len + 4), y)
      }
    }

    // 現在値。目盛りの中央に箱で置く
    const text = String(Math.round(value))
    ctx!.font = font
    const boxWidth = 62
    const boxHeight = 22
    const boxX = alignRight ? x + 2 : x - boxWidth - 2
    ctx!.strokeStyle = primary
    ctx!.lineWidth = lineWidth
    ctx!.strokeRect(boxX, centerY - boxHeight / 2, boxWidth, boxHeight)
    ctx!.fillStyle = primary
    ctx!.textAlign = 'center'
    ctx!.fillText(text, boxX + boxWidth / 2, centerY)

    ctx!.font = smallFont
    ctx!.fillStyle = dim
    ctx!.textAlign = 'center'
    ctx!.fillText(label, boxX + boxWidth / 2, centerY + boxHeight / 2 + 10)
  }

  function drawHeadingTape(headingDeg: number): void {
    const { y, halfWidth, centerX } = layout.headingTape
    const perDegree = halfWidth / HEADING_RANGE

    ctx!.strokeStyle = dim
    ctx!.lineWidth = 1
    ctx!.beginPath()
    ctx!.moveTo(centerX - halfWidth, y)
    ctx!.lineTo(centerX + halfWidth, y)
    ctx!.stroke()

    ctx!.font = smallFont
    ctx!.textBaseline = 'top'
    ctx!.textAlign = 'center'

    const first = Math.ceil((headingDeg - HEADING_RANGE) / HEADING_MINOR) * HEADING_MINOR
    for (let d = first; d <= headingDeg + HEADING_RANGE; d += HEADING_MINOR) {
      const x = centerX + (d - headingDeg) * perDegree
      const isMajor = ((d % HEADING_MAJOR) + HEADING_MAJOR) % HEADING_MAJOR < 1e-6
      ctx!.strokeStyle = isMajor ? primary : dim
      ctx!.beginPath()
      ctx!.moveTo(x, y)
      ctx!.lineTo(x, y - (isMajor ? 10 : 5))
      ctx!.stroke()
      if (isMajor) {
        const shown = ((Math.round(d) % 360) + 360) % 360
        ctx!.fillStyle = dim
        ctx!.fillText(String(shown).padStart(3, '0'), x, y + 4)
      }
    }

    // 現在の方位。目盛りの中央に置く
    ctx!.strokeStyle = primary
    ctx!.lineWidth = lineWidth
    ctx!.beginPath()
    ctx!.moveTo(centerX, y - 14)
    ctx!.lineTo(centerX - 6, y - 24)
    ctx!.lineTo(centerX + 6, y - 24)
    ctx!.closePath()
    ctx!.stroke()

    ctx!.font = font
    ctx!.fillStyle = primary
    ctx!.textBaseline = 'bottom'
    ctx!.fillText(
      String(Math.round(headingDeg) % 360).padStart(3, '0'),
      centerX,
      y - 28,
    )
  }

  /** フライトパスマーカー。機体が実際に向かっている先 */
  function drawFlightPath(m: Mat4): void {
    const fp = readout.flightPath
    const p = projectDirection(m, fp.x, fp.y, fp.z, width, height, a)
    onScreen =
      p.inFront && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height
    if (!p.inFront) return

    // 録画の −○− の印（段 D6。lesson 1 のコマ 60・1490、全幅 51・全高 27）。丸は半径 7.5、左右の線は
    // 中心から 25.5 まで、上の線は丸の上から 7.5。段 D5 までは丸が半径 13.5 で約 2 倍だった
    const r = FPM_RADIUS_REF * s
    ctx!.strokeStyle = primary
    ctx!.lineWidth = lineWidth
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx!.stroke()

    ctx!.beginPath()
    ctx!.moveTo(p.x - FPM_HALF_SPAN_REF * s, p.y)
    ctx!.lineTo(p.x - r, p.y)
    ctx!.moveTo(p.x + r, p.y)
    ctx!.lineTo(p.x + FPM_HALF_SPAN_REF * s, p.y)
    ctx!.moveTo(p.x, p.y - r)
    ctx!.lineTo(p.x, p.y - r - FPM_TAIL_REF * s)
    ctx!.stroke()
  }

  /**
   * 機銃の照準（段 D4、録画に合わせた）。
   *
   * 録画は目盛り付きの大きな丸（1920x1080 で半径 42〜49 画素）。敵が近いと敵に重なる（lesson 4 のコマ
   * 12734〜12758・15512〜15548）。800 m 以内で機首の前にいる相手の未来位置（`Combat.gunLead.future`）に置き、
   * **相手がいなければ出さない**（段 D6 の追記、ユーザーの決定）。録画では敵が遠いと中央付近に出ているが、
   * 吸い付く範囲に入った時から出す。段 D3 まであった左右のシェブロン・基準の距離「300」・機首の十字は
   * 録画に無いのでやめた（ユーザーの決定）
   */
  function drawGunReticle(m: Mat4, gun: HudArmament['gun']): void {
    gunSnappedShown = gun.snapped
    // 吸い付く相手がいるときだけ出す（段 D6 の追記、ユーザーの決定）。段 D6 まではいつも出し、相手が
    // いなければ 300 m の着弾点に置いていた
    reticleOnScreen = false
    if (!gun.snapped) return
    impact.set(gun.future.x, gun.future.y, gun.future.z)
    const p = projectPoint(m, impact.x, impact.y, impact.z, width, height, a)
    reticleOnScreen = p.inFront && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height
    if (!p.inFront) return
    // 録画の照準（段 D6、lesson 5 のコマ 19996・lesson 4 のコマ 12746）。太い外の丸、同じ長さの短い目盛り
    // 12 本、中心の点。録画にある内側の右の円弧は、ユーザーの決定で描かない。録画で中に見えた −○− は
    // 画面の中央の印が重なっていたもので、照準の一部ではない
    const r = RETICLE_RADIUS_REF * s
    ctx!.strokeStyle = primary
    ctx!.lineWidth = RETICLE_LINE_REF * s
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx!.stroke()
    ctx!.lineWidth = lineWidth
    ctx!.beginPath()
    for (let k = 0; k < 12; k++) {
      const angle = (k * Math.PI) / 6
      const c = Math.cos(angle)
      const sn = Math.sin(angle)
      ctx!.moveTo(p.x + c * (r + RETICLE_TICK_FROM_REF * s), p.y + sn * (r + RETICLE_TICK_FROM_REF * s))
      ctx!.lineTo(p.x + c * (r + RETICLE_TICK_TO_REF * s), p.y + sn * (r + RETICLE_TICK_TO_REF * s))
    }
    ctx!.stroke()
    ctx!.fillStyle = primary
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, RETICLE_DOT_REF * s, 0, Math.PI * 2)
    ctx!.fill()
  }

  /**
   * ロックの印（段 B3、録画に合わせた）。
   *
   * 録画はロックする前の敵に白い四角（約 33 画素）、ロックすると赤いひし形（約 35 画素）を付ける
   * （lesson 4 のコマ 11706 → 11712）。大きさは見かけの大きさに合わせず固定にした。捕捉中は白い
   * 四角の上に捕捉の進みの帯を出す（録画では見分けられない。ユーザーの決定で残した）。
   *
   * 距離と機種は印の右に 2 行（録画は `7024` と `F-16C`）。段 37 までの接近速度はやめた（録画に無い）
   */
  function drawLockBox(m: Mat4, lock: HudLock, armament: HudArmament): void {
    lockOnScreen = false
    shootShown = false
    if (lock.state === 'none') return

    const center = projectPoint(m, lock.position.x, lock.position.y, lock.position.z, width, height, a)
    if (!center.inFront) return
    lockOnScreen =
      center.x >= 0 && center.x <= width && center.y >= 0 && center.y <= height

    const locked = lock.state === 'locked'
    const half = (locked ? LOCK_SQUARE_HALF_REF : TARGET_BOX_HALF_REF) * s
    ctx!.lineWidth = lineWidth
    if (locked) {
      // 録画（コマ 20020）はロックすると淡いピンクの四角と、その中のひし形（段 D6）
      const d = LOCK_DIAMOND_HALF_REF * s
      ctx!.strokeStyle = LOCK_PINK
      ctx!.strokeRect(center.x - half, center.y - half, half * 2, half * 2)
      ctx!.beginPath()
      ctx!.moveTo(center.x, center.y - d)
      ctx!.lineTo(center.x + d, center.y)
      ctx!.lineTo(center.x, center.y + d)
      ctx!.lineTo(center.x - d, center.y)
      ctx!.closePath()
      ctx!.stroke()
    } else {
      ctx!.strokeStyle = TARGET_WHITE
      ctx!.strokeRect(center.x - half, center.y - half, half * 2, half * 2)
      // 捕捉の進みを上辺の外の帯で見せる
      ctx!.strokeStyle = dim
      ctx!.lineWidth = lineWidth * 1.5
      ctx!.beginPath()
      ctx!.moveTo(center.x - half, center.y - half - 6 * s)
      ctx!.lineTo(center.x - half + half * 2 * lock.progress, center.y - half - 6 * s)
      ctx!.stroke()
    }

    // 距離（m の整数）と機種。ロック中の相手の機種は contacts の locked から引く
    let designation = ''
    for (let i = 0; i < armament.contactCount; i++) {
      if (armament.contacts[i]!.locked) designation = armament.contacts[i]!.designation
    }
    // 距離と機種の文字は、ロック前は白、ロックしたら主の緑（録画のコマ 20020 の「2018 / F-16C」）
    targetLabel(center.x + half + 6 * s, center.y - half, `${Math.round(lock.range)}`, designation, locked ? primary : TARGET_WHITE)

    // **SHOOT（段 35・37、段 B3 で録画の位置へ）。**ロックしていて、距離が `rMin`〜`rNe` の内のとき。
    // 録画は HUD の下の中央に枠つきで出す（x 920〜998・y 690〜714）。段 B2 までは箱の下に付いて動いた
    shootShown = locked && lock.range >= lock.dlz.rMin && lock.range <= lock.dlz.rNe && lock.dlz.rNe > 0
    if (shootShown) statusBox('SHOOT', layout.shoot.x, layout.shoot.y, primary)
  }

  /**
   * 結果の帯（段 B3、録画に合わせた）。照準の上（録画 x 756〜1165・y 454〜489）に、撃墜なら HIT の
   * あとに DESTROYED、落ちない当たりなら HIT だけを出す。1 フレームで出て 1 フレームで消える。
   * 警告の赤い HUD のあいだも緑のまま（録画のコマ 17110 は MISSILE ALERT の下に緑の DESTROYED）
   *
   * @param frame `World.frame`。命中と撃墜のフレームと同じ数え方
   */
  function drawBanner(hits: HudArmament['hits'], frame: number, landing: LandingResult | null): void {
    bannerText = ''
    bannerText = killBannerText(hits.lastHit, hits.lastKill, frame)
    // 着艦の結果は次の試みまで出し続ける（段 B7）。撃墜の帯が出ているあいだはそちらが先
    if (bannerText === '') bannerText = landingNoticeText(landing)
    if (bannerText === '') return

    const { x, y, w, h } = layout.bounds.banner
    ctx!.fillStyle = BANNER_FILL
    ctx!.fillRect(x, y, w, h)
    ctx!.font = bannerFont
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    ctx!.fillStyle = BANNER_TEXT
    ctx!.fillText(bannerText, x + w / 2, y + h / 2)
  }

  /**
   * 着艦の進入の計器（段 B7、ADR 0029）。脚を出して艦尾の後ろ 3,000 m 以内にいるあいだだけ出す。
   * 出ていないときは 1 画素も変えない
   *
   * - ボール（照準の右）。12 セルの枠と、進入の線の高さのデータムの腕。ボールのセルだけを塗る。
   *   上の 10 セルは黄、下の 2 セルは赤。外れたら塗らない
   * - 迎角（照準の左）。オン・スピードは黄のドーナツ、遅すぎは上に緑の下向きの山形、速すぎは
   *   下に赤の上向きの山形
   * - ラインナップ（SHOOT の下）。横の目盛りに、着艦区域の中心線のある方へ縦の目印
   */
  function drawApproach(guide: ApproachGuide | null): void {
    approachShown = guide !== null && guide.active
    if (!approachShown) return
    const g = guide!
    ctx!.lineWidth = lineWidth

    // ボール
    const ball = layout.approachBall
    const cellW = BALL_CELL_WIDTH_REF * s
    const cellH = BALL_CELL_HEIGHT_REF * s
    const top = ball.y - (BALL_CELLS / 2) * cellH
    if (g.ballCell >= 0 && g.ballCell < BALL_CELLS) {
      ctx!.fillStyle = g.ballCell < YELLOW_CELLS ? BALL_YELLOW : BALL_RED
      ctx!.fillRect(ball.x - cellW / 2, top + g.ballCell * cellH, cellW, cellH)
    }
    ctx!.strokeStyle = dim
    ctx!.beginPath()
    for (let i = 0; i <= BALL_CELLS; i++) {
      ctx!.moveTo(ball.x - cellW / 2, top + i * cellH)
      ctx!.lineTo(ball.x + cellW / 2, top + i * cellH)
    }
    ctx!.moveTo(ball.x - cellW / 2, top)
    ctx!.lineTo(ball.x - cellW / 2, top + BALL_CELLS * cellH)
    ctx!.moveTo(ball.x + cellW / 2, top)
    ctx!.lineTo(ball.x + cellW / 2, top + BALL_CELLS * cellH)
    ctx!.stroke()
    // データムの腕。進入の線の高さ（上から 6 セル目と 7 セル目の間）
    const datumY = top + DATUM_CELL * cellH
    const armIn = cellW / 2 + DATUM_GAP_REF * s
    const armOut = armIn + DATUM_ARM_REF * s
    ctx!.strokeStyle = primary
    ctx!.beginPath()
    ctx!.moveTo(ball.x - armOut, datumY)
    ctx!.lineTo(ball.x - armIn, datumY)
    ctx!.moveTo(ball.x + armIn, datumY)
    ctx!.lineTo(ball.x + armOut, datumY)
    ctx!.stroke()

    // 迎角
    const aoa = layout.approachAoa
    const half = (AOA_CHEVRON_REF / 2) * s
    const off = AOA_CHEVRON_OFFSET_REF * s
    if (g.aoa === 'onSpeed') {
      ctx!.strokeStyle = BALL_YELLOW
      ctx!.beginPath()
      ctx!.arc(aoa.x, aoa.y, AOA_RING_REF * s, 0, Math.PI * 2)
      ctx!.stroke()
    } else if (g.aoa === 'slow') {
      // 上に下向きの山形（機首を下げろ）
      ctx!.strokeStyle = primary
      ctx!.beginPath()
      ctx!.moveTo(aoa.x - half, aoa.y - off - half / 2)
      ctx!.lineTo(aoa.x, aoa.y - off + half / 2)
      ctx!.lineTo(aoa.x + half, aoa.y - off - half / 2)
      ctx!.stroke()
    } else {
      // 下に上向きの山形（機首を上げろ）
      ctx!.strokeStyle = BALL_RED
      ctx!.beginPath()
      ctx!.moveTo(aoa.x - half, aoa.y + off + half / 2)
      ctx!.lineTo(aoa.x, aoa.y + off - half / 2)
      ctx!.lineTo(aoa.x + half, aoa.y + off + half / 2)
      ctx!.stroke()
    }

    // ラインナップ
    const line = layout.approachLineup
    const reach = LINEUP_HALF_WIDTH_REF * s
    const mark = LINEUP_MARK_REF * s
    ctx!.strokeStyle = primary
    ctx!.beginPath()
    ctx!.moveTo(line.x - reach, line.y)
    ctx!.lineTo(line.x + reach, line.y)
    for (const k of [-1, -0.5, 0, 0.5, 1]) {
      const tick = k === 0 ? mark * 0.6 : mark * 0.35
      ctx!.moveTo(line.x + k * reach, line.y - tick)
      ctx!.lineTo(line.x + k * reach, line.y + tick)
    }
    ctx!.stroke()
    const mx = line.x + lineupMarkOffset(g.lineupDeg) * reach
    ctx!.strokeStyle = BALL_YELLOW
    ctx!.beginPath()
    ctx!.moveTo(mx, line.y - mark)
    ctx!.lineTo(mx, line.y + mark)
    ctx!.stroke()
  }

  /** 印の右の 2 行（距離と機種）。左上を (x, y) に置く */
  function targetLabel(x: number, y: number, range: string, designation: string, color: string): void {
    ctx!.font = smallFont
    ctx!.fillStyle = color
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'top'
    shadedText(range, x, y)
    if (designation !== '') shadedText(designation, x, y + SMALL_FONT_REF * s * 1.1)
  }

  /**
   * 目標の箱（段 35、段 B3 で録画に合わせた）。画面に写っている相手すべてに白い四角（約 33 画素）と、
   * 右に距離と機種の 2 行。ロック中の相手は描かない（ロックの印が描く）。大きさは変えない。
   * 交戦距離の相手は肉眼では数画素にしか写らないので、見つけるための印として置く
   */
  function drawTargetBoxes(m: Mat4, sample: AircraftSample, armament: HudArmament): void {
    targetBoxCount = 0
    ctx!.lineWidth = lineWidth
    const half = TARGET_BOX_HALF_REF * s
    for (let i = 0; i < armament.contactCount; i++) {
      const c = armament.contacts[i]!
      if (c.locked) continue
      const p = projectPoint(m, c.x, c.y, c.z, width, height, a)
      if (!p.inFront || p.x < 0 || p.x > width || p.y < 0 || p.y > height) continue
      ctx!.strokeStyle = TARGET_WHITE
      ctx!.strokeRect(p.x - half, p.y - half, half * 2, half * 2)
      const range = Math.hypot(c.x - sample.position.x, c.y - sample.position.y, c.z - sample.position.z)
      targetLabel(p.x + half + 6 * s, p.y - half, `${Math.round(range)}`, c.designation, TARGET_WHITE)
      targetBoxCount++
    }
  }

  /**
   * 画面の外の相手を指す矢印（段 35）。**いちばん近い相手を 1 つだけ。**
   *
   * 画面の中心のまわり（短い辺の 40%）に三角を置き、相手の方へ向ける。後ろの相手は
   * 投影が折り返すので、向きの計算は `arrow.ts` に切り出してテストで固めた
   */
  function drawArrow(m: Mat4, sample: AircraftSample, armament: HudArmament): void {
    arrowShown = false
    let nearest = -1
    let best = Infinity
    for (let i = 0; i < armament.contactCount; i++) {
      const c = armament.contacts[i]!
      const d = Math.hypot(c.x - sample.position.x, c.y - sample.position.y, c.z - sample.position.z)
      if (d < best) {
        best = d
        nearest = i
      }
    }
    if (nearest < 0) return
    const c = armament.contacts[nearest]!
    const p = projectPoint(m, c.x, c.y, c.z, width, height, a)
    const dir = offscreenDirection(p, width, height, arrowScratch)
    if (dir === null) return
    arrowShown = true

    const r = Math.min(width, height) * ARROW_RADIUS
    const tipX = width / 2 + dir.x * r
    const tipY = height / 2 + dir.y * r
    // 三角。先端が相手の方、底辺は向きに直交
    const back = 12 * u
    const side = 7 * u
    ctx!.beginPath()
    ctx!.moveTo(tipX, tipY)
    ctx!.lineTo(tipX - dir.x * back - dir.y * side, tipY - dir.y * back + dir.x * side)
    ctx!.lineTo(tipX - dir.x * back + dir.y * side, tipY - dir.y * back - dir.x * side)
    ctx!.closePath()
    ctx!.fillStyle = c.kind === 'enemy' ? WARN : primary
    ctx!.fill()
  }

  /**
   * 兵装の一覧と自機の損傷（段 33、参考画像の右下に合わせた）。
   *
   * 右揃えで `GUN`・`MSL`・`FLR`・`DMG` の 4 行、その左に自機を上から見た輪郭。
   * **選択の印（参考画像の `>`）は付けない。**このゲームは機銃とミサイルを別のボタンで
   * 撃つので、選んでいる武器が無い。
   *
   * 以前は下中央に機銃の帯（幅 120）と残弾を置き、損傷は中央の警告の列に
   * `DMG xx%` として傷ついたときだけ出していた。どちらもここへ移した。尽きた兵装と
   * 傷ついた損傷は警告色にする
   */
  function drawArmament(armament: HudArmament): void {
    const { labelX, valueX, y } = layout.armament
    const damage = 1 - Math.max(0, Math.min(1, readout.integrityRatio))
    const damaged = damage > 0

    // **録画の形（段 B1）。**見出しを左揃え、数を右揃えの 2 列で、行の間隔 35
    ctx!.font = font
    ctx!.textBaseline = 'alphabetic'
    const rows: [string, string, boolean][] = [
      // 弾が尽きない機銃は録画と同じく「---」（段 D2）
      ['GUN', Number.isFinite(armament.rounds) ? `${armament.rounds}` : '---', armament.rounds <= 0],
      ['MSL', `${armament.missiles}`, armament.missiles <= 0],
      ['FLR', `${armament.flares}`, armament.flares <= 0],
      ['DMG', `${Math.round(damage * 100)}%`, damaged],
    ]
    for (let i = 0; i < rows.length; i++) {
      const [name, value, warn] = rows[i]!
      const rowY = y + ARMAMENT_LINE_REF * s * i
      ctx!.fillStyle = warn ? WARN : primary
      ctx!.textAlign = 'left'
      shadedText(name, labelX, rowY)
      ctx!.textAlign = 'right'
      shadedText(value, valueX, rowY)
    }

    // 自機の輪郭。録画と同じく一覧の下に、薄く塗って縁を引く（段 C3 で録画の大きさへ）。
    // **損傷は全体で 1 つの色。**sim は部位ごとの損傷を持たない（耐久 1 本）。損傷 0 は HUD の緑
    // （警告の赤い HUD のあいだは赤）、そこから黄、赤へ（`silhouetteColor`）
    const { cx, cy } = layout.silhouette
    const w = SILHOUETTE_WIDTH_REF * s
    const h = SILHOUETTE_HEIGHT_REF * s
    ctx!.beginPath()
    for (let i = 0; i < SILHOUETTE.length; i += 2) {
      const px = cx + SILHOUETTE[i]! * w
      const py = cy + SILHOUETTE[i + 1]! * h
      if (i === 0) ctx!.moveTo(px, py)
      else ctx!.lineTo(px, py)
    }
    ctx!.closePath()
    // 損傷 0 でも輪郭は録画の濃い緑（段 D3）。警告の赤い HUD のあいだは HUD と同じ赤
    const color = alertRed ? primary : rgbaText(silhouetteColor(damage))
    ctx!.fillStyle = color
    ctx!.globalAlpha = SILHOUETTE_FILL_ALPHA
    ctx!.fill()
    ctx!.globalAlpha = 1
    ctx!.strokeStyle = color
    ctx!.lineWidth = lineWidth
    ctx!.stroke()

    // 左右の発射機の印（段 C3）。撃てる側は塗りつぶし、満ちている途中は下から進みのぶんを塗る。
    // 残りが無い側は縁だけ
    for (let side = 0; side < armament.launchers.length; side++) {
      const launcher = armament.launchers[side]!
      const x = cx + (side === 0 ? -1 : 1) * LAUNCHER_OFFSET_REF * s
      const top = cy + (LAUNCHER_DY_REF - LAUNCHER_HEIGHT_REF / 2) * s
      ctx!.beginPath()
      for (let i = 0; i < LAUNCHER_SHAPE.length; i += 2) {
        const px = x + LAUNCHER_SHAPE[i]! * s
        const py = top + LAUNCHER_SHAPE[i + 1]! * s
        if (i === 0) ctx!.moveTo(px, py)
        else ctx!.lineTo(px, py)
      }
      ctx!.closePath()
      const filled = launcher.empty ? 0 : launcher.progress
      if (filled > 0) {
        ctx!.save()
        ctx!.clip()
        ctx!.fillStyle = primary
        const fillH = LAUNCHER_HEIGHT_REF * s * filled
        ctx!.fillRect(x - 10 * s, top + LAUNCHER_HEIGHT_REF * s - fillH, 20 * s, fillH)
        ctx!.restore()
      }
      ctx!.strokeStyle = launcher.empty ? dim : primary
      ctx!.lineWidth = lineWidth
      ctx!.stroke()
    }
  }

  /**
   * ミッション。残り時間と残敵。
   *
   * **左上に置く。**中央上部は方位テープ（`height * 0.11`）とその上の
   * 現在方位・三角、さらに上へピッチラダーの目盛が来る（実測。上端まで
   * 埋まっている）。左右の上隅は空いている。
   *
   * **走っていなければ何も描かない。**ミッションのない台本で撮った基準画像
   * 40 枚は 1 画素も動かない。`drawThreat` と同じ作法。
   *
   * 決着したら色を変える。成功は主線、失敗は警告色。
   */
  function drawMission(mission: HudMission | null): void {
    if (mission === null) return

    const { x, y } = layout.mission
    const settled = mission.outcome !== 'running'
    const failed = settled && mission.outcome !== 'cleared'

    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'alphabetic'

    // **参考画像（Ace Combat 7）の左上に合わせる**（段 32）。TIME、SCORE、撃墜の瞬間だけ
    // TARGET 機名 +点。残り時間は決着したらそこで止まる（`Mission.remainingFrames`）
    ctx!.font = font
    ctx!.fillStyle = failed ? WARN : primary
    shadedText(`TIME ${formatTimer(mission.remainingFrames)}`, x, y)
    ctx!.fillStyle = primary
    shadedText(`SCORE ${formatScore(mission.score)}`, x, y + MISSION_LINE_REF * s)
    if (mission.kill !== null) {
      shadedText(`TARGET ${mission.kill.designation} +${mission.kill.points}`, x, y + MISSION_LINE_REF * s * 2)
    }

    // 残敵。0 になったら成功。**レーダー（段 34）が入っても残す。**レーダーは位置を見せるが、
    // 勝ち負けに直結する残りの数は見せない
    ctx!.font = smallFont
    ctx!.fillStyle = settled ? (failed ? WARN : primary) : dim
    shadedText(`ENEMY ${mission.enemiesAlive}`, x, y + MISSION_LINE_REF * s * 3)
  }

  /**
   * SPEED と ALT の箱（段 36、参考画像に合わせた）。照準の左右に置く。
   *
   * 値は縦の目盛りと同じ kt と ft。箱の外側に増減の三角を出す。SPEED は速さの変化率
   * （`AircraftSample.speedRate`）が ±1 m/s² を越えたら、ALT は上下の速さが ±2 m/s を
   * 越えたら。越えなければ出さない（水平の巡航でちらつかせない）
   */
  function drawValueBoxes(): void {
    // **録画の形（段 B1）。**上に見出し（SPEED・ALT）、下に数字の箱。箱は照準の側へ尖らせる
    const w = VALUE_BOX_WIDTH_REF * s
    const h = VALUE_BOX_HEIGHT_REF * s
    const point = VALUE_BOX_POINT_REF * s
    const pad = 8 * s
    ctx!.lineWidth = lineWidth
    ctx!.strokeStyle = primary
    ctx!.fillStyle = primary

    const { innerX: sx, centerY: sy } = layout.speedBox
    valueBox(sx, sy, w, h, point, -1)
    ctx!.textBaseline = 'alphabetic'
    ctx!.font = labelFont
    ctx!.textAlign = 'left'
    shadedText('SPEED', sx - w, sy - h / 2 - VALUE_LABEL_GAP_REF * s)
    // 数字は字形の上下の中央を箱の中央に置く（段 D3）
    ctx!.font = font
    ctx!.textBaseline = 'alphabetic'
    ctx!.textAlign = 'right'
    const digits = ctx!.measureText('0123456789')
    const ascent = digits.actualBoundingBoxAscent
    const descent = digits.actualBoundingBoxDescent
    shadedText(`${Math.round(readout.speedKt)}`, sx - point - pad, centeredBaseline(sy, ascent, descent))

    const { innerX: ax, centerY: ay } = layout.altitudeBox
    valueBox(ax, ay, w, h, point, 1)
    ctx!.textBaseline = 'alphabetic'
    ctx!.font = labelFont
    ctx!.textAlign = 'right'
    shadedText('ALT', ax + w, ay - h / 2 - VALUE_LABEL_GAP_REF * s)
    ctx!.font = font
    ctx!.textBaseline = 'alphabetic'
    ctx!.textAlign = 'right'
    shadedText(`${Math.round(readout.altitudeFt)}`, ax + w - pad, centeredBaseline(ay, ascent, descent))
  }

  /**
   * 数字の箱。照準側の端を `point` だけ尖らせた五角形。`side` が −1 なら箱は tipX の左（SPEED）、
   * +1 なら右（ALT）
   */
  function valueBox(tipX: number, cy: number, w: number, h: number, point: number, side: -1 | 1): void {
    const far = tipX + side * w
    const shoulder = tipX + side * point
    ctx!.beginPath()
    ctx!.moveTo(far, cy - h / 2)
    ctx!.lineTo(shoulder, cy - h / 2)
    ctx!.lineTo(tipX, cy)
    ctx!.lineTo(shoulder, cy + h / 2)
    ctx!.lineTo(far, cy + h / 2)
    ctx!.closePath()
    ctx!.stroke()
  }

  /**
   * レーダー（段 34、段 B5 で録画に合わせた）。機首が上。自機は枠の左右の真ん中・上から 66.4%。
   *
   * 自機を通る十字と、前へ開く扇（枠の上の角へ）、距離の円 3 本（1:2:4）。縮尺はいちばん近い相手で
   * 2〜32 km の段から選ぶ（`radarRange`）。相手は赤い丸に A、枠の外の相手は縁に「^」。自機へ向かう
   * 敵のミサイルは進む向きの赤い短い線。空母は艦首の向きに回した細長い枠。高度差は見ない
   */
  function drawRadar(sample: AircraftSample, armament: HudArmament): void {
    const { x, y, size } = layout.radar
    const ox = x + size / 2
    const oy = y + size * RADAR_OWN_Y
    const ring = size * RADAR_OUTER_RING
    const heading = headingOf(readout.nose.x, readout.nose.y, readout.nose.z)
    const line = alertRed ? primary : RADAR_LINE
    const lineDim = alertRed ? dim : RADAR_LINE_DIM

    // 縮尺。いちばん近い相手の水平の距離で決める
    let nearest: number | null = null
    for (let i = 0; i < armament.contactCount; i++) {
      const c = armament.contacts[i]!
      const d = Math.hypot(c.x - sample.position.x, c.z - sample.position.z)
      if (nearest === null || d < nearest) nearest = d
    }
    radarRangeShown = radarRange(nearest)

    ctx!.save()
    ctx!.beginPath()
    ctx!.rect(x, y, size, size)
    ctx!.fillStyle = RADAR_FILL
    ctx!.fill()
    ctx!.clip()

    // 前の扇の内側の点の模様。模様は大きさが変わったときに 1 回だけ作る（`applySize`）
    if (radarDots !== null) {
      ctx!.beginPath()
      ctx!.moveTo(ox, oy)
      ctx!.lineTo(x, y)
      ctx!.lineTo(x + size, y)
      ctx!.closePath()
      ctx!.fillStyle = radarDots
      ctx!.fill()
    }

    // 十字と扇の線
    ctx!.strokeStyle = line
    ctx!.lineWidth = lineWidth * 0.75
    ctx!.beginPath()
    ctx!.moveTo(ox, y)
    ctx!.lineTo(ox, y + size)
    ctx!.moveTo(x, oy)
    ctx!.lineTo(x + size, oy)
    ctx!.moveTo(x, y)
    ctx!.lineTo(ox, oy)
    ctx!.lineTo(x + size, y)
    ctx!.stroke()
    // 距離の円
    ctx!.strokeStyle = lineDim
    for (const k of RADAR_RINGS) {
      ctx!.beginPath()
      ctx!.arc(ox, oy, ring * k, 0, Math.PI * 2)
      ctx!.stroke()
    }

    // 方位の文字。いちばん外の円の少し内側に、自機の向きに合わせて回して置く
    ctx!.font = smallFont
    ctx!.fillStyle = lineDim
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    for (const [label, bearing] of RADAR_LABELS) {
      const d = radarBearing(bearing, heading, radarScratch)
      ctx!.fillText(label, ox + d.x * ring * 0.86, oy + d.y * ring * 0.86)
    }

    // 空母。艦首の向きに合わせて回した細長い枠
    if (armament.carrier !== null) {
      const k = armament.carrier
      const p = radarPoint(k.x - sample.position.x, k.z - sample.position.z, heading, radarRangeShown, radarPointScratch)
      ctx!.save()
      ctx!.translate(ox + p.x * ring, oy + p.y * ring)
      ctx!.rotate(k.heading - heading)
      ctx!.strokeStyle = line
      ctx!.lineWidth = lineWidth * 0.75
      ctx!.strokeRect(-2.5 * u, -7 * u, 5 * u, 14 * u)
      ctx!.restore()
    }

    // 敵のミサイル。進む向きへ伸ばした赤い短い線
    const missileLength = 12 * s
    ctx!.strokeStyle = RADAR_TARGET
    ctx!.lineWidth = lineWidth
    for (let i = 0; i < armament.incoming.count; i++) {
      const m = armament.incoming.points[i]!
      const p = radarPoint(m.x - sample.position.x, m.z - sample.position.z, heading, radarRangeShown, radarPointScratch)
      if (p.clamped) continue
      const px = ox + p.x * ring
      const py = oy + p.y * ring
      const v = radarPoint(m.vx, m.vz, heading, 1, radarScratchPoint)
      const len = Math.hypot(v.x, v.y)
      if (len < 1e-6) continue
      ctx!.beginPath()
      ctx!.moveTo(px, py)
      ctx!.lineTo(px + (v.x / len) * missileLength, py + (v.y / len) * missileLength)
      ctx!.stroke()
    }

    // 相手。赤い丸に A。枠の外は縁に、その方向を指す「^」
    const r = 7 * s
    ctx!.font = `bold ${10 * s}px ${FONT_FAMILY}`
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    for (let i = 0; i < armament.contactCount; i++) {
      const c = armament.contacts[i]!
      const p = radarPoint(c.x - sample.position.x, c.z - sample.position.z, heading, radarRangeShown, radarPointScratch)
      const px = ox + p.x * ring
      const py = oy + p.y * ring
      ctx!.strokeStyle = RADAR_TARGET
      ctx!.fillStyle = RADAR_TARGET
      ctx!.lineWidth = lineWidth
      if (p.clamped) {
        // 自機から相手への向きに先端を向けた山形。縁から少し内側
        const len = Math.hypot(p.x, p.y)
        const dx = p.x / len
        const dy = p.y / len
        const tipX = px - dx * 2 * s
        const tipY = py - dy * 2 * s
        const w = 6 * s
        ctx!.beginPath()
        ctx!.moveTo(tipX - dx * w - dy * w, tipY - dy * w + dx * w)
        ctx!.lineTo(tipX, tipY)
        ctx!.lineTo(tipX - dx * w + dy * w, tipY - dy * w - dx * w)
        ctx!.stroke()
      } else {
        ctx!.beginPath()
        ctx!.arc(px, py, r, 0, Math.PI * 2)
        ctx!.stroke()
        ctx!.fillText('A', px, py + 0.5 * s)
      }
    }

    // 自機。上を向いた塗りの矢印
    const a = 7 * s
    ctx!.beginPath()
    ctx!.moveTo(ox, oy - a * 1.4)
    ctx!.lineTo(ox + a, oy + a)
    ctx!.lineTo(ox, oy + a * 0.45)
    ctx!.lineTo(ox - a, oy + a)
    ctx!.closePath()
    ctx!.fillStyle = line
    ctx!.fill()
    ctx!.restore()

    // 縁は切り抜きの外から描く（内側半分が切れないように）。録画の枠は中の線より明るい（段 D3）
    ctx!.strokeStyle = alertRed ? primary : RADAR_FRAME
    ctx!.lineWidth = lineWidth
    ctx!.strokeRect(x, y, size, size)
  }

  /**
   * 照準の上下の欄（段 B2、録画に合わせた）。
   *
   * 上の欄は MISSILE ALERT か CAUTION を、枠つきの文字で点滅させる（録画は 6 コマ点いて 6 コマ消える）。
   * 下の欄は CRASH・STALL を警告の色で、脚とフックを主線の色で、点滅させずに出す。録画の STALL も
   * 点滅しない。段 B1 までの警告の横一列（高さの 70%）・左下の脚とフック・左上の脅威の輪はここへ移した。
   * G LIMIT は出さない（ユーザーの決定、2026-10-16）
   *
   * @param frame 点滅の位相を決めるシムのフレーム。実時間は使わない
   */
  function drawStatus(threat: MissileThreat, frame: number): void {
    statusUpperText = upperStatusText(readout, threat.active)
    // 点滅は出始めのフレームから数える。出た瞬間が点いているように。CAUTION は出始めを
    // 持たないので、通し番号の位相で点滅させる
    const since = threat.active ? threat.since : 0
    const phase = (((frame - since) % BLINK_PERIOD_FRAMES) + BLINK_PERIOD_FRAMES) % BLINK_PERIOD_FRAMES
    statusBlinkOn = phase < BLINK_ON_FRAMES
    if (statusUpperText !== '' && statusBlinkOn) {
      statusBox(statusUpperText, layout.statusUpper.x, layout.statusUpper.y, alert)
    }

    const warning = readout.crashed ? 'CRASH' : readout.stalled ? 'STALL' : ''
    const gear = gearLabel(readout.gearPosition)
    const hook = hookLabel(readout.hookPosition)
    const rows: [string, string][] = []
    if (warning !== '') rows.push([warning, alert])
    // オートパイロット（段 B6）。録画は STALL と同じ欄に緑の枠つきで出す
    if (readout.autopilot) rows.push(['AUTO PILOT', primary])
    if (gear !== null) rows.push([gear, primary])
    if (hook !== null) rows.push([hook, primary])
    // 2 段まで。警告があれば、脚かフックの 1 つと並ぶ
    const { x, y } = layout.statusLower
    const shown = rows.slice(0, 2)
    for (let i = 0; i < shown.length; i++) {
      const [text, color] = shown[i]!
      statusBox(text, x, y + STATUS_LINE_REF * s * i, color)
    }
    statusLowerText = shown.map((r) => r[0]).join(' / ')
  }

  /** 枠つきの 1 行。中心に置く */
  function statusBox(text: string, cx: number, cy: number, color: string): void {
    ctx!.font = statusFont
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    const w = ctx!.measureText(text).width + STATUS_PAD_REF * 2 * s
    const h = STATUS_BOX_HEIGHT_REF * s
    ctx!.strokeStyle = color
    ctx!.lineWidth = lineWidth
    ctx!.strokeRect(cx - w / 2, cy - h / 2, w, h)
    ctx!.fillStyle = color
    shadedText(text, cx, cy)
  }

  /**
   * 文字を、暗い半透明の縁取りを付けて書く（段 D3、ユーザーの決定）。録画は線と文字の下の背景を約 7 割に
   * 暗くする。画面全体に影を重ねる形は中央値で 2〜3 fps 重かった（mission-01 が 60fps を割った）ので、
   * 文字だけに縁取りを 1 回引く。線の太さと色は書いたあと元へ戻す
   */
  function shadedText(text: string, x: number, y: number): void {
    const width = ctx!.lineWidth
    const stroke = ctx!.strokeStyle
    const join = ctx!.lineJoin
    ctx!.lineWidth = TEXT_SHADE_WIDTH_REF * s
    ctx!.strokeStyle = TEXT_SHADE
    ctx!.lineJoin = 'round'
    ctx!.strokeText(text, x, y)
    ctx!.lineWidth = width
    ctx!.strokeStyle = stroke
    ctx!.lineJoin = join
    ctx!.fillText(text, x, y)
  }

  applySize()

  return {
    readout,

    get flightPathOnScreen() {
      return onScreen
    },

    get gunReticleOnScreen() {
      return reticleOnScreen
    },

    get lockBoxOnScreen() {
      return lockOnScreen
    },

    get alertRed() {
      return alertRed
    },

    get statusUpper() {
      return statusUpperText
    },

    get statusBlinkOn() {
      return statusBlinkOn
    },

    get statusLower() {
      return statusLowerText
    },

    get banner() {
      return bannerText
    },

    get radarRange() {
      return radarRangeShown
    },

    get shootShown() {
      return shootShown
    },

    get targetBoxCount() {
      return targetBoxCount
    },

    get gunSnapped() {
      return gunSnappedShown
    },

    get arrowShown() {
      return arrowShown
    },

    get approachShown() {
      return approachShown
    },

    resize(w, h, ratio) {
      width = w
      height = h
      dpr = ratio
      applySize()
    },

    update(sample, armament, viewProjection, frame) {
      computeReadout(sample, readout)
      // **ミサイル警告のあいだは HUD 全体を赤にする**（段 B2、録画は 3 コマ以内に替わる）
      const red = armament.threat.active
      alertRed = red
      primary = alertRed ? RED : GREEN
      dim = alertRed ? RED_DIM : GREEN_DIM
      alert = alertRed ? ALERT_RED : ALERT

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'round'

      // ラダーは機首の方位を中心に置く。カメラではなく機体を基準にする
      const heading = headingOf(readout.nose.x, readout.nose.y, readout.nose.z)
      // **ピッチの梯子と方位の目盛り、縦の目盛りは追従視点では描かない**（段 36、参考画像に
      // 合わせた）。描画のコードは操縦席など別の視点のために残す（`instruments: 'full'`）
      if (instruments === 'full') drawLadder(viewProjection, heading)
      drawGunReticle(viewProjection, armament.gun)
      drawTargetBoxes(viewProjection, sample, armament)
      drawLockBox(viewProjection, armament.lock, armament)
      drawArrow(viewProjection, sample, armament)
      drawFlightPath(viewProjection)

      if (instruments === 'full') {
        drawVerticalTape(
          layout.speedTape,
          readout.speedKt,
          SPEED_MINOR,
          SPEED_MAJOR,
          SPEED_RANGE,
          'KT',
          false,
        )
        drawVerticalTape(
          layout.altitudeTape,
          readout.altitudeFt,
          ALTITUDE_MINOR,
          ALTITUDE_MAJOR,
          ALTITUDE_RANGE,
          'FT',
          true,
        )
        drawHeadingTape(readout.headingDeg)
      } else {
        drawValueBoxes()
      }
      drawArmament(armament)
      drawMission(armament.mission)
      drawRadar(sample, armament)
      drawStatus(armament.threat, frame)
      drawApproach(armament.approach)
      drawBanner(armament.hits, frame, armament.landingNotice)
    },

    dispose() {
      canvas.remove()
    },
  }
}
