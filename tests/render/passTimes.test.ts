import { describe, expect, it } from 'vitest'
import {
  CUBE_TARGET,
  PASS_GROUPS,
  UNNAMED_TARGET,
  UNGROUPED,
  UNLABELED,
  formatPassTotals,
  parseTimestampUid,
  passGroup,
  passLabel,
  summarizeFrame,
  summarizeFrames,
  totalsByGroup,
  type PassSource,
} from '@render/pipeline/passTimes'
import { KEEP_FRAMES, PassInspector } from '@render/pipeline/passInspector'

/**
 * GPU のパスごとの所要（段 S0a）。
 *
 * three は鍵ごとの ms を残すが、鍵に何のパスかは入らない。名札と群の表が
 * 実物とずれると、予算の内訳が「不明」に溜まって読めなくなる。
 */

/**
 * 実物の出どころ。2026-10-28 に SwiftShader（WebGPU）で `level`・high の
 * キャプチャ 1 フレームを読んだ 28 本（`hook.gpuPassSources`）。low は雲影・
 * 機体の影・ブルーム・風圧が無い 13 本。**群の表を直したらここも実物で取り直す。**
 *
 * 段 S2b-2 で takram を外して取り直した。takram の星（`Stars`）が消え、自前の
 * 空の見え方（`Sky [ View ]`）と霞の 2 枚（`Sky [ Aerial ]`・`Sky [ Aerial T ]`）が
 * 加わった。影の場面の名前は光の名前（`SkySun`）になった
 */
const HIGH_SOURCES: readonly PassSource[] = [
  { scene: 'Clouds [ Shadow ]', target: UNNAMED_TARGET },
  { scene: 'Sky [ View ]', target: 'SkyView' },
  { scene: 'Sky [ Aerial ]', target: 'SkyAerial' },
  { scene: 'Sky [ Aerial T ]', target: 'SkyAerialT' },
  { scene: 'Render Pipeline', target: '' },
  { scene: '', target: 'SMAANode.edges' },
  { scene: 'compositeRtt [ RTT ]', target: UNNAMED_TARGET },
  { scene: 'Scene', target: 'output' },
  { scene: 'Shadow Map [ SkySun ]', target: 'ShadowMap' },
  { scene: 'Overlay', target: 'output' },
  { scene: 'Clouds [ March ]', target: UNNAMED_TARGET },
  { scene: 'Clouds [ Resolve ]', target: UNNAMED_TARGET },
  { scene: 'Clouds [ Copy ]', target: UNNAMED_TARGET },
  { scene: 'Bloom [ High Pass ]', target: 'UnrealBloomPass.bright' },
  { scene: 'Bloom [ Blur Horizontal - 0 ]', target: 'UnrealBloomPass.h0' },
  { scene: 'Bloom [ Blur Vertical - 0 ]', target: 'UnrealBloomPass.v0' },
  { scene: 'Bloom [ Blur Horizontal - 1 ]', target: 'UnrealBloomPass.h1' },
  { scene: 'Bloom [ Blur Vertical - 1 ]', target: 'UnrealBloomPass.v1' },
  { scene: 'Bloom [ Blur Horizontal - 2 ]', target: 'UnrealBloomPass.h2' },
  { scene: 'Bloom [ Blur Vertical - 2 ]', target: 'UnrealBloomPass.v2' },
  { scene: 'Bloom [ Blur Horizontal - 3 ]', target: 'UnrealBloomPass.h3' },
  { scene: 'Bloom [ Blur Vertical - 3 ]', target: 'UnrealBloomPass.v3' },
  { scene: 'Bloom [ Blur Horizontal - 4 ]', target: 'UnrealBloomPass.h4' },
  { scene: 'Bloom [ Blur Vertical - 4 ]', target: 'UnrealBloomPass.v4' },
  { scene: 'Bloom [ Composite ]', target: 'UnrealBloomPass.h0' },
  { scene: '', target: 'SMAANode.weights' },
  { scene: '', target: 'SMAANode.blend' },
  { scene: 'lensRtt [ RTT ]', target: UNNAMED_TARGET },
]

/** 実物の出どころの群の数え。high の 1 フレーム */
const HIGH_GROUP_COUNTS: Record<string, number> = {
  雲影: 1,
  出力: 1,
  SMAA: 3,
  合成: 1,
  場面: 1,
  空: 1,
  霞: 2,
  機体の影: 1,
  爆発: 1,
  雲: 3,
  ブルーム: 12,
  風圧: 1,
}

