import { test, expect } from '@playwright/test'
import { SCENES } from './scenes.mjs'
import { capture } from './harness'

/**
 * 画素の逆テスト。
 *
 * **基準画像が 42 枚あることと、42 個の見張りがあることは別。**
 * `toHaveScreenshot` は 1 画素あたり threshold 0.05 / 画面の 0.005 まで許す。
 * 実測 28x10 画素の標的機が丸ごと消えても落ちない（`smoke.spec.ts` に記録）。
 * 「通った」が「その要素を見張っている」を意味しない。
 *
 * そこで各カットが見張っていると主張する要素（`SceneSpec.watches`）を
 * 1 つずつ切り、**基準画像が落ちること**を確かめる。落ちなければ主張が嘘で、
 * そのカットはその要素を見張っていない。
 *
 * 比較器は自前で書かない。`playwright.config.ts` の threshold と
 * `maxDiffPixelRatio` をそのまま使い、`toHaveScreenshot` が投げることを
 * 期待する。**本番と違う閾値で数えると嘘の結論が出る。**
 *
 * 既定では走らせない。1 枚ごとにキャプチャと比較が要るので所要が長い。
 *
 *     MUTATE=1 npx playwright test pixel-mutate
 *
 * `playwright.config.ts` が `MUTATE` を見て、立っていないときは
 * このファイルを `testIgnore` で外す。
 */

/**
 * 落ちるまで待たない。
 *
 * キャプチャモードは同じフレームを描くので、比較を繰り返しても絵は変わら
 * ない。既定の再試行を待つと 1 件あたり数秒を無駄にする。
 */
const COMPARE_TIMEOUT = 3000

test.describe('基準画像の逆テスト', () => {
  for (const scene of SCENES) {
    for (const toggle of scene.watches ?? []) {
      test(`${scene.name} は ${toggle} を切ると落ちる`, async ({ page }) => {
        await capture(page, { ...scene, [toggle]: false })
        let failed = false
        try {
          await expect(page.locator('#viewport')).toHaveScreenshot(`${scene.name}.png`, {
            timeout: COMPARE_TIMEOUT,
          })
        } catch {
          failed = true
        }
        expect(
          failed,
          `${scene.name} は ${toggle} を切っても基準画像が通る。見張っていない`,
        ).toBe(true)
      })
    }
  }
})
