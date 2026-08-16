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
  reporter: process.env.CI ? 'github' : 'list',

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
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
