import { InspectorBase } from 'three/webgpu'
import { CUBE_TARGET, UNNAMED_TARGET, parseTimestampUid, type PassSource } from './passTimes'

/**
 * パスの出どころを控える inspector（段 S0a）。
 *
 * three は render のたびに `inspector.beginRender(uid, scene, camera,
 * renderTarget)` を呼ぶ（`Renderer.js` の `_renderScene`）。ここで鍵と
 * 「何を描いたか」を結んでおくと、解決した timestamp の鍵から名札を引ける。
 * three の中に手を入れずに済む公式の口。
 *
 * **控えは古いフレームから捨てる。**鍵にフレーム番号が入るので、放って
 * おくと Map が際限なく伸びる。解決は遅れて届くので、直近 `KEEP_FRAMES`
 * フレームぶんだけ残す。
 *
 * **フレームは番号の差ではなく、控えたフレームの数で数える。**ライブでは
 * three の内部のループ（`Animation.js`、初期化で必ず始まる）も rAF ごとに
 * 番号を進めるので、描画 1 回で番号が 2 進む。最初の版は「番号の差が 16」で
 * 捨て、実際には描画 8 回ぶんしか残らず、解決の遅れた回の名札が消えた
 * （実機の enemy-eight で 1,014 フレーム中 18 フレーム、段 S0a の追補）。
 */

/**
 * 控えを残すフレーム数。`gpuTimer.ts` の `PASS_HISTORY` と同じ長さ
 * （60 fps で 4 秒）。解決の遅れはこれより短い見込み（長さは測っていない）
 */
export const KEEP_FRAMES = 240

interface Named {
  readonly name?: unknown
}

interface TargetLike {
  readonly texture?: (Named & { readonly isCubeTexture?: boolean }) | null
}

/** 描き先の名前。描き先が無ければ画面（空文字）。名前が無ければ種類で書く */
function targetName(renderTarget: TargetLike | null | undefined): string {
  if (renderTarget === null || renderTarget === undefined) return ''
  const name = nameOf(renderTarget.texture)
  if (name !== '') return name
  return renderTarget.texture?.isCubeTexture === true ? CUBE_TARGET : UNNAMED_TARGET
}

function nameOf(value: Named | null | undefined): string {
  const name = value?.name
  return typeof name === 'string' ? name : ''
}

export class PassInspector extends InspectorBase {
  private readonly sources = new Map<string, PassSource>()
  /** フレーム番号ごとの鍵。挿入の順に古い */
  private readonly framesUids = new Map<number, string[]>()
  /** 直近のフレームの出どころ。timestamp が取れない環境でも読める */
  private current: PassSource[] = []
  private recordingFrame = -1
  private lastComplete: readonly PassSource[] = []

  override beginRender(uid: string, scene: unknown, _camera: unknown, renderTarget: unknown): void {
    this.remember(uid, {
      scene: nameOf(scene as Named | null),
      target: targetName(renderTarget as TargetLike | null),
    })
  }

  override beginCompute(uid: string, computeNode: unknown): void {
    this.remember(uid, { scene: nameOf(computeNode as Named | null), target: '' })
  }

  /** 鍵の出どころ。控えていなければ undefined */
  sourceOf(uid: string): PassSource | undefined {
    return this.sources.get(uid)
  }

  /** 最後に描き終えたフレームの出どころを呼び出しの順に */
  get lastFrameSources(): readonly PassSource[] {
    return this.lastComplete
  }

  get size(): number {
    return this.sources.size
  }

  private remember(uid: string, source: PassSource): void {
    const parsed = parseTimestampUid(uid)
    if (parsed === null) return
    this.sources.set(uid, source)

    let uids = this.framesUids.get(parsed.frame)
    if (uids === undefined) {
      uids = []
      this.framesUids.set(parsed.frame, uids)
      this.prune()
    }
    uids.push(uid)

    if (parsed.frame !== this.recordingFrame) {
      if (this.recordingFrame >= 0) this.lastComplete = this.current
      this.current = []
      this.recordingFrame = parsed.frame
    }
    this.current.push(source)
  }

  /** 控えたフレームが上限を超えたら、最も古いフレームの鍵を捨てる */
  private prune(): void {
    while (this.framesUids.size > KEEP_FRAMES) {
      const [oldest, uids] = this.framesUids.entries().next().value!
      for (const uid of uids) this.sources.delete(uid)
      this.framesUids.delete(oldest)
    }
  }
}