describe('three の鍵を読む', () => {
  it('render の鍵', () => {
    expect(parseTimestampUid('r:5:12:f300')).toEqual({ kind: 'r', call: 5, frame: 300 })
  })

  it('compute をまとめた鍵（文脈の id に区切りが入る）', () => {
    expect(parseTimestampUid('c:2:7,8,9:f41')).toEqual({ kind: 'c', call: 2, frame: 41 })
  })

  it('形の違う鍵は null', () => {
    expect(parseTimestampUid('r:5:12')).toBeNull()
    expect(parseTimestampUid('x:1:2:f3')).toBeNull()
    expect(parseTimestampUid('')).toBeNull()
  })
})

describe('名札と群', () => {
  it('名札は 場面 → 描き先。無名の場面と画面を書き分ける', () => {
    expect(passLabel({ scene: 'Scene', target: 'output' })).toBe('Scene → output')
    expect(passLabel({ scene: '', target: 'Stars' })).toBe('(無名) → Stars')
    expect(passLabel({ scene: 'Render Pipeline', target: '' })).toBe('Render Pipeline → 画面')
  })

  it('実物の 28 本がどれも群の表に載る', () => {
    const missing = HIGH_SOURCES.filter((s) => passGroup(s) === UNGROUPED)
    expect(missing, '群の表に無いパス').toEqual([])
  })

  it('実物の 28 本の群の数え', () => {
    const counts: Record<string, number> = {}
    for (const s of HIGH_SOURCES) {
      const g = passGroup(s)
      counts[g] = (counts[g] ?? 0) + 1
    }
    expect(counts).toEqual(HIGH_GROUP_COUNTS)
  })

  it('takram の環境反射と星のパスは群の表に無い（段 S2b-2 で消えた）', () => {
    // 環境反射は空の見え方の LUT を直に引くので、キューブと PMREM のパスが無い（ADR 0045）。
    // 戻ってきたら「不明」に出て気づける
    expect(passGroup({ scene: '', target: CUBE_TARGET })).toBe(UNGROUPED)
    expect(passGroup({ scene: '', target: 'PMREM.cubeUv' })).toBe(UNGROUPED)
    expect(passGroup({ scene: '', target: 'Stars' })).toBe(UNGROUPED)
  })

  it('機体の影は場面の名前ではなく描き先で拾う', () => {
    // **影は主の場面をそのまま描く**（`ShadowNode.js`）。場面の名前で先に
    // 拾うと、影の所要が「場面」に混ざる
    expect(passGroup({ scene: 'Scene', target: 'ShadowMap' })).toBe('機体の影')
  })

  it('雲影は雲より先に拾う', () => {
    expect(passGroup({ scene: 'Clouds [ Shadow ]', target: '' })).toBe('雲影')
    expect(passGroup({ scene: 'Clouds [ March ]', target: '' })).toBe('雲')
  })

  it('合成と風圧の焼き直しを見分ける', () => {
    expect(passGroup({ scene: 'compositeRtt [ RTT ]', target: '' })).toBe('合成')
    expect(passGroup({ scene: 'lensRtt [ RTT ]', target: '' })).toBe('風圧')
    // 自前の空の見え方の LUT（段 S2a）
    expect(passGroup({ scene: 'Sky [ View ]', target: 'SkyView' })).toBe('空')
    // 自前の霞の LUT（段 S2b-1）
    expect(passGroup({ scene: 'Sky [ Aerial ]', target: 'SkyAerial' })).toBe('霞')
    expect(passGroup({ scene: 'Sky [ Aerial T ]', target: 'SkyAerialT' })).toBe('霞')
    // 名前の無い焼き直しは、どちらにも入れない
    expect(passGroup({ scene: 'RTT', target: '' })).toBe(UNGROUPED)
  })

  it('表に無いものは不明', () => {
    expect(passGroup({ scene: 'Something', target: 'Else' })).toBe(UNGROUPED)
  })

  it('群の名前は行ごとに違う', () => {
    const names = PASS_GROUPS.map((r) => r.group)
    expect(new Set(names).size).toBe(names.length)
  })
})

/** 鍵 → ms の Map を挿入順で作る */
function stamps(entries: [string, number][]): Map<string, number> {
  return new Map(entries)
}

