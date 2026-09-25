import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import config from '../../playwright.config'
import { DEFAULT_PROJECT, WEBGPU_ARGS, SWIFTSHADER_ARGS, launchArgsFor } from '../e2e/launch.mjs'
import { DEFAULT_BACKEND } from '@render/pipeline/types'

/**
 * 既定の描画経路と E2E の設定が噛み合っていることの検査。
 *
 * **同じ設定を 2 度失くしたので機械で見張る。**段 20b で `expect.timeout` を
 * 60 秒へ上げ、段 20c で既定を旧経路へ戻したときに一緒に消えた。既定を node
 * へ戻した 2026-09-14 に、基準画像 42 枚のうち 36 枚が `Timeout 5000ms` で
 * 落ちて気づいた。`--update-snapshots=all` でも落ちるので、**撮り直しが静かに
 * 6 枚しか進まない。**失敗の出方が「設定が無い」に見えないのが厄介だった。
 *
 * 切り替えは 4 か所にまたがる。`DEFAULT_BACKEND`、`DEFAULT_PROJECT`、
 * `projects[0]` の起動引数、`expect.timeout`。1 か所にまとめられないので、
 * 代わりに噛み合わせをここで宣言する。
 *
 * vitest で回るので `npm test` に乗る。Playwright を起動しないため速い。
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

type Project = {
  name?: string
  testMatch?: unknown
  testIgnore?: unknown
  metadata?: { nodePath?: unknown; webgpu?: unknown }
  use?: { launchOptions?: { args?: string[] } }
}

const projects = (config.projects ?? []) as Project[]
const byName = (name: string) => projects.find((p) => p.name === name)

/**
 * project に実際に効く `testIgnore`。
 *
 * **project の値は上位の値を上書きする。足し合わせではない。**主の project が
 * `node-fallback` を外すために自前の `testIgnore` を持った 2026-09-16 から、
 * 上位の「`MUTATE` が無ければ逆テストを外す」が効かなくなり、毎回の E2E で
 * 逆テスト 62 本（通しの CPU 時間の 17%）が走っていた
 */
function effectiveIgnore(p: Project): unknown[] {
  return [p.testIgnore ?? config.testIgnore ?? []].flat()
}

function ignores(p: Project, path: string): boolean {
  return effectiveIgnore(p).some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(path)
    // 文字列の glob は `**/名前` の形だけを使う。それ以外は読めないので落とす
    if (typeof pattern === 'string' && pattern.startsWith('**/')) {
      return path.endsWith(pattern.slice(3))
    }
    throw new Error(`読めない testIgnore: ${String(pattern)}`)
  })
}

describe('画素の逆テストは MUTATE のときだけ走る', () => {
  it('MUTATE が無ければどの project も逆テストを拾わない', () => {
    // vitest は MUTATE を立てずに回る。立てた状態の検査はここでは要らない
    expect(process.env.MUTATE).not.toBe('1')
    for (const p of projects) {
      expect(ignores(p, 'tests/e2e/pixel-mutate.spec.ts'), `${p.name} が逆テストを拾う`).toBe(true)
    }
  })

  it('主の project は退避路の検査も外したまま', () => {
    // 逆テストを外す形に直したときに、元の除外を落とさないこと
    expect(ignores(byName(DEFAULT_PROJECT)!, 'tests/e2e/node-fallback.spec.ts')).toBe(true)
  })

  it('node 経路の検査は 1 つの project でだけ回る', () => {
    // **既定が node なら主の project と `chromium-node` が同じ引数・同じ宣言。**
    // 両方で回すと 25 本を 2 回流す（2026-09-25 まで CPU の 7.1%）
    const runners = projects.filter((p) => {
      const match = p.testMatch
      const matched = match === undefined || (match instanceof RegExp && match.test('tests/e2e/node-path.spec.ts'))
      return matched && !ignores(p, 'tests/e2e/node-path.spec.ts')
    })
    expect(runners.map((p) => p.name)).toEqual(
      DEFAULT_BACKEND === 'node' ? ['chromium-node'] : [DEFAULT_PROJECT, 'chromium-node'],
    )
  })

  it('基準画像の検査は外していない', () => {
    for (const p of projects) {
      expect(ignores(p, 'tests/e2e/smoke.spec.ts'), `${p.name} が smoke を外している`).toBe(false)
    }
  })
})

