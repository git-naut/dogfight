import type { FramePassTimes, PassSource } from './pipeline/passTimes'

/**
 * 描画バックエンドの継ぎ目。
 *
 * **WebGPU へ移すと消えるか名前が変わるものだけを、ここに集める。**
 * 描画そのもの（`render` や `setRenderTarget`）はまだ `renderer` が持つ。
 * パイプラインの分離は段 8 で行う。
 *
 * ここに集めた面は次のとおり。左の列は段 S1 で捨てた GLSL 経路
 * （`WebGLRenderer`）での形で、経緯の記録として残す。
 *
 * | GLSL 経路 | node 経路 |
 * |---|---|
 * | `renderer.info.render.calls` | `renderer.info.render.drawCalls` |
 * | `renderer.info.programs.length` | `renderer.info.memory.programs` |
 * | `gl.drawingBufferWidth/Height` | `renderer.getDrawingBufferSize(v)` |
 * | `renderer.capabilities.isWebGL2` | `renderer.backend.isWebGPUBackend` |
 * | `gl.finish()` + `gl.readPixels()` | `await resolveTimestampsAsync()` |
 * | `renderer.getContext()` | **WebGPU では `undefined`** |
 *
 * `renderer` そのものを渡す逃げ口は段 20a-2 で消した。`WebGLRenderer` 型で
 * 固定されていて node 経路の `WebGPURenderer` を入れられず、継ぎ目の意味を
 * 失っていた。
 *
 * 計測の口は `createTimer()` に寄せた（段 18）。生のコンテキストを借りる
 * `webglContext()` は消えている。
 *
 * `renderer.getContext()` が空になるのが効く。`Backend.getContext()` は
 * three の WebGPU 側では空実装で、計測の排出も GPU タイマーもそこに
 * ぶら下がっている。
 */
/**
 * 段 S1 で GLSL 経路（`'webgl'`、`WebGLRenderer`）を捨てた。残るのは
 * `WebGPURenderer` の 2 つのバックエンドだけで、`node-webgl` は自己診断の
 * `?gpu=1` が使う
 */
export type BackendKind = 'node-webgl' | 'node-webgpu'

export interface DrawingBufferSize {
  width: number
  height: number
}

export interface RenderBackend {
  readonly kind: BackendKind
  readonly domElement: HTMLCanvasElement

  /** 直近のフレームで投入したドローコール */
  readonly drawCalls: number
  /** 直近のフレームで投入した三角形 */
  readonly triangles: number
  /** 作ったシェーダプログラムの数 */
  readonly programs: number

  /**
   * 生きているコンテキストから読んだ WebGL の版。WebGPU 経路では 0。
   *
   * **`kind` から導いてはいけない。**導くと `webglVersion` は
   * 「`kind` が `webgl` なら 2」というただの言い換えになり、
   * `smoke.spec.ts` の「WebGL2 が取れているか」が原理的に落ちなくなる。
   * ここは `gl.VERSION` の実物を読む
   */
  readonly webglVersion: number

  /**
   * フレーム頭で投入の集計を 0 に戻す。
   *
   * `renderer.info.autoReset = false` にしてあるので自分で呼ぶ。既定のまま
   * だと `render()` ごとに 0 に戻り、雲やポストを含めた総数が読めない。
   */
  resetInfo(): void

  /** 実際に描いている画素の大きさ。器を使い回す */
  drawingBufferSize(out?: DrawingBufferSize): DrawingBufferSize

  /**
   * 投入済みを排出して待つ。計測専用。
   *
   * **`gl.finish()` では足りない。**Chrome は描画コマンドを溜めるので、
   * 読み戻しで排出させないと投入時間しか測れない。実測で全解像度が
   * 1/4 解像度より速く出て気づいた。
   */
  drain(): void

  /**
   * 積んだ描画を GPU が終えるまで待つ。キャプチャの合図の前に呼ぶ。
   *
   * **WebGPU では `drain()` が何もしない**ので、`queue.onSubmittedWorkDone()` で
   * 待つ。待たずに合図を出すと、収束のぶんの描画が合図のあとに GPU で走り、
   * Playwright の撮影がその時間を丸ごと被る（CI で撮影の制限 60 秒を越えた。
   * 0634c54）。WebGL2 は `drain()` で足りる
   */
  settle(): Promise<void>

  /**
   * `drain()` が実際に排出できるか。
   *
   * **WebGPU バックエンドでは `getContext()` が `undefined`** なので
   * `gl.finish()` + `readPixels` の手が使えない。false のとき CPU 側の
   * 経過は投入までの時間しか測っていないので、掃引の判定がそれを見る
   */
  readonly cpuSynchronous: boolean

  /**
   * GPU の時間を測る道具を作る。
   *
   * **バックエンドごとに実体が違う。**WebGL2 は
   * `EXT_disjoint_timer_query_webgl2`、node 経路は
   * `renderer.resolveTimestampsAsync()`。呼ぶ側はどちらかを知らない。
   *
   * 段 18 でここへ寄せた。それまでは `webglContext()` で生のコンテキストを
   * 借りていて、**WebGPU 経路では null が返るという逃げ口**になっていた
   */
  createTimer(): GpuFrameTimer

  /**
   * 最後に描き終えたフレームのパスの出どころ（段 S0a）。呼び出しの順。
   *
   * **timestamp が取れなくても読める。**名札の漏れ（群の表に無いパス）を
   * SwiftShader の E2E で見るために要る
   */
  readonly passSources: readonly PassSource[]
}

/**
 * GPU の時間を測る。
 *
 * 1 枚の描画を `begin` と `end` で挟み、結果は数フレーム後に `collect` で
 * 回収する。**同じタスクの中では結果が揃わない**（`gl.finish()` を挟んでも
 * 揃わなかった）。札を付けて回収するのは、掃引が条件ごとに測るため。
 */
export interface GpuFrameTimer {
  readonly supported: boolean
  /** 回収待ちの数。0 でなければ次の計測を重ねない */
  readonly inflight: number
  /**
   * 捨てた計測の数。
   *
   * **測れなかった回を 0 として数に混ぜない。**代表値は最小値で取るので、
   * 0 が 1 つ混ざると「GPU 0 ms」がそのまま出る。捨てた回はここで数える
   */
  readonly dropped: number
  /** 1 枚の描画を挟む。`id` は回収の照合に使う */
  begin(id: number): void
  end(): void
  /** 揃った結果を回収する。**揃った分だけ返す** */
  collect(): readonly GpuFrameSample[]
  dispose(): void
}

/** 回収した 1 回ぶん */
export interface GpuFrameSample {
  readonly id: number
  readonly ms: number
  /**
   * パスごとの内訳（段 S0a）。node 経路で、内訳が読めた回だけ入る。
   * WebGL2 のクエリは入れ子にできず、フレーム全体しか測れない
   */
  readonly passes?: FramePassTimes
  /**
   * 同じ解決に入っていた全フレームの内訳（`passes` は最後の 1 つ）。
   * 解決を待つ間に描いたフレームもここに入るので、間欠の重さを取りこぼさない
   */
  readonly frames?: readonly FramePassTimes[]
}

/** 測れないときの実体。呼ぶ側で分岐を書かずに済む */
export const NO_GPU_TIMER: GpuFrameTimer = {
  supported: false,
  inflight: 0,
  dropped: 0,
  begin() {},
  end() {},
  collect() {
    return []
  },
  dispose() {},
}
