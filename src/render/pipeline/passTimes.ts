/**
 * GPU のパスごとの所要（段 S0a）。
 *
 * three は WebGPU のパスごとに timestamp を取り、解決のたびに
 * `WebGPUTimestampQueryPool.timestamps`（鍵 → ms の Map）へ残している。
 * ただし返すのはフレームの合計だけで、**鍵には何のパスかが入らない。**
 * 鍵は `r:<フレーム内の render の通し番号>:<描画文脈の id>:f<フレーム>`
 * （`Backend.js` の `updateTimeStampUID`）。何を描いたかは、描く直前に
 * `InspectorBase.beginRender(uid, scene, camera, renderTarget)` が受け取る場面と
 * 描き先から決める（`passInspector.ts`）。
 *
 * ここは three に依存しない純関数だけを置く。node で検査でき、歯型が効く。
 */

/** パスの出どころ。描く直前に控えた場面と描き先の名前 */
export interface PassSource {
  /** 描いた場面の名前。QuadMesh なら材質を包む網の名前、無名なら空文字 */
  readonly scene: string
  /**
   * 描き先のテクスチャの名前。画面へ直に描くとき（描き先なし）は空文字。
   * 描き先があって名前が無ければ `UNNAMED_TARGET`、キューブなら `CUBE_TARGET`
   */
  readonly target: string
}

/** 1 本のパスの所要 */
export interface PassTime {
  /** three の鍵。同じフレームの中で一意 */
  readonly uid: string
  /** 人が読む名札。`場面 → 描き先` */
  readonly label: string
  /** まとめた群の名前。表に無ければ `UNGROUPED` */
  readonly group: string
  readonly ms: number
}

/** 1 フレームぶんの内訳 */
export interface FramePassTimes {
  /** three の鍵のフレーム番号 */
  readonly frame: number
  /** パスの和。three の `resolveTimestampsAsync` が返す合計と同じ定義 */
  readonly totalMs: number
  /** 呼び出しの順に並ぶ */
  readonly passes: readonly PassTime[]
  /** 出どころを控えていなかったパスの数。0 でなければ名札の漏れ */
  readonly unlabeled: number
}

/** 群の表に無いパスの群の名前 */
export const UNGROUPED = '不明'

/** 出どころを控えていなかったパスの名札 */
export const UNLABELED = '(控えなし)'

/**
 * 名前の無い描き先。**画面（描き先なし）と分ける。**最初の版は両方を空文字に
 * して「画面」と書き、環境反射のキューブの 6 面が画面へ描いているように見えた
 */
export const UNNAMED_TARGET = '(無名)'

/** 名前の無いキューブの描き先。環境反射の 6 面（`CubeCamera`） */
export const CUBE_TARGET = '(キューブ)'

export interface ParsedUid {
  /** `r` は render、`c` は compute */
  readonly kind: 'r' | 'c'
  /** フレームの中の通し番号 */
  readonly call: number
  readonly frame: number
}

/**
 * three の鍵を読む。形が違えば null。
 *
 * **文脈の id は読まない。**compute をまとめて流すと `1,2,3` のように
 * 区切りが入るので、頭と尻だけを見る
 */
export function parseTimestampUid(uid: string): ParsedUid | null {
  const match = /^([rc]):(\d+):.+:f(\d+)$/.exec(uid)
  if (match === null) return null
  return {
    kind: match[1] as 'r' | 'c',
    call: Number(match[2]),
    frame: Number(match[3]),
  }
}

/** 人が読む名札。描き先が無ければ画面へ直に描いている */
export function passLabel(source: PassSource): string {
  const scene = source.scene === '' ? '(無名)' : source.scene
  const target = source.target === '' ? '画面' : source.target
  return `${scene} → ${target}`
}

/** 群の表の 1 行。先に当たった行の群に入る */
export interface PassGroupRule {
  readonly group: string
  readonly test: (source: PassSource) => boolean
}

/**
 * 群の表。**上から順に当てる。**
 *
 * 機体の影は主の場面をそのまま描く（`ShadowNode.js` の `renderer.render(scene,
 * shadow.camera)`）ので、場面の名前では場面のパスと見分けられない。描き先で
 * 先に拾う。行を足すときは `tests/render/passTimes.test.ts` の実物の名札の
 * 一覧も直す
 */
export const PASS_GROUPS: readonly PassGroupRule[] = [
  { group: '機体の影', test: (s) => s.target === 'ShadowMap' },
  { group: '雲影', test: (s) => s.scene === 'Clouds [ Shadow ]' },
  { group: '雲', test: (s) => s.scene.startsWith('Clouds [') },
  // 機体に映す空のキューブ 6 面と、粗さで畳む PMREM。ライブでは毎フレーム
  // 40 本走る（キャプチャでは出ない。2026-10-24 実測）
  { group: '環境反射', test: (s) => s.target === CUBE_TARGET || s.target === 'PMREM.cubeUv' },
  // takram の星空を焼くパス（`StarsNode`）。描き先にだけ名前がある
  { group: '星', test: (s) => s.target === 'Stars' },
  { group: '場面', test: (s) => s.scene === 'Scene' },
  { group: '爆発', test: (s) => s.scene === 'Overlay' },
  // 霞・雲・重ね描き・ブルームを合わせて焼くパス（`nodeOutput.ts` の `compositeRtt`）
  { group: '合成', test: (s) => s.scene === 'compositeRtt [ RTT ]' },
  { group: 'ブルーム', test: (s) => s.scene.startsWith('Bloom [') },
  { group: 'SMAA', test: (s) => s.target.startsWith('SMAANode.') },
  // 風圧の放射ブラーの入力を焼くパス（`nodeOutput.ts` の `lensRtt`）
  { group: '風圧', test: (s) => s.scene === 'lensRtt [ RTT ]' },
  // 最後の全画面。トーンマップと、風圧があれば放射ブラーと周辺減光
  { group: '出力', test: (s) => s.scene === 'Render Pipeline' },
]

