import type { AircraftSample } from '../sim/aircraft'
import { GRAVITY } from '../sim/isa'
import { Vec3 } from '../sim/vec3'
import { MUZZLE_OFFSET, bulletTimeToRange } from '../sim/weapons/gun'
import { AIRCRAFT_SIZE } from '../sim/weapons/hitbox'
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
  type HudReadout,
} from './readout'
import type { MissileThreat } from '../sim/weapons/warning'
import { RADAR_RANGE, RADAR_RINGS, radarBearing, radarPoint, radarRadius } from './radar'
import { offscreenDirection } from './arrow'
import {
  computeLayout,
  ARMAMENT_LINE_REF,
  FONT_REF,
  LABEL_FONT_REF,
  LINE_WIDTH_REF,
  MISSION_LINE_REF,
  SILHOUETTE_SIZE_REF,
  SMALL_FONT_REF,
  STATUS_BOX_HEIGHT_REF,
  STATUS_FONT_REF,
  STATUS_LINE_REF,
  STATUS_PAD_REF,
  VALUE_BOX_HEIGHT_REF,
  VALUE_BOX_POINT_REF,
  VALUE_BOX_WIDTH_REF,
  VALUE_LABEL_GAP_REF,
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
const GREEN = 'rgba(215, 255, 220, 0.8)'
/** 補助線。目盛りの細かいほう */
const GREEN_DIM = 'rgba(215, 255, 220, 0.45)'
/**
 * **ミサイル警告のあいだの HUD の色（段 B2）。**録画は警告のあいだ HUD 全体が赤みのあるピンクに替わる。
 *
 * 録画の線は暗い背景でも雲の上でも背景より明るくなる（スクリーンの重ね方の振る舞い）。最初は
 * それに合わせて `#hud` をスクリーンで重ねたが、明るい空の上ではほとんど読めなかった。ユーザーが
 * 4 つの候補を並べた図から「通常の重ね方・半透明 45%」を選んだ（2026-10-16）。明るい空では
 * 背景より暗い赤、暗い背景では明るい赤になる
 */
const RED = 'rgba(255, 95, 115, 0.45)'
const RED_DIM = 'rgba(255, 95, 115, 0.25)'
/** 警告のあいだの上下の欄の文字と枠（MISSILE ALERT・STALL・CRASH）。HUD の赤より濃い */
const ALERT_RED = 'rgba(255, 110, 125, 0.7)'
/**
 * 警告の無いときの上下の欄の警告の文字と枠（CAUTION・STALL・CRASH）。通常の重ね方。
 * 録画の CAUTION は空の上で 208,163,180。空（200,205,215）に重ねると 214,164,176 になる
 */
const ALERT = 'rgba(225, 130, 145, 0.55)'
/** 点滅の周期と、点いている長さ（フレーム）。録画は 6 コマ点いて 6 コマ消える（30fps、0.4 秒周期） */
const BLINK_PERIOD_FRAMES = 48
const BLINK_ON_FRAMES = 24
/** 警告 */
const WARN = 'rgba(255, 150, 90, 0.95)'

/** 書体。大きさは縮尺で決める（`applySize`） */
const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** 機銃の照準の円の半径と、左右のシェブロンの先端までの距離 画面画素（段 37） */
const RETICLE_RADIUS = 16
const RETICLE_CHEVRON = 26

/** 目標の箱の半辺 画面画素（段 35） */
const TARGET_BOX_HALF = 7
/**
 * 画面の外の相手を指す矢印を置く半径。画面の短い辺に対する割合（段 35）。
 *
 * 0.28 では真後ろを指す矢印が自機のノズルの間に重なり、炎とまぎれた（missile-warning）。
 * 0.4 で機体の下に出る。上向きは方位の目盛りの高さに来るが、段 36 で追従視点から消す
 */
const ARROW_RADIUS = 0.4
const arrowScratch = { x: 0, y: 0 }

/** レーダーの地と格子の色。地は HUD の線を読みやすくする程度に暗く */
const RADAR_FILL = 'rgba(8, 24, 16, 0.35)'
const RADAR_GRID = 'rgba(126, 255, 170, 0.18)'
/** レーダーの方位の文字 */
const RADAR_LABELS: readonly [string, number][] = [
  ['N', 0],
  ['E', Math.PI / 2],
  ['S', Math.PI],
  ['W', (Math.PI * 3) / 2],
]
const radarScratch = { x: 0, y: 0 }
const radarPointScratch = { x: 0, y: 0, clamped: false }

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

/** 低高度の警告を出す対地高度 ft。150 m 相当 */
const LOW_ALTITUDE_FT = 500

/**
 * ガンレティクルを合わせる基準の距離 m。
 *
 * 機銃の着弾点は距離で変わる（弾が落ちるので、遠いほど下に当たる）。距離が
 * 決まらないと 1 点に描けない。ロックオンを入れるまでは基準の距離で置き、
 * 数字を添えて「この距離での着弾点」だと分かるようにする。
 *
 * 300 m にしたのは、弾の飛行時間が 0.32 秒・落ちが 0.5 m で、実際に狙って
 * 当たる間合いだから。**この距離での機軸と着弾点の差は 0.5 m しかないので、
 * レティクルはほぼ機首の十字に重なる。**遠い距離を基準にすると離れる。
 */
const GUN_REFERENCE_RANGE = 300

/** ロックボックスの大きさの下限と上限 画面画素 */
const LOCK_BOX_MIN = 11
const LOCK_BOX_MAX = 90

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
  /** SHOOT を出しているか（段 35） */
  readonly shootShown: boolean
  /** 目標の箱を描いた数（段 35） */
  readonly targetBoxCount: number
  /** 画面の外の相手を指す矢印を出しているか（段 35） */
  readonly arrowShown: boolean
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
  /** いま使う主線と補助線の色。ミサイル警告のあいだは赤（段 B2） */
  let primary = GREEN
  let dim = GREEN_DIM
  let alertRed = false
  /** 上下の欄の警告の文字の色。警告のあいだは濃い赤 */
  let alert = ALERT
  let statusUpperText = ''
  let statusLowerText = ''
  let statusBlinkOn = false
  let reticleOnScreen = false
  let lockOnScreen = false
  let shootShown = false
  let targetBoxCount = 0
  let arrowShown = false

  // ロックボックスの計算に使う。使い回す
  const lockEdge = new Vec3()

  // ガンレティクルの計算に使う。使い回す
  const muzzleWorld = new Vec3()
  const impact = new Vec3()
  /** 基準の距離まで飛ぶ時間 秒。定数なので 1 度だけ解く */
  const gunFlightTime = bulletTimeToRange(GUN_REFERENCE_RANGE)
  /** 基準の距離での重力の落ち m */
  const gunDrop = 0.5 * GRAVITY * gunFlightTime * gunFlightTime

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
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
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

    const r = 9 * u
    ctx!.strokeStyle = primary
    ctx!.lineWidth = lineWidth
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx!.stroke()

    ctx!.beginPath()
    ctx!.moveTo(p.x - r - 10 * u, p.y)
    ctx!.lineTo(p.x - r, p.y)
    ctx!.moveTo(p.x + r, p.y)
    ctx!.lineTo(p.x + r + 10 * u, p.y)
    ctx!.moveTo(p.x, p.y - r)
    ctx!.lineTo(p.x, p.y - r - 7 * u)
    ctx!.stroke()
  }

  /** 機首の向き。射撃の基準になるので細く出す */
  function drawBoresight(m: Mat4): void {
    const nose = readout.nose
    const p = projectDirection(m, nose.x, nose.y, nose.z, width, height, b)
    if (!p.inFront) return
    ctx!.strokeStyle = dim
    ctx!.lineWidth = u
    ctx!.beginPath()
    ctx!.moveTo(p.x - 7 * u, p.y)
    ctx!.lineTo(p.x + 7 * u, p.y)
    ctx!.moveTo(p.x, p.y - 7 * u)
    ctx!.lineTo(p.x, p.y + 7 * u)
    ctx!.stroke()
  }

  /**
   * ガンレティクル。基準の距離での着弾点。
   *
   * 銃口から機軸へ距離ぶん進み、重力の落ちを引いた点を投影する。**方向ではなく
   * 点として投影する。**距離が決まっている点なので、無限遠として扱うと落ちが
   * 効かない。
   *
   * 弾が機体の速度を引き継ぐぶんは入れていない。機体と同じ速度で飛ぶ相手に
   * 対しては、機体座標で見た着弾点がこの式になる。
   */
  function drawGunReticle(m: Mat4, sample: AircraftSample): void {
    sample.orientation.rotate(MUZZLE_OFFSET, muzzleWorld)
    muzzleWorld.add(sample.position)
    impact.copy(muzzleWorld).addScaledVector(readout.nose, GUN_REFERENCE_RANGE)
    impact.y -= gunDrop

    const p = projectPoint(m, impact.x, impact.y, impact.z, width, height, a)
    reticleOnScreen = p.inFront && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height
    if (!p.inFront) return

    ctx!.strokeStyle = primary
    ctx!.lineWidth = lineWidth
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, RETICLE_RADIUS * u, 0, Math.PI * 2)
    // **目盛り（段 37、計画書の段 32）。**円の 12 方向（30 度ごと）に外へ短い線。上下左右の 4 本は長く
    for (let k = 0; k < 12; k++) {
      const angle = (k * Math.PI) / 6
      const length = (k % 3 === 0 ? 5 : 3) * u
      const c = Math.cos(angle)
      const sn = Math.sin(angle)
      ctx!.moveTo(p.x + c * RETICLE_RADIUS * u, p.y + sn * RETICLE_RADIUS * u)
      ctx!.lineTo(p.x + c * (RETICLE_RADIUS * u + length), p.y + sn * (RETICLE_RADIUS * u + length))
    }
    // **シェブロン（段 37）。**円の左に <、右に > を外向きに置く。照準の位置が目に入りやすい。
    // 先端が外側、腕は円の側へ戻す（最初に逆向きに描いて、内向きの > < になった）
    for (const side of [-1, 1]) {
      const tipX = p.x + side * RETICLE_CHEVRON * u
      ctx!.moveTo(tipX - side * 5 * u, p.y - 6 * u)
      ctx!.lineTo(tipX, p.y)
      ctx!.lineTo(tipX - side * 5 * u, p.y + 6 * u)
    }
    ctx!.stroke()

    // 中心の点。着弾点そのもの
    ctx!.fillStyle = primary
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, 1.6 * u, 0, Math.PI * 2)
    ctx!.fill()

    ctx!.font = smallFont
    ctx!.fillStyle = dim
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'middle'
    // 基準距離は右のシェブロンの外（段 37 で 21 から移した）
    ctx!.fillText(`${GUN_REFERENCE_RANGE}`, p.x + (RETICLE_CHEVRON + 8) * u, p.y)
  }

  /**
   * ロックボックス。
   *
   * 箱の大きさは目標の見かけの大きさに合わせる。翼幅の半分ぶん上へずらした
   * 点を一緒に投影して、画面上の距離を半径として使う。**画角を HUD へ渡さずに
   * 見かけの大きさが出せる。**画面の端では歪むが、ロックする相手はたいてい
   * 中央寄りにいる。
   *
   * 捕捉中は破線、ロックしたら実線の角括弧にする。段階が絵で分かるように、
   * 形そのものを変える（色だけだと分かりにくい）。
   */
  function drawLockBox(m: Mat4, lock: HudLock): void {
    lockOnScreen = false
    shootShown = false
    if (lock.state === 'none') return

    const center = projectPoint(m, lock.position.x, lock.position.y, lock.position.z, width, height, a)
    if (!center.inFront) return

    lockEdge.copy(lock.position)
    lockEdge.y += AIRCRAFT_SIZE.span * 0.5
    const edge = projectPoint(m, lockEdge.x, lockEdge.y, lockEdge.z, width, height, b)
    const measured = edge.inFront ? Math.hypot(edge.x - center.x, edge.y - center.y) : 0
    const half = Math.min(LOCK_BOX_MAX * u, Math.max(LOCK_BOX_MIN * u, measured))

    lockOnScreen =
      center.x >= 0 && center.x <= width && center.y >= 0 && center.y <= height

    const locked = lock.state === 'locked'
    ctx!.strokeStyle = primary
    ctx!.lineWidth = locked ? lineWidth * 1.4 : lineWidth

    if (locked) {
      // 四隅の角括弧。ロックしたことが形で分かる
      const arm = half * 0.45
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const cx = center.x + sx * half
          const cy = center.y + sy * half
          ctx!.beginPath()
          ctx!.moveTo(cx - sx * arm, cy)
          ctx!.lineTo(cx, cy)
          ctx!.lineTo(cx, cy - sy * arm)
          ctx!.stroke()
        }
      }
    } else {
      ctx!.setLineDash([5 * u, 4 * u])
      ctx!.strokeRect(center.x - half, center.y - half, half * 2, half * 2)
      ctx!.setLineDash([])
      // 捕捉の進みを上辺の帯で見せる
      ctx!.strokeStyle = dim
      ctx!.lineWidth = 2.5 * u
      ctx!.beginPath()
      ctx!.moveTo(center.x - half, center.y - half - 5 * u)
      ctx!.lineTo(center.x - half + half * 2 * lock.progress, center.y - half - 5 * u)
      ctx!.stroke()
    }

    // 距離と接近速度。1,000 m を境に単位を変える
    const rangeText =
      lock.range >= 1000 ? `${(lock.range / 1000).toFixed(1)}K` : `${Math.round(lock.range)}`
    ctx!.font = smallFont
    ctx!.fillStyle = primary
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'top'
    ctx!.fillText(rangeText, center.x + half + 6 * u, center.y - half)
    ctx!.fillStyle = dim
    ctx!.fillText(
      `${lock.closingSpeed >= 0 ? '+' : ''}${Math.round(lock.closingSpeed)}`,
      center.x + half + 6 * u,
      center.y - half + 13 * u,
    )

    // **SHOOT（段 35、段 37 で計画書に合わせた）。**ロックしていて、距離が `rMin`〜`rNe` の内の
    // とき。`rNe` は相手が反転して逃げても届く帯。段 35 では `rMax` までで出していたが、最大射程の
    // 端は相手が逃げると届かない（計画書の段 32）。箱の下に出す。画面の中央は自機の機体が占めるので、
    // 固定の位置には置かない
    shootShown = locked && lock.range >= lock.dlz.rMin && lock.range <= lock.dlz.rNe && lock.dlz.rNe > 0
    if (shootShown) {
      ctx!.font = font
      ctx!.fillStyle = primary
      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'top'
      ctx!.fillText('SHOOT', center.x, center.y + half + 6 * u)
    }
  }

  /**
   * 目標の箱（段 35、参考画像に合わせた）。画面に写っている相手すべてに小さな四角と機名。
   *
   * ロック中の相手は描かない（ロックボックスが描く）。遠い相手も箱の大きさは変えない。
   * 交戦距離の相手は肉眼では数画素にしか写らないので、見つけるための印として置く
   */
  function drawTargetBoxes(m: Mat4, armament: HudArmament): void {
    targetBoxCount = 0
    ctx!.lineWidth = lineWidth
    ctx!.font = smallFont
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'top'
    for (let i = 0; i < armament.contactCount; i++) {
      const c = armament.contacts[i]!
      if (c.locked) continue
      const p = projectPoint(m, c.x, c.y, c.z, width, height, a)
      if (!p.inFront || p.x < 0 || p.x > width || p.y < 0 || p.y > height) continue
      const color = c.kind === 'enemy' ? WARN : primary
      ctx!.strokeStyle = color
      const bh = TARGET_BOX_HALF * u
      ctx!.strokeRect(p.x - bh, p.y - bh, bh * 2, bh * 2)
      ctx!.fillStyle = color
      ctx!.fillText(c.designation, p.x, p.y + bh + 3 * u)
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
      ['GUN', `${armament.rounds}`, armament.rounds <= 0],
      ['MSL', `${armament.missiles}`, armament.missiles <= 0],
      ['FLR', `${armament.flares}`, armament.flares <= 0],
      ['DMG', `${Math.round(damage * 100)}%`, damaged],
    ]
    for (let i = 0; i < rows.length; i++) {
      const [name, value, warn] = rows[i]!
      const rowY = y + ARMAMENT_LINE_REF * s * i
      ctx!.fillStyle = warn ? WARN : primary
      ctx!.textAlign = 'left'
      ctx!.fillText(name, labelX, rowY)
      ctx!.textAlign = 'right'
      ctx!.fillText(value, valueX, rowY)
    }

    // 自機の輪郭。録画と同じく一覧の下に置く
    const size = SILHOUETTE_SIZE_REF * s
    const { cx, cy } = layout.silhouette
    ctx!.beginPath()
    for (let i = 0; i < SILHOUETTE.length; i += 2) {
      const px = cx + SILHOUETTE[i]! * size
      const py = cy + SILHOUETTE[i + 1]! * size
      if (i === 0) ctx!.moveTo(px, py)
      else ctx!.lineTo(px, py)
    }
    ctx!.closePath()
    // **損傷は全体で 1 つの色。**sim は部位ごとの損傷を持たない（耐久 1 本）。
    // 傷つくほど濃く塗る
    if (damaged) {
      ctx!.fillStyle = WARN
      ctx!.globalAlpha = 0.15 + 0.6 * damage
      ctx!.fill()
      ctx!.globalAlpha = 1
    }
    ctx!.strokeStyle = damaged ? WARN : primary
    ctx!.lineWidth = lineWidth
    ctx!.stroke()
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
    ctx!.fillText(`TIME ${formatTimer(mission.remainingFrames)}`, x, y)
    ctx!.fillStyle = primary
    ctx!.fillText(`SCORE ${formatScore(mission.score)}`, x, y + MISSION_LINE_REF * s)
    if (mission.kill !== null) {
      ctx!.fillText(`TARGET ${mission.kill.designation} +${mission.kill.points}`, x, y + MISSION_LINE_REF * s * 2)
    }

    // 残敵。0 になったら成功。**レーダー（段 34）が入っても残す。**レーダーは位置を見せるが、
    // 勝ち負けに直結する残りの数は見せない
    ctx!.font = smallFont
    ctx!.fillStyle = settled ? (failed ? WARN : primary) : dim
    ctx!.fillText(`ENEMY ${mission.enemiesAlive}`, x, y + MISSION_LINE_REF * s * 3)
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
    ctx!.fillText('SPEED', sx - w, sy - h / 2 - VALUE_LABEL_GAP_REF * s)
    ctx!.font = font
    ctx!.textBaseline = 'middle'
    ctx!.textAlign = 'right'
    ctx!.fillText(`${Math.round(readout.speedKt)}`, sx - point - pad, sy)

    const { innerX: ax, centerY: ay } = layout.altitudeBox
    valueBox(ax, ay, w, h, point, 1)
    ctx!.textBaseline = 'alphabetic'
    ctx!.font = labelFont
    ctx!.textAlign = 'right'
    ctx!.fillText('ALT', ax + w, ay - h / 2 - VALUE_LABEL_GAP_REF * s)
    ctx!.font = font
    ctx!.textBaseline = 'middle'
    ctx!.textAlign = 'right'
    ctx!.fillText(`${Math.round(readout.altitudeFt)}`, ax + w - pad, ay)
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
   * レーダー（段 34、参考画像の左下に合わせた）。機首が上、半幅 6 km。
   *
   * 正方形に格子と距離の輪（2・4 km）、方位の文字、中心に自機、敵は四角、標的機は菱形。
   * 範囲の外の相手は向きを保って縁に置く（`radarPoint`）。高度差は見ない
   */
  function drawRadar(sample: AircraftSample, armament: HudArmament): void {
    const { x, y, size } = layout.radar
    const half = size / 2
    const cx = x + half
    const cy = y + half
    const heading = headingOf(readout.nose.x, readout.nose.y, readout.nose.z)

    ctx!.save()
    ctx!.beginPath()
    ctx!.rect(x, y, size, size)
    ctx!.fillStyle = RADAR_FILL
    ctx!.fill()
    ctx!.clip()

    // 格子（4 等分）と距離の輪。輪の半径は平方根で縮めた距離（`radarRadius`）
    ctx!.strokeStyle = RADAR_GRID
    ctx!.lineWidth = u
    ctx!.beginPath()
    for (const k of [1, 2, 3]) {
      ctx!.moveTo(x + (size * k) / 4, y)
      ctx!.lineTo(x + (size * k) / 4, y + size)
      ctx!.moveTo(x, y + (size * k) / 4)
      ctx!.lineTo(x + size, y + (size * k) / 4)
    }
    ctx!.stroke()
    ctx!.strokeStyle = dim
    ctx!.lineWidth = u
    for (const ring of RADAR_RINGS) {
      ctx!.beginPath()
      ctx!.arc(cx, cy, half * radarRadius(ring), 0, Math.PI * 2)
      ctx!.stroke()
    }

    // 方位の文字。機首が上なので、自機の向きに合わせて回る
    ctx!.font = smallFont
    ctx!.fillStyle = dim
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    for (const [label, bearing] of RADAR_LABELS) {
      const d = radarBearing(bearing, heading, radarScratch)
      ctx!.fillText(label, cx + d.x * half * 0.86, cy + d.y * half * 0.86)
    }

    // 空母。艦首の向きに合わせて回した細長い枠
    if (armament.carrier !== null) {
      const k = armament.carrier
      const p = radarPoint(k.x - sample.position.x, k.z - sample.position.z, heading, RADAR_RANGE, radarPointScratch)
      const px = cx + p.x * (half - 4 * u)
      const py = cy + p.y * (half - 4 * u)
      const relative = k.heading - heading
      ctx!.save()
      ctx!.translate(px, py)
      ctx!.rotate(relative)
      ctx!.strokeStyle = primary
      ctx!.lineWidth = 1.5 * u
      ctx!.strokeRect(-2.5 * u, -7 * u, 5 * u, 14 * u)
      ctx!.restore()
    }

    // 相手
    for (let i = 0; i < armament.contactCount; i++) {
      const c = armament.contacts[i]!
      const p = radarPoint(c.x - sample.position.x, c.z - sample.position.z, heading, RADAR_RANGE, radarPointScratch)
      // 縁に寄せた相手は、正方形の内側に収まるよう少し引く
      const px = cx + p.x * (half - 4 * u)
      const py = cy + p.y * (half - 4 * u)
      ctx!.beginPath()
      if (c.kind === 'enemy') {
        ctx!.rect(px - 3 * u, py - 3 * u, 6 * u, 6 * u)
        ctx!.fillStyle = WARN
        ctx!.fill()
      } else {
        ctx!.moveTo(px, py - 4 * u)
        ctx!.lineTo(px + 4 * u, py)
        ctx!.lineTo(px, py + 4 * u)
        ctx!.lineTo(px - 4 * u, py)
        ctx!.closePath()
        ctx!.strokeStyle = primary
        ctx!.stroke()
      }
    }

    // 自機。上を向いた三角
    ctx!.beginPath()
    ctx!.moveTo(cx, cy - 6 * u)
    ctx!.lineTo(cx + 4 * u, cy + 4 * u)
    ctx!.lineTo(cx - 4 * u, cy + 4 * u)
    ctx!.closePath()
    ctx!.fillStyle = primary
    ctx!.fill()
    ctx!.restore()

    // 縁は切り抜きの外から描く（内側半分が切れないように）
    ctx!.strokeStyle = dim
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
    const lowAltitude = readout.aglFt < LOW_ALTITUDE_FT && !readout.crashed
    const caution = !readout.crashed && (lowAltitude || readout.gearOverspeed || readout.stalled)
    statusUpperText = threat.active ? 'MISSILE ALERT' : caution ? 'CAUTION' : ''
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
    ctx!.fillText(text, cx, cy)
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

    get shootShown() {
      return shootShown
    },

    get targetBoxCount() {
      return targetBoxCount
    },

    get arrowShown() {
      return arrowShown
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
      drawBoresight(viewProjection)
      drawGunReticle(viewProjection, sample)
      drawTargetBoxes(viewProjection, armament)
      drawLockBox(viewProjection, armament.lock)
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
    },

    dispose() {
      canvas.remove()
    },
  }
}
