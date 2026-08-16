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
/** 画面 1 px あたりの回転量 rad */
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
      this.offset.yaw = clamp(
        this.offset.yaw - event.movementX * SENSITIVITY,
        -MAX_YAW,
        MAX_YAW,
      )
      this.offset.pitch = clamp(
        this.offset.pitch - event.movementY * SENSITIVITY,
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