/** 出どころから群を決める。表に無ければ `UNGROUPED` */
export function passGroup(source: PassSource, rules: readonly PassGroupRule[] = PASS_GROUPS): string {
  for (const rule of rules) {
    if (rule.test(source)) return rule.group
  }
  return UNGROUPED
}

/**
 * 解決した timestamp の Map から、フレームごとの内訳を作る。現れた順に並ぶ。
 *
 * **1 回の解決に数フレームぶんが入る。**解決は重ねられないので、待っている間に
 * 描いたフレームのパスも次の解決にまとめて入る（鍵のフレーム番号で分かれる）。
 * 最後のフレームだけを拾うと、約 1 秒おきに 40 本加わる環境反射のような間欠の
 * 重さを取りこぼす（段 S0a の実測）。
 *
 * 形の読めない鍵は数えない（three も同じ正規表現で読む）。
 */
export function summarizeFrames(
  timestamps: Iterable<readonly [string, number]>,
  sourceOf: (uid: string) => PassSource | undefined,
  rules: readonly PassGroupRule[] = PASS_GROUPS,
): FramePassTimes[] {
  const byFrame = new Map<number, PassTime[]>()
  for (const [uid, ms] of timestamps) {
    const parsed = parseTimestampUid(uid)
    if (parsed === null) continue
    const source = sourceOf(uid)
    let passes = byFrame.get(parsed.frame)
    if (passes === undefined) {
      passes = []
      byFrame.set(parsed.frame, passes)
    }
    passes.push({
      uid,
      label: source === undefined ? UNLABELED : passLabel(source),
      group: source === undefined ? UNGROUPED : passGroup(source, rules),
      ms,
    })
  }

  const frames: FramePassTimes[] = []
  for (const [frame, passes] of byFrame) {
    // 呼び出しの順に並べる。compute は render の前に置く
    passes.sort((a, b) => {
      const pa = parseTimestampUid(a.uid)!
      const pb = parseTimestampUid(b.uid)!
      if (pa.kind !== pb.kind) return pa.kind === 'c' ? -1 : 1
      return pa.call - pb.call
    })
    let totalMs = 0
    let unlabeled = 0
    for (const pass of passes) {
      totalMs += pass.ms
      if (pass.label === UNLABELED) unlabeled++
    }
    frames.push({ frame, totalMs, passes, unlabeled })
  }
  return frames
}

/**
 * 最後のフレームの内訳。読める鍵が無ければ null。
 *
 * **最後のフレームの選び方は three に合わせる。**three は Map を挿入順に回し、
 * 最後に現れたフレーム番号の合計を返す（`WebGPUTimestampQueryPool.js` の
 * `_resolveQueries`）。番号の大小で選ぶと、three の合計と別のフレームを
 * 比べてしまう
 */
export function summarizeFrame(
  timestamps: Iterable<readonly [string, number]>,
  sourceOf: (uid: string) => PassSource | undefined,
  rules: readonly PassGroupRule[] = PASS_GROUPS,
): FramePassTimes | null {
  return lastFrameOf(summarizeFrames(timestamps, sourceOf, rules))
}

/** 最後に現れたフレーム。空なら null */
export function lastFrameOf(frames: readonly FramePassTimes[]): FramePassTimes | null {
  return frames.length === 0 ? null : frames[frames.length - 1]!
}

/** 群ごとの和。表の順、表に無いものは最後 */
export function totalsByGroup(
  passes: readonly PassTime[],
  rules: readonly PassGroupRule[] = PASS_GROUPS,
): { group: string; ms: number }[] {
  const order = [...rules.map((r) => r.group), UNGROUPED]
  const sums = new Map<string, number>()
  for (const pass of passes) {
    sums.set(pass.group, (sums.get(pass.group) ?? 0) + pass.ms)
  }
  return order
    .filter((group, i) => order.indexOf(group) === i && sums.has(group))
    .map((group) => ({ group, ms: sums.get(group)! }))
}

/**
 * 計器の 1 行。群ごとの ms を表の順に並べる。
 *
 * 和と合計が食い違った回があれば頭に書く。そのときの内訳は信じない
 */
export function formatPassTotals(passes: FramePassTimes | null, mismatches: number): string {
  if (passes === null) return '計測不可'
  const body = totalsByGroup(passes.passes)
    .map(({ group, ms }) => `${group} ${ms.toFixed(2)}`)
    .join(' / ')
  const head = mismatches > 0 ? `食い違い ${mismatches} 回 | ` : ''
  const tail = passes.unlabeled > 0 ? ` | 控えなし ${passes.unlabeled}` : ''
  return `${head}${body}${tail}`
}
