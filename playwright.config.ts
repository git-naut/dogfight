import { defineConfig, devices } from '@playwright/test'

// スクリーンショット回帰を環境差から守るため、GPU を使わず
// Chromium 内蔵のソフトウェアレンダラ SwiftShader に固定する。
// 遅い代わりに、どのマシンでも同じピクセルが出る。
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // CI では github アノテーションに加えて HTML レポートも出す。
  // これがないと e2e.yml の upload-artifact が空振りする。
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  },

  projects: [
    {
      name: 'chromium-swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-gl=swiftshader',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-gpu',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
          ],
        },
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
