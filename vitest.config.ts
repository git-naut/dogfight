import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// sim 層はブラウザ API に依存しないので node 環境で走らせる。
// これによりテストが速く、決定論的になる。
export default defineConfig({
  resolve: {
    alias: {
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@hud': fileURLToPath(new URL('./src/hud', import.meta.url)),
      '@input': fileURLToPath(new URL('./src/input', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    reporters: ['default'],
  },
})