describe('E2E の設定と既定の描画経路', () => {
  it('基準画像を撮る project が projects[0] と揃っている', () => {
    // 撮る側（`toHaveScreenshot`）と読む側（`tools/exact.mjs`）が同じ名前を
    // 使う。ずれると基準画像が別名で積まれ、比較が素通りする
    expect(projects[0]?.name).toBe(DEFAULT_PROJECT)
  })

  it('既定が node 経路なら主 project に WebGPU の起動引数が要る', () => {
    if (DEFAULT_BACKEND !== 'node') return

    const args = byName(DEFAULT_PROJECT)?.use?.launchOptions?.args ?? []
    // 引数が欠けると `requestAdapter()` が null を返し、node 経路は
    // `WebGPUUnavailable` を投げて GLSL へ落ちる。**落ちても絵は出るので
    // 検査は緑のまま**、基準画像だけが旧経路のものに入れ替わる
    for (const arg of WEBGPU_ARGS) {
      expect(args, `${arg} が無い`).toContain(arg)
    }
  })

  it('退避路の検査は WebGPU の引数を渡さない project で回る', () => {
    const fallback = byName('chromium-node-gl')
    expect(fallback, 'chromium-node-gl が無い').toBeDefined()

    const args = fallback?.use?.launchOptions?.args ?? []
    // WebGPU が立つと「無いときの退避」を作れず、検査が空振りする
    expect(args).not.toContain('--enable-unsafe-webgpu')
    expect(args).toEqual([...SWIFTSHADER_ARGS])
  })

  it('全 project が経路と WebGPU の有無を宣言する', () => {
    // **名前で判定すると、名前と経路の対応が変わったときに黙って逆を返す。**
    // `onNodePath()` は `name === 'chromium-node'`、`node-path.spec.ts` は
    // `name === 'chromium-webgpu'` で見ていて、既定を切り替えた日に両方が
    // 外れた。project 側が宣言して、テストはそれを読む
    for (const p of projects) {
      expect(typeof p.metadata?.nodePath, `${p.name} の nodePath`).toBe('boolean')
      expect(typeof p.metadata?.webgpu, `${p.name} の webgpu`).toBe('boolean')
      // 起動引数と宣言が食い違えば、テストは立っていない経路を見る
      expect(p.use?.launchOptions?.args?.includes('--enable-unsafe-webgpu') ?? false).toBe(
        p.metadata?.webgpu,
      )
      // WebGPU が無ければ node 経路は立たない（退避して GLSL になる）
      if (p.metadata?.webgpu === false) expect(p.metadata?.nodePath).toBe(false)
    }
  })

  it('DEFAULT_BACKEND を読むコードが src にある', () => {
    // **定数を書き換えただけで読む側が無かった。**`DEFAULT_BACKEND` を
    // `'node'` にしても `createScene` が見ていないので既定は GLSL のまま。
    // その状態で基準画像を撮り直し、退避路の検査も緑で通った。
    // **宣言だけが切り替わっている状態を、機械で見張るものが無かった。**
    const src = readFileSync(`${ROOT}src/render/scene.ts`, 'utf8')
    expect(src, 'createScene が DEFAULT_BACKEND を import していない').toContain(
      'DEFAULT_BACKEND',
    )
    // コメントで名前が出るだけでは足りない。式の中で読むこと
    expect(src).toMatch(/DEFAULT_BACKEND\s*===\s*'node'/)
  })

  it('起動引数を project から選ぶ関数が、知らない名前を黙って通さない', () => {
    // **`tools/exact.mjs` は `--project` を受け取りながら起動を
    // `SWIFTSHADER_ARGS` に固定していた。**`--project chromium-webgpu` で
    // 回すと、WebGPU で撮った基準画像を WebGPU の立たないブラウザの絵と
    // 比べる。退避路で GLSL に落ちるので**絵は出てしまい**、HUD の 13 枚が
    // 「2 回撮ると画素が動く」という嘘の結論になった
    expect(launchArgsFor('chromium-webgpu')).toContain('--enable-unsafe-webgpu')
    expect(launchArgsFor('chromium-node')).toContain('--enable-unsafe-webgpu')
    expect(launchArgsFor('chromium-swiftshader')).not.toContain('--enable-unsafe-webgpu')
    expect(launchArgsFor('chromium-node-gl')).not.toContain('--enable-unsafe-webgpu')

    // 既定へ倒すと、綴りを間違えた瞬間に別の設定で走る
    expect(() => launchArgsFor('chromium-webgpu2')).toThrow()
  })

  it('スクリーンショットの待ち時間が node 経路の 1 フレームに足りる', () => {
    // SwiftShader の WebGPU は 1 フレーム 800 ms 前後。既定の 5 秒では
    // 収束を待つあいだに切られる。実測で 42 枚中 36 枚が落ちた
    expect(config.expect?.timeout ?? 5_000).toBeGreaterThanOrEqual(30_000)
  })
})
