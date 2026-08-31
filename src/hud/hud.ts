import type { AircraftSample } from '../sim/aircraft'
import { AIRCRAFT } from '../sim/flightModel'
import { GRAVITY } from '../sim/isa'
import { Vec3 } from '../sim/vec3'
import { MAGAZINE, MUZZLE_OFFSET, bulletTimeToRange } from '../sim/weapons/gun'
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
  formatClock,
  type HudReadout,
} from './readout'
import type { MissileThreat } from '../sim/weapons/warning'

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

/** 主線。純色に近い HUD 緑 */
const PRIMARY = 'rgba(126, 255, 170, 0.92)'
/** 補助線。目盛りの細かいほう */
const DIM = 'rgba(126, 255, 170, 0.5)'
/** 警告 */
const WARN = 'rgba(255, 150, 90, 0.95)'

const LINE_WIDTH = 1.4
const FONT = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const SMALL_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

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
 * DLZ バーの高さ 画面画素。
 *
 * ロックボックスの右に縦に置く。目盛りは距離で、下が 0、上が `rMax`。
 * 現在の距離を横棒で示す。
 */
const DLZ_BAR_HEIGHT = 150
const DLZ_BAR_WIDTH = 7

/**
 * 武装の状態。
 *
 * `AircraftSample` には載せない。飛行の状態ではないし、DLZ と残ミサイルを
 * 足すときにここへ増やしていける。
 */
export interface HudArmament {
  /** 機銃の残弾 */
  rounds: number
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
  /** DLZ バーを出しているか */
  readonly dlzBarShown: boolean
  resize(width: number, height: number, devicePixelRatio: number): void
  /**
   * 1 枚描き直す。
   *
   * @param viewProjection カメラのビュー射影行列。列優先 16 要素
   */
  update(sample: AircraftSample, armament: HudArmament, viewProjection: Mat4): void
  dispose(): void
}

