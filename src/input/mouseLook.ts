/**
 * マウスによる視点操作。
 *
 * 飛行そのものには使わない。右ボタンを押している間だけ、追従カメラの
 * オフセットを機体まわりに回して周囲を見る。離すと後方定位置へ戻る。
 *
 * 戦闘機ゲームで敵を目視で追うための機能で、Phase 6 の空戦で効いてくる。
 */

const MAX_YAW = Math.PI * 0.9
const MAX_PITCH = Math.PI * 0.45
/**
 * 画面 1 px あたりの回転量 rad。
 *
 * 1,280 px を端から端まで引くと 6.4 rad = 367 度で、1 回のドラッグでちょうど
 * 一周する。設定画面から倍率で増減できる（`setSensitivity`）
 */
const SENSITIVITY = 0.005
/** 手を離してから正面へ戻る時定数 s */
const RECENTER_TAU = 0.25

export interface LookOffset {
  yaw: number
  pitch: number
}

export class MouseLook {
  readonly offset: LookOffset = { yaw: 0, pitch: 0 }
  private looking = false
  /** 感度の倍率。1 が素の `SENSITIVITY` */
  private scale = 1

  /**
   * 感度を変える。設定画面から呼ぶ。
   *
   * **範囲は呼ぶ側が守る**（`settings.ts` の `MIN_SENSITIVITY` /
   * `MAX_SENSITIVITY`）。ここでは有限でない値だけ弾く。0 を許すと視点が
   * 動かなくなり、故障と見分けがつかない
   */
  setSensitivity(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return
    this.scale = scale
  }

  attach(canvas: HTMLCanvasElement): () => void {
    const onDown = (event: PointerEvent) => {
      if (event.button !== 2) return
      this.looking = true
      canvas.setPointerCapture(event.pointerId)
    }

    const onUp = (event: PointerEvent) => {
      if (event.button !== 2) return
      this.looking = false
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
    }

    const onMove = (event: PointerEvent) => {
      if (!this.looking) return
      const rate = SENSITIVITY * this.scale
      this.offset.yaw = clamp(this.offset.yaw - event.movementX * rate, -MAX_YAW, MAX_YAW)
      this.offset.pitch = clamp(
        this.offset.pitch - event.movementY * rate,
        -MAX_PITCH,
        MAX_PITCH,
      )
    }

    // 右ドラッグ中にコンテキストメニューが出ると視点操作が中断される
    const onContextMenu = (event: Event) => event.preventDefault()
    const onLeave = () => {
      this.looking = false
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('pointerleave', onLeave)

    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('pointerleave', onLeave)
    }
  }

  /** 手を離していれば正面へ戻していく。 */
  update(dt: number): LookOffset {
    if (!this.looking) {
      const k = 1 - Math.exp(-dt / RECENTER_TAU)
      this.offset.yaw -= this.offset.yaw * k
      this.offset.pitch -= this.offset.pitch * k
    }
    return this.offset
  }

  reset(): void {
    this.offset.yaw = 0
    this.offset.pitch = 0
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}
