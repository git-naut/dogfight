import os from 'node:os'
import { defineConfig, devices } from '@playwright/test'
import {
  SWIFTSHADER_ARGS,
  WEBGPU_ARGS,
  VIEWPORT,
  DEFAULT_PROJECT,
} from './tests/e2e/launch.mjs'

// スクリーンショット回帰を環境差から守るため、GPU を使わず
// Chromium 内蔵のソフトウェアレンダラ SwiftShader に固定する。
// 遅い代わりに、どのマシンでも同じピクセルが出る。
export default defineConfig({
  testDir: './tests/e2e',
  /**
   * 画素の逆テストは既定で走らせない。
   *
   * 1 件ごとにキャプチャと比較が要るので所要が長い。段の終わりに手で回す。
   *
   *     MUTATE=1 npx playwright test pixel-mutate
   */
  testIgnore: process.env.MUTATE === '1' ? [] : ['**/pixel-mutate.spec.ts'],
  /**
   * 基準画像の置き場を spec ファイル名から切り離す。
   *
   * 既定は `{testFileName}-snapshots/` に解決するので、同じ 42 枚を読む
   * `pixel-mutate.spec.ts` が別のディレクトリを見てしまい、比較ではなく
   * **新規作成**になる。落ちるはずの逆テストが静かに通る。
   */
  snapshotPathTemplate: '{testDir}/smoke.spec.ts-snapshots/{arg}{-projectName}{-platform}{ext}',
  /**
   * 1 テストの制限。既定の 30 秒では足りない。
   *
   * 雲は時間方向に足し込むので、キャプチャ 1 枚あたり 8 回描く。CI の
   * ソフトウェアレンダラでは 1 回が数百ミリ秒かかるため、30 秒を越える。
   *
   * 並列にすると 1 本あたりは遅くなる。実測の最遅は 40.0 秒（8 コア 4 本、
   * 「時刻を変えると太陽高度が変わる」）。CI は直列の実測比で 1.27 倍
   * 遅いので 51 秒ぶん見ておく。180 秒なら 3.5 倍の余裕がある。
   * 固まったときの検出は e2e.yml の段の上限（25 分）が担う。
   */
  timeout: 180_000,
  /**
   * 同じファイルの中でも並列に走らせる。
   *
   * キャプチャモードはフレーム番号だけから絵を決め、SwiftShader は CPU だけで
   * ラスタライズするので、同時に何本走っていても画素は変わらない。実測でも
   * 基準画像 16 枚が 1 枚も動かずに通った。
   */
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  /**
   * コア数の半分。
   *
   * SwiftShader は CPU 律速で、Chromium 1 本がすでに複数スレッドで塗る。
   * 詰め込みすぎると取り合いになって遅くなる。実測（56 件）。
   *
   * | コア | ワーカー | 所要 |
   * | 8 | 1 | 11.4 分 |
   * | 8 | 4 | **3.8 分** |
   * | 8 | 8 | 4.7 分 |
   * | 4 | 2 | 6.1 分 |
   * | 4 | 3 | 5.8 分 |
   *
   * 8 コアで 8 本にすると 4 本より 24% 遅い。半分が実測の最適に近い。
   * GitHub の ubuntu-latest は 4 コアなので 2 本になる。
   */
  workers: Math.max(1, Math.floor(os.cpus().length / 2)),
  // CI では github アノテーションに加えて HTML レポートも出す。
  // これがないと e2e.yml の upload-artifact が空振りする。
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],

  expect: {
    toHaveScreenshot: {
      /**
       * 1 画素あたりの許容差。既定の 0.2 では緩すぎる。
       *
       * 実測。平らなグリッド地面を海と島嶼に差し替えた絵を、差し替え前の
       * 基準画像と比べたときの差分画素の割合。
       *
       * | threshold | 差分画素 |
       * | 0.2（既定） | 1.43% |
       * | 0.1 | 8.26% |
       * | 0.05 | 43.34% |
       *
       * 地面が海に変わるという大改変が、既定値だと 1.43% しか動かさず
       * maxDiffPixelRatio 0.02 を下回って通ってしまった。回帰検査として
       * 意味を成していなかったので締める。SwiftShader は決定論的なので
       * 同じビルドなら画素は一致する。
       *
       * 画素の割合も 0.02 では緩かった。Phase 4 で機体を板の寄せ集めから
       * F/A-18C へ差し替えたとき、10 枚のうち 4 枚が通ってしまった。機体は
       * 画面の 5% ほどしか占めないので、差分画素は 1.96% で 0.02 をわずかに
       * 下回る。0.005 まで締めると 4 倍の余裕で捕まる。
       *
       * **その 0.005 でも足りなかった。**Phase 8 段 6 で 42 枚それぞれが
       * 何を見張っているかを機械で測ったところ、宣言 56 件のうち 29 件が
       * 発火しなかった。0.005 は 1280x720 で 4,608 画素まで許すが、
       * カットのコメントに記録された実測はフレア 1,590 画素、曳光弾
       * 304 画素、爆発 52 画素、標的 124 画素。**全部その下にある。**
       *
       * | トグル | 見張れていた | 見張れていなかった |
       * |---|---|---|
       * | aircraft / terrain / water | 26 | 0 |
       * | trails / enemies / targets ほか VFX | 1 | 29 |
       *
       * 大面積のものだけが守られていた。**基準画像が 42 枚あることと、
       * 42 個の見張りがあることは別。**
       *
       * 0 にする。`tools/exact.mjs` が 42 枚すべてで差分 0 画素を実証して
       * いるので、SwiftShader は同じビルドなら画素を再現する。1 画素あたり
       * の許容（threshold 0.05）は残すので、階調 13 未満のにじみは数えない。
       */
      threshold: 0.05,
      maxDiffPixelRatio: 0,
      animations: 'disabled',
    },
  },

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    // 窓の大きさと起動引数は tests/e2e/launch.mjs が正本。
    // tools/exact.mjs も同じものを読む。写しを持つと画素が黙ってずれる
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
  },

  projects: [
    {
      name: DEFAULT_PROJECT,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: [...SWIFTSHADER_ARGS] },
      },
    },
    {
      // node 経路だけを WebGPU の起動引数で回す。
      //
      // **全件を 2 周させない。**基準画像 42 枚は `chromium-swiftshader` の
      // ものなので、こちらで撮ると別物になる。`testMatch` で 1 本に絞る。
      // 段 18 で撮り直すときにこの分け方を畳む
      name: 'chromium-webgpu',
      testMatch: /node-path\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: [...WEBGPU_ARGS] },
      },
    },
  ],

  webServer: {
    // --host 127.0.0.1 を明示する。既定では localhost にバインドし、CI では
    // それが ::1 に解決されるため 127.0.0.1 を叩く Playwright から届かない。
    command:
      'npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173/dogfight/',
    // 既存サーバを再利用しない。
    //
    // 再利用すると webServer の command が走らず、ビルドが飛ぶ。手動で起動した
    // preview が残っていると、古い dist に対してスクリーンショット回帰を
    // かけることになり、検証そのものが嘘になる。実際にそれで 30 分溶かした。
    // 毎回ビルドしても数秒しか変わらない。
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