export function createHud(host: HTMLElement): Hud {
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
  let reticleOnScreen = false
  let lockOnScreen = false
  let dlzShown = false

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
    ctx!.strokeStyle = PRIMARY
    ctx!.fillStyle = PRIMARY
    ctx!.font = SMALL_FONT

    for (let pitch = -LADDER_LIMIT; pitch <= LADDER_LIMIT; pitch += LADDER_STEP) {
      const elevation = pitch * DEG
      if (pitch === 0) {
        ctx!.lineWidth = LINE_WIDTH * 1.3
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

      ctx!.lineWidth = LINE_WIDTH
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
    x: number,
    value: number,
    minor: number,
    major: number,
    range: number,
    label: string,
    alignRight: boolean,
  ): void {
    const halfHeight = height * 0.22
    const centerY = height * 0.5
    const perUnit = halfHeight / range
    const dirSign = alignRight ? -1 : 1

    ctx!.strokeStyle = DIM
    ctx!.lineWidth = 1
    ctx!.beginPath()
    ctx!.moveTo(x, centerY - halfHeight)
    ctx!.lineTo(x, centerY + halfHeight)
    ctx!.stroke()

    const first = Math.ceil((value - range) / minor) * minor
    ctx!.font = SMALL_FONT
    ctx!.textBaseline = 'middle'
    ctx!.textAlign = alignRight ? 'right' : 'left'

    for (let v = first; v <= value + range; v += minor) {
      const y = centerY - (v - value) * perUnit
      const isMajor = Math.abs(v % major) < minor * 0.5
      const len = isMajor ? 12 : 6
      ctx!.strokeStyle = isMajor ? PRIMARY : DIM
      ctx!.beginPath()
      ctx!.moveTo(x, y)
      ctx!.lineTo(x + dirSign * len, y)
      ctx!.stroke()
      if (isMajor) {
        ctx!.fillStyle = DIM
        ctx!.fillText(String(Math.round(v)), x + dirSign * (len + 4), y)
      }
    }

    // 現在値。目盛りの中央に箱で置く
    const text = String(Math.round(value))
    ctx!.font = FONT
    const boxWidth = 62
    const boxHeight = 22
    const boxX = alignRight ? x + 2 : x - boxWidth - 2
    ctx!.strokeStyle = PRIMARY
    ctx!.lineWidth = LINE_WIDTH
    ctx!.strokeRect(boxX, centerY - boxHeight / 2, boxWidth, boxHeight)
    ctx!.fillStyle = PRIMARY
    ctx!.textAlign = 'center'
    ctx!.fillText(text, boxX + boxWidth / 2, centerY)

    ctx!.font = SMALL_FONT
    ctx!.fillStyle = DIM
    ctx!.textAlign = 'center'
    ctx!.fillText(label, boxX + boxWidth / 2, centerY + boxHeight / 2 + 10)
  }

  function drawHeadingTape(headingDeg: number): void {
    const y = height * 0.11
    const halfWidth = width * 0.2
    const perDegree = halfWidth / HEADING_RANGE
    const centerX = width * 0.5

    ctx!.strokeStyle = DIM
    ctx!.lineWidth = 1
    ctx!.beginPath()
    ctx!.moveTo(centerX - halfWidth, y)
    ctx!.lineTo(centerX + halfWidth, y)
    ctx!.stroke()

    ctx!.font = SMALL_FONT
    ctx!.textBaseline = 'top'
    ctx!.textAlign = 'center'

    const first = Math.ceil((headingDeg - HEADING_RANGE) / HEADING_MINOR) * HEADING_MINOR
    for (let d = first; d <= headingDeg + HEADING_RANGE; d += HEADING_MINOR) {
      const x = centerX + (d - headingDeg) * perDegree
      const isMajor = ((d % HEADING_MAJOR) + HEADING_MAJOR) % HEADING_MAJOR < 1e-6
      ctx!.strokeStyle = isMajor ? PRIMARY : DIM
      ctx!.beginPath()
      ctx!.moveTo(x, y)
      ctx!.lineTo(x, y - (isMajor ? 10 : 5))
      ctx!.stroke()
      if (isMajor) {
        const shown = ((Math.round(d) % 360) + 360) % 360
        ctx!.fillStyle = DIM
        ctx!.fillText(String(shown).padStart(3, '0'), x, y + 4)
      }
    }

    // 現在の方位。目盛りの中央に置く
    ctx!.strokeStyle = PRIMARY
    ctx!.lineWidth = LINE_WIDTH
    ctx!.beginPath()
    ctx!.moveTo(centerX, y - 14)
    ctx!.lineTo(centerX - 6, y - 24)
    ctx!.lineTo(centerX + 6, y - 24)
    ctx!.closePath()
    ctx!.stroke()

    ctx!.font = FONT
    ctx!.fillStyle = PRIMARY
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

    const r = 9
    ctx!.strokeStyle = PRIMARY
    ctx!.lineWidth = LINE_WIDTH
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx!.stroke()

    ctx!.beginPath()
    ctx!.moveTo(p.x - r - 10, p.y)
    ctx!.lineTo(p.x - r, p.y)
    ctx!.moveTo(p.x + r, p.y)
    ctx!.lineTo(p.x + r + 10, p.y)
    ctx!.moveTo(p.x, p.y - r)
    ctx!.lineTo(p.x, p.y - r - 7)
    ctx!.stroke()
  }

  /** 機首の向き。射撃の基準になるので細く出す */
  function drawBoresight(m: Mat4): void {
    const nose = readout.nose
    const p = projectDirection(m, nose.x, nose.y, nose.z, width, height, b)
    if (!p.inFront) return
    ctx!.strokeStyle = DIM
    ctx!.lineWidth = 1
    ctx!.beginPath()
    ctx!.moveTo(p.x - 7, p.y)
    ctx!.lineTo(p.x + 7, p.y)
    ctx!.moveTo(p.x, p.y - 7)
    ctx!.lineTo(p.x, p.y + 7)
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

    ctx!.strokeStyle = PRIMARY
    ctx!.lineWidth = LINE_WIDTH
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, 16, 0, Math.PI * 2)
    ctx!.stroke()

    // 中心の点。着弾点そのもの
    ctx!.fillStyle = PRIMARY
    ctx!.beginPath()
    ctx!.arc(p.x, p.y, 1.6, 0, Math.PI * 2)
    ctx!.fill()

    ctx!.font = SMALL_FONT
    ctx!.fillStyle = DIM
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'middle'
    ctx!.fillText(`${GUN_REFERENCE_RANGE}`, p.x + 21, p.y)
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
    if (lock.state === 'none') return

    const center = projectPoint(m, lock.position.x, lock.position.y, lock.position.z, width, height, a)
    if (!center.inFront) return

    lockEdge.copy(lock.position)
    lockEdge.y += AIRCRAFT_SIZE.span * 0.5
    const edge = projectPoint(m, lockEdge.x, lockEdge.y, lockEdge.z, width, height, b)
    const measured = edge.inFront ? Math.hypot(edge.x - center.x, edge.y - center.y) : 0
    const half = Math.min(LOCK_BOX_MAX, Math.max(LOCK_BOX_MIN, measured))

    lockOnScreen =
      center.x >= 0 && center.x <= width && center.y >= 0 && center.y <= height

    const locked = lock.state === 'locked'
    ctx!.strokeStyle = PRIMARY
    ctx!.lineWidth = locked ? LINE_WIDTH * 1.4 : LINE_WIDTH

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
      ctx!.setLineDash([5, 4])
      ctx!.strokeRect(center.x - half, center.y - half, half * 2, half * 2)
      ctx!.setLineDash([])
      // 捕捉の進みを上辺の帯で見せる
      ctx!.strokeStyle = DIM
      ctx!.lineWidth = 2.5
      ctx!.beginPath()
      ctx!.moveTo(center.x - half, center.y - half - 5)
      ctx!.lineTo(center.x - half + half * 2 * lock.progress, center.y - half - 5)
      ctx!.stroke()
    }

    // 距離と接近速度。1,000 m を境に単位を変える
    const rangeText =
      lock.range >= 1000 ? `${(lock.range / 1000).toFixed(1)}K` : `${Math.round(lock.range)}`
    ctx!.font = SMALL_FONT
    ctx!.fillStyle = PRIMARY
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'top'
    ctx!.fillText(rangeText, center.x + half + 6, center.y - half)
    ctx!.fillStyle = DIM
    ctx!.fillText(
      `${lock.closingSpeed >= 0 ? '+' : ''}${Math.round(lock.closingSpeed)}`,
      center.x + half + 6,
      center.y - half + 13,
    )
  }

  /**
   * DLZ バー。いま撃ったら当たるかを縦の目盛りで示す。
   *
   * 下が 0、上が `rMax`。現在の距離を横棒で置くので、**棒が目盛りの中に
   * 入っていれば撃てる。**`rNe`（反転して逃げても届く）までを濃く塗り、
   * そこから `rMax` までを薄くする。`rMin` より下は近すぎて撃てない。
   *
   * 実機の DLZ 表示と同じ考え方。数字を読ませるのではなく、棒の位置で
   * 判断させる。
   */
  function drawDlzBar(lock: HudLock): void {
    dlzShown = false
    if (lock.state === 'none' || lock.dlz.rMax <= 0) return
    dlzShown = true

    const x = width * 0.66
    const bottom = height * 0.5 + DLZ_BAR_HEIGHT / 2
    const scale = DLZ_BAR_HEIGHT / lock.dlz.rMax
    const yOf = (range: number): number =>
      bottom - Math.min(DLZ_BAR_HEIGHT, Math.max(0, range * scale))

    // 枠
    ctx!.strokeStyle = DIM
    ctx!.lineWidth = 1
    ctx!.strokeRect(x, bottom - DLZ_BAR_HEIGHT, DLZ_BAR_WIDTH, DLZ_BAR_HEIGHT)

    // rMin から rNe まで。ここが確実に当たる帯
    const neTop = yOf(lock.dlz.rNe)
    const minTop = yOf(lock.dlz.rMin)
    ctx!.fillStyle = 'rgba(126, 255, 170, 0.34)'
    ctx!.fillRect(x + 1, neTop, DLZ_BAR_WIDTH - 2, minTop - neTop)

    // rNe から rMax まで。届くが逃げられる帯
    ctx!.fillStyle = 'rgba(126, 255, 170, 0.12)'
    ctx!.fillRect(x + 1, yOf(lock.dlz.rMax), DLZ_BAR_WIDTH - 2, neTop - yOf(lock.dlz.rMax))

    // 境目の線
    ctx!.strokeStyle = PRIMARY
    ctx!.lineWidth = 1
    for (const value of [lock.dlz.rNe, lock.dlz.rMin]) {
      const y = yOf(value)
      ctx!.beginPath()
      ctx!.moveTo(x, y)
      ctx!.lineTo(x + DLZ_BAR_WIDTH, y)
      ctx!.stroke()
    }

    // 現在の距離。目盛りの外にいるときは端に張り付く
    const inside = lock.range >= lock.dlz.rMin && lock.range <= lock.dlz.rMax
    const y = yOf(lock.range)
    ctx!.strokeStyle = inside ? PRIMARY : WARN
    ctx!.lineWidth = LINE_WIDTH * 1.4
    ctx!.beginPath()
    ctx!.moveTo(x - 5, y)
    ctx!.lineTo(x + DLZ_BAR_WIDTH + 5, y)
    ctx!.stroke()

    ctx!.font = SMALL_FONT
    ctx!.fillStyle = DIM
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'middle'
    ctx!.fillText('DLZ', x + DLZ_BAR_WIDTH + 8, bottom - DLZ_BAR_HEIGHT - 2)
    // 上端の距離。km で出す
    ctx!.fillText(
      `${(lock.dlz.rMax / 1000).toFixed(1)}K`,
      x + DLZ_BAR_WIDTH + 8,
      bottom - DLZ_BAR_HEIGHT + 11,
    )
  }

  /**
   * 残弾。機銃の帯として下部に置く。
   *
   * **数字は帯の下に置く。**当初は帯の上（`height * 0.9`）に置いていたが、
   * そこはピッチラダーの破線が通る高さで、`GUN 578` の 3 桁なら破線の隙間に
   * 収まっていた。`MAGAZINE` を 1,800 発へ増やして 4 桁になった瞬間、
   * 文字が左右へ 1 文字ぶん伸びて破線と角括弧に接触した（実測で差分
   * 52 x 8 画素）。**桁数が増えると壊れる置き方だった。**
   */
  function drawArmament(armament: HudArmament): void {
    ctx!.font = SMALL_FONT
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'alphabetic'
    ctx!.fillStyle = armament.rounds > 0 ? DIM : WARN
    const x = width * 0.5
    const y = height * 0.9

    // 残りを帯で見せる。数字より先に減りが目に入る
    const barWidth = 120
    const filled = (barWidth * Math.max(0, armament.rounds)) / MAGAZINE
    ctx!.strokeStyle = DIM
    ctx!.lineWidth = 1
    ctx!.strokeRect(x - barWidth / 2, y + 6, barWidth, 5)
    if (filled > 0) {
      ctx!.fillStyle = armament.rounds > 0 ? PRIMARY : WARN
      ctx!.fillRect(x - barWidth / 2, y + 6, filled, 5)
    }

    // 帯の下。ピッチラダーの破線を避ける
    ctx!.fillStyle = armament.rounds > 0 ? DIM : WARN
    ctx!.fillText(`GUN ${armament.rounds}`, x, y + 24)
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

    const x = width * 0.06
    const y = height * 0.08
    const settled = mission.outcome !== 'running'
    const failed = settled && mission.outcome !== 'cleared'

    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'alphabetic'

    // 残り時間。決着したらそこで止まる（`Mission.remainingFrames`）
    ctx!.font = FONT
    ctx!.fillStyle = failed ? WARN : PRIMARY
    ctx!.fillText(formatClock(mission.remainingFrames), x, y)

    // 残敵。0 になったら成功
    ctx!.font = SMALL_FONT
    ctx!.fillStyle = settled ? (failed ? WARN : PRIMARY) : DIM
    ctx!.fillText(`ENEMY ${mission.enemiesAlive}`, x, y + 16)
  }

  /**
   * ミサイル警告。
   *
   * **方位を矢印で出す。**文字だけでは、どちらへ逃げるか決められない。
   * 円の上に三角を置いて、方位ぶん回す。0 が正面（上）、+π/2 が右。
   *
   * 位置は画面中央の少し上。ロックボックスとガンレティクルは中央にあるが、
   * 撃たれているときに前を狙っていることは少ない。既存の警告列
   * （CRASH / STALL / DMG）は下 0.7 にあるので重ならない。
   *
   * **飛んでいなければ何も描かない。**平時の HUD の絵は 1 画素も変わらない。
   */
  function drawThreat(threat: MissileThreat): void {
    if (!threat.active) return

    // **置き場所は絵で決めた。**0.24 は仰角 20 度の刻みと重なり、0.58 は
    // 自機の機体と重なった。左寄せの 0.30 なら、ピッチラダーの刻み
    // （中央付近）とも機体（中央下）とも離れる
    const cx = width * 0.3
    const cy = height * 0.3
    const radius = 26

    ctx!.strokeStyle = WARN
    ctx!.fillStyle = WARN
    ctx!.lineWidth = 2

    // 方位の輪。矢印を置く土台
    ctx!.beginPath()
    ctx!.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx!.stroke()

    // 矢印。方位 0 が上（機首方向）。時計回りが正
    const angle = threat.bearing - Math.PI / 2
    const tipX = cx + Math.cos(angle) * (radius + 10)
    const tipY = cy + Math.sin(angle) * (radius + 10)
    const leftX = cx + Math.cos(angle + 0.4) * radius
    const leftY = cy + Math.sin(angle + 0.4) * radius
    const rightX = cx + Math.cos(angle - 0.4) * radius
    const rightY = cy + Math.sin(angle - 0.4) * radius
    ctx!.beginPath()
    ctx!.moveTo(tipX, tipY)
    ctx!.lineTo(leftX, leftY)
    ctx!.lineTo(rightX, rightY)
    ctx!.closePath()
    ctx!.fill()

    ctx!.font = FONT
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    // 数が 2 以上なら添える。1 発なら数字を出さない
    const label = threat.count > 1 ? `MISSILE x${threat.count}` : 'MISSILE'
    ctx!.fillText(label, cx, cy - radius - 22)
    // 着弾までの秒。近いほど切迫が伝わる
    ctx!.font = SMALL_FONT
    ctx!.fillText(`${threat.timeToImpact.toFixed(1)}s`, cx, cy)
  }

  function drawReadouts(): void {
    ctx!.font = SMALL_FONT
    ctx!.textAlign = 'left'
    ctx!.textBaseline = 'alphabetic'
    ctx!.fillStyle = DIM

    const x = width * 0.18
    const y = height * 0.78
    ctx!.fillText(`G ${readout.loadFactor.toFixed(1)}`, x, y)
    ctx!.fillText(`AOA ${readout.angleOfAttackDeg.toFixed(1)}`, x, y + 16)
    ctx!.fillText(`THR ${Math.round(readout.throttle * 100)}%`, x, y + 32)

    ctx!.textAlign = 'right'
    ctx!.fillText(`AGL ${Math.round(readout.aglFt)}`, width * 0.82, y)

    const warnings: string[] = []
    if (readout.crashed) warnings.push('CRASH')
    if (readout.stalled) warnings.push('STALL')
    if (readout.loadFactor > AIRCRAFT.gLimit * 0.95) warnings.push('G LIMIT')
    if (readout.aglFt < LOW_ALTITUDE_FT && !readout.crashed) warnings.push('LOW')
    // **傷ついたときだけ出す。**撃たれていることが分からないと、まっすぐ
    // 飛んでいて突然落ちる。実測で後方 1,500 m の敵は 27.3 秒で削り切る。
    // 無傷のときは何も足さないので、既存の HUD の絵は 1 画素も変わらない
    if (readout.integrityRatio < 1) {
      warnings.push(`DMG ${Math.round(readout.integrityRatio * 100)}%`)
    }
    if (warnings.length > 0) {
      ctx!.font = FONT
      ctx!.fillStyle = WARN
      ctx!.textAlign = 'center'
      ctx!.fillText(warnings.join('  '), width * 0.5, height * 0.7)
    }
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

    get dlzBarShown() {
      return dlzShown
    },

    resize(w, h, ratio) {
      width = w
      height = h
      dpr = ratio
      applySize()
    },

    update(sample, armament, viewProjection) {
      computeReadout(sample, readout)

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'round'

      // ラダーは機首の方位を中心に置く。カメラではなく機体を基準にする
      const heading = headingOf(readout.nose.x, readout.nose.y, readout.nose.z)
      drawLadder(viewProjection, heading)
      drawBoresight(viewProjection)
      drawGunReticle(viewProjection, sample)
      drawLockBox(viewProjection, armament.lock)
      drawDlzBar(armament.lock)
      drawFlightPath(viewProjection)

      drawVerticalTape(
        width * 0.18,
        readout.speedKt,
        SPEED_MINOR,
        SPEED_MAJOR,
        SPEED_RANGE,
        'KT',
        false,
      )
      drawVerticalTape(
        width * 0.82,
        readout.altitudeFt,
        ALTITUDE_MINOR,
        ALTITUDE_MAJOR,
        ALTITUDE_RANGE,
        'FT',
        true,
      )
      drawHeadingTape(readout.headingDeg)
      drawArmament(armament)
      drawMission(armament.mission)
      drawThreat(armament.threat)
      drawReadouts()
    },

    dispose() {
      canvas.remove()
    },
  }
}