describe('最後のフレームの内訳', () => {
  const sources = new Map<string, PassSource>([
    ['r:1:3:f10', { scene: 'Clouds [ Shadow ]', target: '' }],
    ['r:2:4:f10', { scene: 'Scene', target: 'output' }],
    ['r:1:3:f11', { scene: 'Clouds [ Shadow ]', target: '' }],
    ['r:2:4:f11', { scene: 'Scene', target: 'output' }],
    ['r:3:5:f11', { scene: 'Render Pipeline', target: '' }],
  ])
  const sourceOf = (uid: string) => sources.get(uid)

  it('最後に現れたフレームだけを足す', () => {
    const result = summarizeFrame(
      stamps([
        ['r:1:3:f10', 0.5],
        ['r:2:4:f10', 4],
        ['r:1:3:f11', 0.25],
        ['r:2:4:f11', 3],
        ['r:3:5:f11', 1],
      ]),
      sourceOf,
    )
    expect(result).not.toBeNull()
    expect(result!.frame).toBe(11)
    expect(result!.totalMs).toBeCloseTo(4.25, 12)
    expect(result!.passes.map((p) => p.group)).toEqual(['雲影', '場面', '出力'])
    expect(result!.unlabeled).toBe(0)
  })

  it('フレームは番号の大小ではなく、three と同じく最後に現れたもの', () => {
    // three は Map を挿入順に回し、最後に現れたフレームの合計を返す
    // （`_resolveQueries`）。大小で選ぶと three の合計と別のフレームを比べる
    const result = summarizeFrame(
      stamps([
        ['r:1:3:f11', 0.25],
        ['r:1:3:f10', 0.5],
      ]),
      sourceOf,
    )
    expect(result!.frame).toBe(10)
    expect(result!.totalMs).toBe(0.5)
  })

  it('控えの無いパスも和に入れ、数える', () => {
    const result = summarizeFrame(
      stamps([
        ['r:2:4:f11', 3],
        ['r:9:9:f11', 2],
      ]),
      sourceOf,
    )
    expect(result!.totalMs).toBe(5)
    expect(result!.unlabeled).toBe(1)
    const lost = result!.passes.find((p) => p.uid === 'r:9:9:f11')!
    expect(lost.label).toBe(UNLABELED)
    expect(lost.group).toBe(UNGROUPED)
  })

  it('呼び出しの順に並べる。compute は render より前', () => {
    const result = summarizeFrame(
      stamps([
        ['r:3:5:f11', 1],
        ['r:1:3:f11', 0.25],
        ['c:1:7:f11', 0.1],
      ]),
      sourceOf,
    )
    expect(result!.passes.map((p) => p.uid)).toEqual(['c:1:7:f11', 'r:1:3:f11', 'r:3:5:f11'])
  })

  it('1 回の解決に入った全フレームを、現れた順に分けて返す', () => {
    // **解決は重ねられない。**待つ間に描いたフレームも次の解決に入る。
    // 最後だけを拾うと、約 1 秒おきの環境反射のような間欠の重さを取りこぼす
    const frames = summarizeFrames(
      stamps([
        ['r:1:3:f10', 0.5],
        ['r:2:4:f10', 4],
        ['r:1:3:f11', 0.25],
        ['r:2:4:f11', 3],
        ['r:3:5:f11', 1],
      ]),
      sourceOf,
    )
    expect(frames.map((f) => f.frame)).toEqual([10, 11])
    expect(frames[0]!.totalMs).toBeCloseTo(4.5, 12)
    expect(frames[0]!.passes.map((p) => p.group)).toEqual(['雲影', '場面'])
    expect(frames[1]!.totalMs).toBeCloseTo(4.25, 12)
    expect(frames[1]!.passes).toHaveLength(3)
  })

  it('形の読めない鍵は数えない。読める鍵が無ければ null', () => {
    expect(summarizeFrame(stamps([['junk', 9]]), sourceOf)).toBeNull()
    expect(summarizeFrame(stamps([]), sourceOf)).toBeNull()
    const result = summarizeFrame(
      stamps([
        ['r:2:4:f11', 3],
        ['junk', 9],
      ]),
      sourceOf,
    )
    expect(result!.totalMs).toBe(3)
  })
})

describe('群ごとの和と計器の行', () => {
  const passes = [
    { uid: 'a', label: '', group: '場面', ms: 3 },
    { uid: 'b', label: '', group: 'ブルーム', ms: 0.5 },
    { uid: 'c', label: '', group: '雲', ms: 1 },
    { uid: 'd', label: '', group: 'ブルーム', ms: 0.25 },
    { uid: 'e', label: '', group: UNGROUPED, ms: 0.125 },
  ]

  it('群ごとに足し、表の順に並べる。不明は最後', () => {
    expect(totalsByGroup(passes)).toEqual([
      { group: '雲', ms: 1 },
      { group: '場面', ms: 3 },
      { group: 'ブルーム', ms: 0.75 },
      { group: UNGROUPED, ms: 0.125 },
    ])
  })

  it('計器の行。食い違いと控えなしを頭と尻に書く', () => {
    const frame = { frame: 1, totalMs: 4.875, passes, unlabeled: 1 }
    expect(formatPassTotals(frame, 0)).toBe(
      '雲 1.00 / 場面 3.00 / ブルーム 0.75 / 不明 0.13 | 控えなし 1',
    )
    expect(formatPassTotals({ ...frame, unlabeled: 0 }, 2)).toBe(
      '食い違い 2 回 | 雲 1.00 / 場面 3.00 / ブルーム 0.75 / 不明 0.13',
    )
    expect(formatPassTotals(null, 0)).toBe('計測不可')
  })
})

