import { expect, test, type Page } from '@playwright/test'
import { captureParams, type CaptureQuery } from './scenes.mjs'

/**
 * E2E の共有ハーネス。
 *
 * **spec ファイルに置かない。**`*.spec.ts` を import するとその中のテストが
 * 二重に登録される。`testMatch` に当たらない名前にして、両方の spec から
 * 読む。
 */

/**
 * `TestHook` は本家の型をそのまま使う。
 *
 * **写しを持っていた。**「本家に項目を足したらここも足す」と書いてあったが、
 * 実際に 5 項目ずれていたのを Phase 3.5 で揃えている。`requiltDiff` を足した
 * ときにも `src` 側だけに足して E2E から見えなかった。
 *
 * `import type` はコンパイル時に消えるので、E2E の実行時に `three` を
 * 引き込むことはない。
 */
import type { TestHook } from '../../src/render/capture'

export type { TestHook }

export const DEG = Math.PI / 180

export function readHook(page: Page): Promise<TestHook | undefined> {
  return page.evaluate(() => (window as unknown as { __dogfight?: TestHook }).__dogfight)
}

// `CaptureQuery` と URL の組み立ては `tests/e2e/scenes.mjs` が正本。
// `tools/exact.mjs` も同じものを読む。写しを持つと、片方だけが別の既定値を
// 使ったときに画素比較の道具が嘘の結論を出す（雲量の既定で実際にずれていた）。

/**
 * node 経路の project で回っているか。
 *
 * **`?gpu=3` を足すのはここ 1 か所だけ。**各テストが URL を組み立てる形に
 * すると、足し忘れた検査が GLSL 経路のまま通って「両経路で緑」の意味が
 * 消える（段 20a-3）
 *
 * **判定は project の `metadata.nodePath` が正本。**以前は project 名が
 * `chromium-node` かどうかで見ていたが、既定を node へ切り替えた
 * 2026-09-14 に追随しなくなった。主 project（`chromium-webgpu`）は node
 * 経路で走るのに false を返し、`?gpu=3` が付かず、`onNodePath()` を条件に
 * した `test.skip` が 3 か所すり抜けた。**経路の判定を名前から読むと、
 * 名前と経路の対応が変わったときに黙って逆を返す。**
 */
export function onNodePath(): boolean {
  return projectFlag('nodePath')
}

/**
 * この project の起動引数で WebGPU が立つか。
 *
 * **これも名前で判定していた。**`node-path.spec.ts` が
 * `project.name === 'chromium-webgpu'` で見ていて、同じ引数で走る
 * `chromium-node` を「WebGPU が無い」と読んだ。`?gpu=2` が
 * `node-webgpu` を返したのに `node-webgl` を期待して落ちた
 */
export function hasWebGPU(): boolean {
  return projectFlag('webgpu')
}

function projectFlag(key: 'nodePath' | 'webgpu'): boolean {
  const declared = test.info().project.metadata?.[key]
  if (typeof declared !== 'boolean') {
    throw new Error(
      `project '${test.info().project.name}' に metadata.${key} が無い。` +
        'playwright.config.ts の projects に足すこと',
    )
  }
  return declared
}

/**
 * シムのフレームが n 枚進むまで待つ。
 *
 * **壁時計で待たない。**`waitForTimeout(600)` は GLSL 経路の 1 フレーム
 * 50 ms を前提にした値で、node 経路は 800 ms 前後かかるので 1 枚も進まない
 * ことがある。**進まないと「何も起きていない」という主張が空振りで通る。**
 * 実測で `開いている間は撃てない` の前半（設定を開いている間は撃てない）が
 * その形になっていた（段 20a-3）。
 *
 * `hook.frame` は 120 Hz のシムのフレーム番号。60 枚で 0.5 秒ぶん
 */
/**
 * 値で待つときの上限。
 *
 * **node 経路はフレームの費用が 1.96 倍。**上限は GLSL 経路で決めた値なので、
 * そのままだと値に届く前に打ち切る。実測で `speed > 50` が 60 秒で 39.86 の
 * まま落ち、`missionOutcome === 'shotDown'` が 120 秒で届かなかった
 * （どちらも単独では通る。段 20a-3）。
 *
 * **値で待つ形は保つ。**壁時計で待つ形へ戻すと、遅い経路で「何も起きて
 * いない」の主張が空振りで通る（`advanceFrames` の注記）。伸ばすのは上限だけ。
 *
 * 3 倍は `test.slow()` と同じ倍率。固まりの検出は e2e.yml の段の上限が担う
 */
export function waitBudgetMs(base: number): number {
  return onNodePath() ? base * 3 : base
}

export async function advanceFrames(page: Page, frames: number): Promise<void> {
  const from = await page.evaluate(
    () => (window as unknown as { __dogfight?: { frame: number } }).__dogfight?.frame ?? 0,
  )
  await page.waitForFunction(
    ([start, n]) =>
      ((window as unknown as { __dogfight?: { frame: number } }).__dogfight?.frame ?? 0) >=
      start! + n!,
    [from, frames],
    // **上限も経路に合わせる。**`waitBudgetMs` を作ったのにここだけ固定値
    // だった。`1,200 フレーム飛んでも描画が止まらない` が node 経路で
    // 120 秒に届かず落ちた（2026-09-14）。**待ち方を値にしても、上限が
    // 速い経路の値のままなら同じところで切れる。**
    { timeout: waitBudgetMs(120_000) },
  )
}

export async function capture(page: Page, query: CaptureQuery = {}): Promise<TestHook> {
  const params = captureParams(query)
  // **GLSL を名指しされたら node を要求しない。**両方渡しても GLSL が勝つが、
  // URL に矛盾した名指しを並べない
  if (onNodePath() && query.webgl !== true) params.set('gpu', '3')

  await page.goto(`/dogfight/?${params.toString()}`)
  await page.waitForSelector('body[data-capture-ready="1"]')
  const hook = await readHook(page)
  expect(hook, 'テストフックが見つからない').toBeDefined()
  return hook as TestHook
}

/**
 * ライブループを開いて、最初のフレームが出るまで待つ。
 *
 * goto の直後に DOM を見てはいけない。大気の LUT の読み込みとシェーダの
 * コンパイルが終わるまで読み込み中の表示が出ているだけで、計器はまだ無い。
 * SwiftShader だと 5 秒では足りず、全件走らせたときだけ落ちた。
 */
export async function openLive(page: Page, query = ''): Promise<void> {
  // **タイトルは出さない。**`#title` は `inset: 0` で全面を覆うので、ライブの
  // 検査対象（HUD、リザルト、デバッグ計器）がその下に隠れる。`toBeVisible()`
  // は被覆を見ないので通ってしまい、検査が意味を失う。
  // タイトル自体は「タイトル画面」の describe で検査する
  // **シェーダの事前コンパイルも省く。**4 段ぶんは SwiftShader で 6.6 秒
  // かかり、並列に走らせると起動待ちが 120 秒を超えて落ちた（実測。E2E
  // 全体も 11.8 分から 17.2 分へ延びた）。事前コンパイル自体は専用の
  // describe が見ている
  const sep = query === '' ? '?' : '&'
  const path = onNodePath() ? '&gpu=3' : ''
  await page.goto(`/dogfight/${query}${sep}title=0&precompile=0${path}`)
  await page.waitForFunction(
    () => {
      const hook = (window as unknown as { __dogfight?: { frame: number } }).__dogfight
      return hook !== undefined && hook.frame > 0
    },
    undefined,
    { timeout: 120_000 },
  )
}
