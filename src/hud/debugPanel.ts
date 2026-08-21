import type { AircraftSample } from '../sim/aircraft'
import { AIRCRAFT } from '../sim/flightModel'

/**
 * 飛行モデル調整用の計器。
 *
 * Phase 5 で作る HUD とは別物。速度も迎角も見えない状態で手触りを判断するのは
 * 無理があるので、数値を追える読み取り専用のオーバーレイを先に置く。
 * ?debug=1 のときだけ出す。
 */

const DEG = 180 / Math.PI

interface Row {
  label: string
  value: HTMLSpanElement
}

/** 飛行以外の描画側の状態。 */
export interface RenderInfo {
  /** 太陽高度 rad */
  sunElevation: number
  preset: string
  /** GPU フレーム時間 ms。0 なら計測できていない */
  gpuFrameMs: number
  /** 直近しばらくの最大。現在値だけでは重い視点を見落とす */
  gpuFrameMaxMs: number
  /** そのうち雲のパスが占める ms */
  gpuCloudMs: number
  gpuCloudMaxMs: number
  gpuTimerSupported: boolean
  /**
   * フレームの CPU 内訳 ms。
   *
   * GPU 時間が予算内なのに fps が出ないとき、どこで詰まっているかを
   * 切り分けるために要る。実際に GPU 10.8 ms で 46fps という状態が起きた
   */
  cpuSimMs: number
  cpuSyncMs: number
  cpuRenderMs: number
  /**
   * HUD の描画 ms。
   *
   * 2D canvas に 200 本ほど線を引くので、投入時間とは別に見る。GPU は
   * 使わないぶん、重ければ CPU 律速の側に効く
   */
  cpuHudMs: number
  /** 描いている地形パッチの枚数と三角形数。予算の確認に使う */
  terrainPatches: number
  terrainTriangles: number
  /** 機体の三角形数 */
  aircraftTriangles: number
  /** 実際に描いている画素数。DPR とレンダースケールの積で決まる */
  drawingBufferWidth: number
  drawingBufferHeight: number
  devicePixelRatio: number
}

export interface DebugPanel {
  update(
    sample: AircraftSample,
    frame: number,
    fps: number,
    render: RenderInfo,
  ): void
  dispose(): void
}

export function createDebugPanel(host: HTMLElement): DebugPanel {
  const root = document.createElement('div')
  root.className = 'debug-panel'

  const rows: Record<string, Row> = {}
  const order = [
    ['speed', '速度'],
    ['mach', 'マッハ'],
    ['altitude', '高度'],
    ['agl', '対地高度'],
    ['aoa', '迎角'],
    ['beta', '横滑り'],
    ['bank', 'バンク'],
    ['g', 'G'],
    ['throttle', 'スロットル'],
    ['sun', '太陽高度'],
    ['preset', '品質'],
    ['frame', 'フレーム'],
    ['fps', 'FPS'],
    ['gpu', 'GPU 時間'],
    ['gpuClouds', 'うち雲'],
    ['cpu', 'CPU 時間'],
    ['terrain', '地形'],
    ['aircraft', '機体'],
    ['resolution', '解像度'],
  ] as const

  for (const [key, label] of order) {
    const row = document.createElement('div')
    row.className = 'debug-row'

    const name = document.createElement('span')
    name.className = 'debug-label'
    name.textContent = label

    const value = document.createElement('span')
    value.className = 'debug-value'
    value.textContent = '-'

    row.append(name, value)
    root.append(row)
    rows[key] = { label, value }
  }

  const status = document.createElement('div')
  status.className = 'debug-status'
  root.append(status)

  const help = document.createElement('div')
  help.className = 'debug-help'
  help.textContent =
    'S/W ピッチ · A/D ロール · Q/E ヨー · Shift/Ctrl スロットル · 右ドラッグ 視点 · R リセット'
  root.append(help)

  host.append(root)

  const set = (key: string, text: string) => {
    const row = rows[key]
    if (row) row.value.textContent = text
  }

  return {
    update(sample, frame, fps, render) {
      set('speed', `${sample.speed.toFixed(0)} m/s (${(sample.speed * 1.94384).toFixed(0)} kt)`)
      // 音速は高度で変わるが、目安として海面の 340 m/s で割る
      set('mach', (sample.speed / 340).toFixed(2))
      set('altitude', `${sample.altitude.toFixed(0)} m (${(sample.altitude * 3.28084).toFixed(0)} ft)`)
      // 海抜と対地高度は山岳で大きく違う。低空飛行はこちらを見る
      set(
        'agl',
        `${sample.agl.toFixed(0)} m (地形 ${sample.groundHeight.toFixed(0)} m)`,
      )
      set('aoa', `${(sample.angleOfAttack * DEG).toFixed(1)}°`)
      set('beta', `${(sample.sideslip * DEG).toFixed(1)}°`)
      set('bank', `${(sample.bank * DEG).toFixed(0)}°`)
      set('g', sample.loadFactor.toFixed(2))
      set('throttle', `${(sample.throttle * 100).toFixed(0)}%`)
      set('sun', `${(render.sunElevation * DEG).toFixed(1)}°`)
      set('preset', render.preset)
      set('frame', String(frame))
      // fps は平滑化してあるので、生のフレーム時間も並べる
      set('fps', `${fps.toFixed(0)} (${(1000 / Math.max(fps, 1)).toFixed(1)} ms)`)
      // vsync で 60fps に張り付いていても、ここを見れば余裕が読める
      // 現在値と直近の最大を並べる。結果が揃ったときにしか更新されないので、
      // 重いフレームほど現在値は古い軽い値のまま残る。予算は最大側で見る
      set(
        'gpu',
        render.gpuTimerSupported
          ? `${render.gpuFrameMs.toFixed(1)} / 最大 ${render.gpuFrameMaxMs.toFixed(1)} ms (16.7)`
          : '計測不可',
      )
      set(
        'gpuClouds',
        render.gpuTimerSupported
          ? `${render.gpuCloudMs.toFixed(1)} / 最大 ${render.gpuCloudMaxMs.toFixed(1)} ms`
          : '計測不可',
      )

      // シム、描画の準備、描画コマンドの投入。合計がフレーム時間に近ければ
      // CPU 律速、GPU 時間に近ければ GPU 律速
      set(
        'cpu',
        `${(render.cpuSimMs + render.cpuSyncMs + render.cpuRenderMs + render.cpuHudMs).toFixed(1)} ms ` +
          `(シム ${render.cpuSimMs.toFixed(1)} / 準備 ${render.cpuSyncMs.toFixed(1)} / 投入 ${render.cpuRenderMs.toFixed(1)} / HUD ${render.cpuHudMs.toFixed(1)})`,
      )
      set(
        'terrain',
        `${render.terrainPatches} 枚 / ${(render.terrainTriangles / 1000).toFixed(0)}k 三角形`,
      )
      set(
        'aircraft',
        `${(render.aircraftTriangles / 1000).toFixed(1)}k 三角形`,
      )
      set(
        'resolution',
        `${render.drawingBufferWidth}x${render.drawingBufferHeight} (DPR ${render.devicePixelRatio.toFixed(2)})`,
      )

      const warnings: string[] = []
      if (sample.crashed) warnings.push('墜落')
      if (sample.stalled) warnings.push('失速')
      if (sample.loadFactor > AIRCRAFT.gLimit * 0.95) warnings.push('G 制限')
      if (sample.agl < 150 && !sample.crashed) warnings.push('低高度')

      status.textContent = warnings.join(' / ')
      status.classList.toggle('is-active', warnings.length > 0)
    },

    dispose() {
      root.remove()
    },
  }
}