describe('出どころの控え', () => {
  it('鍵と場面・描き先の名前を結ぶ', () => {
    const inspector = new PassInspector()
    inspector.beginRender('r:1:3:f1', { name: 'Scene' }, null, { texture: { name: 'output' } })
    inspector.beginRender('r:2:4:f1', { name: '' }, null, null)
    expect(inspector.sourceOf('r:1:3:f1')).toEqual({ scene: 'Scene', target: 'output' })
    expect(inspector.sourceOf('r:2:4:f1')).toEqual({ scene: '', target: '' })
    expect(inspector.sourceOf('r:9:9:f1')).toBeUndefined()
  })

  it('描き先なし（画面）・名前の無い描き先・キューブを書き分ける', () => {
    // **最初の版は 3 つとも空文字にした。**環境反射のキューブ 6 面が
    // 「画面へ描いている」と読めてしまった
    const inspector = new PassInspector()
    inspector.beginRender('r:1:1:f1', { name: 'A' }, null, null)
    inspector.beginRender('r:2:2:f1', { name: 'B' }, null, { texture: { name: '' } })
    inspector.beginRender('r:3:3:f1', { name: 'C' }, null, {
      texture: { name: '', isCubeTexture: true },
    })
    expect(inspector.sourceOf('r:1:1:f1')!.target).toBe('')
    expect(inspector.sourceOf('r:2:2:f1')!.target).toBe(UNNAMED_TARGET)
    expect(inspector.sourceOf('r:3:3:f1')!.target).toBe(CUBE_TARGET)
  })

  it('最後に描き終えたフレームの出どころを順に返す', () => {
    const inspector = new PassInspector()
    inspector.beginRender('r:1:3:f1', { name: 'A' }, null, null)
    inspector.beginRender('r:2:4:f1', { name: 'B' }, null, null)
    // フレーム 1 はまだ描き終えていない
    expect(inspector.lastFrameSources).toEqual([])
    inspector.beginRender('r:1:3:f2', { name: 'C' }, null, null)
    expect(inspector.lastFrameSources.map((s) => s.scene)).toEqual(['A', 'B'])
  })

  it('古いフレームの控えを捨てる。Map が伸び続けない', () => {
    const inspector = new PassInspector()
    for (let f = 1; f <= KEEP_FRAMES * 4; f++) {
      inspector.beginRender(`r:1:3:f${f}`, { name: 'A' }, null, null)
      inspector.beginRender(`r:2:4:f${f}`, { name: 'B' }, null, null)
    }
    // 直近 KEEP_FRAMES フレームぶん × 2 本
    expect(inspector.size).toBe(KEEP_FRAMES * 2)
    expect(inspector.sourceOf('r:1:3:f1')).toBeUndefined()
    expect(inspector.sourceOf(`r:1:3:f${KEEP_FRAMES * 3 + 1}`)).toBeDefined()
    expect(inspector.sourceOf(`r:1:3:f${KEEP_FRAMES * 3}`)).toBeUndefined()
  })

  it('番号が 2 ずつ進んでも、控えたフレームの数で KEEP_FRAMES ぶん残す', () => {
    // **ライブでは描画 1 回で番号が 2 進む**（three の内部のループも進める）。
    // 番号の差で捨てた最初の版は、実際には半分しか残らず名札が消えた
    const inspector = new PassInspector()
    for (let i = 1; i <= KEEP_FRAMES * 2; i++) {
      inspector.beginRender(`r:1:3:f${i * 2}`, { name: 'A' }, null, null)
    }
    expect(inspector.size).toBe(KEEP_FRAMES)
    // 最も古く残るのは、後ろから数えて KEEP_FRAMES 番目の描画
    expect(inspector.sourceOf(`r:1:3:f${(KEEP_FRAMES + 1) * 2}`)).toBeDefined()
    expect(inspector.sourceOf(`r:1:3:f${KEEP_FRAMES * 2}`)).toBeUndefined()
  })

  it('compute も控える', () => {
    const inspector = new PassInspector()
    inspector.beginCompute('c:1:7:f1', { name: 'FFT' })
    expect(inspector.sourceOf('c:1:7:f1')).toEqual({ scene: 'FFT', target: '' })
  })
})
