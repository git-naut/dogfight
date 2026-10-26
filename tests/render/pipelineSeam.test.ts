import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * 帳簿がバックエンドを名指ししていないことを機械的に守る。
 *
 * 段 8 で `scene.ts` を帳簿だけにし、組み立てを `pipeline/webgl.ts` へ移した。
 * **継ぎ目は、越える者が現れた瞬間に意味を失う。**レンダラを 1 行借りるのは
 * その場では通るし、絵も 1 画素も動かないので基準画像も気づかない。
 * 段 15 で `pipeline/node.ts` を差したときに初めて落ちる形だった。
 *
 * 段 S1 で GLSL 経路を捨て、組み手は `pipeline/nodeScene.ts` だけになった。
 * 継ぎ目は残す。S2・S4 で大気と海の組み手を差し替えるとき、帳簿が中身を
 * 知っていると同じ形で落ちる。
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** コメントを落とした本文。禁止語をコメントで説明しているので外す */
function code(path: string): string {
  return readFileSync(`${ROOT}${path}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

/** 帳簿に出てはいけない語。どれも段 15 で名前か形が変わる */
const FORBIDDEN = [
  { pattern: /\bWebGLRenderer\b/, reason: 'レンダラの型' },
  { pattern: /\brenderer\b/, reason: 'レンダラの実体' },
  { pattern: /\bgetContext\s*\(/, reason: 'WebGL コンテキストの直取り' },
  { pattern: /\bcomposer\b|\bcreateComposer\b/, reason: 'ポストの組み立て' },
  { pattern: /\bCloudsPass\b|\bcloudsPass\b/, reason: '雲のパスの実体' },
  { pattern: /\bcreateGpuTimer\b/, reason: 'GPU タイマーの生成' },
  { pattern: /\bcreateAtmosphere\b/, reason: '大気の組み立て' },
  { pattern: /\bcreateEnvironmentProbe\b/, reason: '環境反射の組み立て' },
  { pattern: /\bcreateAircraftShadow\b/, reason: '影の組み立て' },
]

describe('描画パイプラインの継ぎ目', () => {
  const ledger = code('src/render/scene.ts')

  for (const { pattern, reason } of FORBIDDEN) {
    it(`帳簿が ${reason} に触れていない`, () => {
      const hit = ledger.match(pattern)
      expect(hit?.[0] ?? null, `scene.ts に ${reason} が出ている`).toBeNull()
    })
  }

  it('帳簿がバックエンド固有の実装を import していない', () => {
    const imports = [...ledger.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)
    // 組み手は動的 import（`./pipeline/nodeScene`）で読むので、ここには出ない。
    // `clouds/geometry` は import を 1 本も持たない純関数なので除く。
    // `cloudTime` は frame * fixedDt で、バックエンドとは関係がない
    const backend = imports.filter((name) =>
      /\/(composer|gpuTimer|environment|atmosphere|aircraftShadow|cloudsPass|noise)$/.test(
        name,
      ),
    )
    expect(backend, '帳簿がバックエンド固有の実装を import している').toEqual([])
  })

  it('契約が実装に依存していない', () => {
    const types = code('src/render/pipeline/types.ts')
    const imports = [...types.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)
    expect(imports.filter((name) => /\/(webgl|nodeScene|node)$/.test(name))).toEqual([])
  })

  it('検査そのものが働くことを、既知の違反で確かめる', () => {
    // 素通りするだけの検査にならないよう、越えれば見つかることを見る
    const violation = 'const gl = pipeline.renderer.getContext()'
    const caught = FORBIDDEN.filter(({ pattern }) => pattern.test(violation))
    expect(caught.map((f) => f.reason)).toEqual([
      'レンダラの実体',
      'WebGL コンテキストの直取り',
    ])
  })
})
