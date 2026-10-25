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
 * おくと Map が際限なく伸びる。解決は数フレーム遅れて届くので、直近
 * `KEEP_FRAMES` フレームぶんだけ残す。
 */

/** 控えを残すフレーム数。解決の遅れ（数フレーム）より十分長くとる */
export const KEEP_FRAMES = 16

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
  private newestFrame = 0
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

    if (parsed.frame !== this.recordingFrame) {
      if (this.recordingFrame >= 0) this.lastComplete = this.current
      this.current = []
      this.recordingFrame = parsed.frame
    }
    this.current.push(source)

    if (parsed.frame > this.newestFrame) {
      this.newestFrame = parsed.frame
      this.prune()
    }
  }

  private prune(): void {
    const oldest = this.newestFrame - KEEP_FRAMES
    for (const uid of this.sources.keys()) {
      const parsed = parseTimestampUid(uid)
      if (parsed === null || parsed.frame < oldest) this.sources.delete(uid)
    }
  }
}
